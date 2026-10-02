import type { Request, Response } from "express";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import prisma from "../../config/prisma.js";
import logger from "../../config/logger.js";
import ApiError from "../../utils/ApiError.js";
import { isPrismaKnownError } from "../../types/domain.js";
import { detectDocKind } from "./extractors/index.js";
import { loadSuppliersCached, type PreScanInputFile } from "./preScanService.js";
import {
  listRepoCaseMeta,
  loadRepoCases,
  runEvalCase,
  type EvalCaseInput,
  type EvalCaseResult,
  type Json,
} from "./preScanEvalCore.js";

/**
 * Casos de prueba del pre-scan, visibles y administrables desde el portal.
 *
 *   GET    /api/supplier-intelligence/evals          — casos (repo + DB) + última corrida
 *   POST   /api/supplier-intelligence/evals          — crear caso desde la UI (admin, multipart)
 *   DELETE /api/supplier-intelligence/evals/:id      — eliminar caso de la DB (admin)
 *   POST   /api/supplier-intelligence/evals/run      — correr la verificación (admin)
 *
 * Determinístico y sin IA: correrlo no cuesta tokens. Los casos del repo son
 * la base curada (una por familia de formato); los de la DB los agrega el
 * equipo al aprobar un contrato cuyo formato aún no está cubierto.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "evals", "prescan");

const MAX_DB_CASES = 60;
const MAX_FILES_PER_CASE = 6;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CASE_BYTES = 24 * 1024 * 1024;
const MAX_EXPECTED_BYTES = 16 * 1024;

export interface PublicEvalCase {
  id: string | null;
  slug: string;
  title: string;
  source: "repo" | "db";
  supplierCodigo: string | null;
  layoutFamily: string | null;
  notes: string | null;
  files: { filename: string; kind: string; size: number }[];
  expected: Json;
  createdAt: string | null;
  lastResult: { ok: boolean; passed: number; failed: number; ranAt: string; error?: string } | null;
}

function slugify(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "caso";
}

function expectedSupplier(exp: Json): string | null {
  const s = exp.supplier as { codigo?: unknown } | undefined;
  return s && typeof s.codigo === "string" ? s.codigo : null;
}

async function lastRunIndex(): Promise<{ ranAt: string; bySlug: Map<string, EvalCaseResult> } | null> {
  const last = await prisma.evalRun.findFirst({ orderBy: { ranAt: "desc" } });
  if (!last) return null;
  const results = Array.isArray(last.results) ? (last.results as unknown as EvalCaseResult[]) : [];
  return { ranAt: last.ranAt.toISOString(), bySlug: new Map(results.map((r) => [r.slug, r])) };
}

function summarize(r: EvalCaseResult | undefined, ranAt: string): PublicEvalCase["lastResult"] {
  if (!r) return null;
  const failed = r.checks.filter((c) => !c.ok).length;
  return {
    ok: !r.error && failed === 0,
    passed: r.checks.length - failed,
    failed,
    ranAt,
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function listEvalCasesHandler(_req: Request, res: Response): Promise<void> {
  const [repo, db, last, runs] = await Promise.all([
    Promise.resolve(listRepoCaseMeta(REPO_ROOT)),
    prisma.evalCase.findMany({
      orderBy: { createdAt: "desc" },
      include: { files: { select: { filename: true, kind: true, size: true } } },
    }),
    lastRunIndex(),
    prisma.evalRun.findMany({
      orderBy: { ranAt: "desc" },
      take: 10,
      select: { id: true, ranAt: true, totalCases: true, totalChecks: true, failedChecks: true },
    }),
  ]);

  const cases: PublicEvalCase[] = [
    ...repo.map((c) => ({
      id: null,
      slug: c.slug,
      title: c.slug,
      source: "repo" as const,
      supplierCodigo: expectedSupplier(c.expected),
      layoutFamily: null,
      notes: null,
      files: c.files,
      expected: c.expected,
      createdAt: null,
      lastResult: last ? summarize(last.bySlug.get(c.slug), last.ranAt) : null,
    })),
    ...db.map((c) => ({
      id: c.id,
      slug: c.slug,
      title: c.title,
      source: "db" as const,
      supplierCodigo: c.supplierCodigo,
      layoutFamily: c.layoutFamily,
      notes: c.notes,
      files: c.files,
      expected: (c.expected ?? {}) as Json,
      createdAt: c.createdAt.toISOString(),
      lastResult: last ? summarize(last.bySlug.get(c.slug), last.ranAt) : null,
    })),
  ];

  res.json({
    cases,
    runs: runs.map((r) => ({ ...r, ranAt: r.ranAt.toISOString() })),
    limits: { maxDbCases: MAX_DB_CASES, maxFiles: MAX_FILES_PER_CASE, maxFileBytes: MAX_FILE_BYTES },
  });
}

function parseExpected(raw: unknown): Json {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string") throw ApiError.badRequest("`expected` debe ser JSON en texto.");
  if (raw.length > MAX_EXPECTED_BYTES) throw ApiError.badRequest("`expected` excede el tamaño permitido.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ApiError.badRequest("`expected` no es JSON válido.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw ApiError.badRequest("`expected` debe ser un objeto JSON.");
  }
  return parsed as Json;
}

function optText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

export async function createEvalCaseHandler(req: Request, res: Response): Promise<void> {
  const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
  if (files.length === 0) throw ApiError.badRequest("Adjunta al menos un documento.");
  if (files.length > MAX_FILES_PER_CASE) throw ApiError.badRequest(`Máximo ${MAX_FILES_PER_CASE} documentos por caso.`);
  let total = 0;
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) throw ApiError.badRequest(`«${f.originalname}» excede 8 MB. Los casos de prueba guardan los documentos en la base de datos; usa un extracto más liviano.`);
    total += f.size;
    if (!detectDocKind(f.mimetype, f.originalname)) throw ApiError.badRequest(`Tipo no soportado: ${f.originalname}`);
  }
  if (total > MAX_CASE_BYTES) throw ApiError.badRequest("El caso excede 24 MB en total.");

  const body = (req.body ?? {}) as Record<string, unknown>;
  const title = optText(body.title, 120);
  if (!title) throw ApiError.badRequest("`title` es requerido.");
  const expected = parseExpected(body.expected);
  const supplierCodigo = optText(body.supplier_codigo, 40) ?? expectedSupplier(expected);
  const layoutFamily = optText(body.layout_family, 80);
  const notes = optText(body.notes, 600);

  const count = await prisma.evalCase.count();
  if (count >= MAX_DB_CASES) {
    throw ApiError.badRequest(
      `Ya hay ${MAX_DB_CASES} casos guardados desde el portal. Los casos valen por diversidad de formato, no por cantidad: elimina uno redundante antes de agregar otro.`,
    );
  }

  const base = slugify(title);
  const repoSlugs = new Set(listRepoCaseMeta(REPO_ROOT).map((c) => c.slug));
  let slug = base;
  for (let i = 2; repoSlugs.has(slug) || (await prisma.evalCase.findUnique({ where: { slug }, select: { id: true } })); i++) {
    slug = `${base}-${i}`;
  }

  const created = await prisma.evalCase.create({
    data: {
      slug,
      title,
      supplierCodigo,
      layoutFamily,
      notes,
      expected: expected as object,
      createdBy: req.auth?.id ?? null,
      files: {
        create: files.map((f) => ({
          filename: f.originalname.slice(0, 200),
          kind: detectDocKind(f.mimetype, f.originalname)!,
          size: f.size,
          // Copia a un Uint8Array con ArrayBuffer propio (Prisma `Bytes`).
          data: Uint8Array.from(f.buffer),
        })),
      },
    },
    include: { files: { select: { filename: true, kind: true, size: true } } },
  });
  logger.info("Eval case created", { requestId: req.id, actorId: req.auth?.id, slug, files: files.length, bytes: total });
  res.status(201).json({
    case: {
      id: created.id,
      slug: created.slug,
      title: created.title,
      source: "db",
      supplierCodigo: created.supplierCodigo,
      layoutFamily: created.layoutFamily,
      notes: created.notes,
      files: created.files,
      expected,
      createdAt: created.createdAt.toISOString(),
      lastResult: null,
    } satisfies PublicEvalCase,
  });
}

export async function deleteEvalCaseHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
  try {
    await prisma.evalCase.delete({ where: { id: req.params.id } });
    logger.info("Eval case deleted", { requestId: req.id, actorId: req.auth?.id, caseId: req.params.id });
    res.status(204).end();
  } catch (err) {
    if (isPrismaKnownError(err) && err.code === "P2025") throw ApiError.notFound("Caso no encontrado");
    throw err;
  }
}

/** Corre TODOS los casos (repo + DB) en proceso y guarda la corrida. */
export async function runEvalsHandler(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const repo = loadRepoCases(REPO_ROOT);
  const dbCases = await prisma.evalCase.findMany({ include: { files: true }, orderBy: { createdAt: "asc" } });
  const suppliers = await loadSuppliersCached();
  const cases: EvalCaseInput[] = [
    ...repo,
    ...dbCases.map((c) => ({
      slug: c.slug,
      title: c.title,
      source: "db" as const,
      expected: (c.expected ?? {}) as Json,
      files: c.files.map(
        (f): PreScanInputFile => ({
          kind: f.kind as PreScanInputFile["kind"],
          buffer: Buffer.from(f.data),
          filename: f.filename,
        }),
      ),
    })),
  ];
  if (cases.length === 0) throw ApiError.badRequest("No hay casos de prueba.");

  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    const { result } = await runEvalCase(c, suppliers);
    results.push(result);
  }
  const totalChecks = results.reduce((n, r) => n + r.checks.length, 0);
  const failedChecks = results.reduce((n, r) => n + r.checks.filter((x) => !x.ok).length + (r.error ? 1 : 0), 0);

  const run = await prisma.evalRun.create({
    data: {
      ranBy: req.auth?.id ?? null,
      totalCases: cases.length,
      totalChecks,
      failedChecks,
      results: results as unknown as object,
    },
  });
  logger.info("Eval run", { requestId: req.id, actorId: req.auth?.id, cases: cases.length, totalChecks, failedChecks, ms: Date.now() - started });
  res.json({
    run: { id: run.id, ranAt: run.ranAt.toISOString(), totalCases: cases.length, totalChecks, failedChecks, ms: Date.now() - started },
    results,
  });
}
