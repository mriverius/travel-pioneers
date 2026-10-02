import type { Request, Response } from "express";
import prisma from "../config/prisma.js";
import logger from "../config/logger.js";
import ApiError from "../utils/ApiError.js";
import { isPrismaKnownError } from "../types/domain.js";
import {
  buildQualityReport,
  transitionKey,
  type RunFeedback,
} from "../agents/supplier-intelligence/feedback.js";

/**
 * Reglas permanentes del agente (memoria explícita de la agencia).
 *
 *   GET    /agent-rules        — todas (cualquier usuario autenticado)
 *   POST   /agent-rules        — crear (admin)
 *   PATCH  /agent-rules/:id    — editar texto / activar (admin)
 *   DELETE /agent-rules/:id    — eliminar (admin)
 */
export interface PublicAgentRule {
  id: string;
  text: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const MAX_RULE_LENGTH = 500;
const MAX_ENABLED_RULES = 40;

function toPublic(r: { id: string; text: string; enabled: boolean; createdAt: Date; updatedAt: Date }): PublicAgentRule {
  return { id: r.id, text: r.text, enabled: r.enabled, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

function cleanText(v: unknown): string {
  if (typeof v !== "string") throw ApiError.badRequest("El texto de la regla es obligatorio.");
  const t = v.replace(/\s+/g, " ").trim();
  if (t.length < 5) throw ApiError.badRequest("La regla es demasiado corta.");
  if (t.length > MAX_RULE_LENGTH) throw ApiError.badRequest(`La regla excede ${MAX_RULE_LENGTH} caracteres.`);
  return t;
}

/** Reglas activas, en orden de creación — lo que se inyecta en cada run. */
export async function loadEnabledRuleTexts(): Promise<string[]> {
  const rows = await prisma.agentRule.findMany({
    where: { enabled: true },
    orderBy: { createdAt: "asc" },
    take: MAX_ENABLED_RULES,
    select: { text: true },
  });
  return rows.map((r) => r.text);
}

export async function list(_req: Request, res: Response): Promise<void> {
  const rows = await prisma.agentRule.findMany({ orderBy: { createdAt: "asc" } });
  res.json({ rules: rows.map(toPublic) });
}

export async function create(req: Request<unknown, unknown, { text?: unknown }>, res: Response): Promise<void> {
  const text = cleanText(req.body.text);
  const created = await prisma.agentRule.create({ data: { text, createdBy: req.auth?.id ?? null } });
  logger.info("Agent rule created", { requestId: req.id, actorId: req.auth?.id, ruleId: created.id });
  res.status(201).json({ rule: toPublic(created) });
}

export async function update(
  req: Request<{ id: string }, unknown, { text?: unknown; enabled?: unknown }>,
  res: Response,
): Promise<void> {
  const data: { text?: string; enabled?: boolean } = {};
  if (req.body.text !== undefined) data.text = cleanText(req.body.text);
  if (req.body.enabled !== undefined) {
    if (typeof req.body.enabled !== "boolean") throw ApiError.badRequest("`enabled` debe ser booleano.");
    data.enabled = req.body.enabled;
  }
  if (Object.keys(data).length === 0) throw ApiError.badRequest("Nada que actualizar.");
  try {
    const updated = await prisma.agentRule.update({ where: { id: req.params.id }, data });
    logger.info("Agent rule updated", { requestId: req.id, actorId: req.auth?.id, ruleId: updated.id, fields: Object.keys(data) });
    res.json({ rule: toPublic(updated) });
  } catch (err) {
    if (isPrismaKnownError(err) && err.code === "P2025") throw ApiError.notFound("Regla no encontrada");
    throw err;
  }
}

export async function remove(req: Request<{ id: string }>, res: Response): Promise<void> {
  try {
    await prisma.agentRule.delete({ where: { id: req.params.id } });
    logger.info("Agent rule deleted", { requestId: req.id, actorId: req.auth?.id, ruleId: req.params.id });
    res.status(204).end();
  } catch (err) {
    if (isPrismaKnownError(err) && err.code === "P2025") throw ApiError.notFound("Regla no encontrada");
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                         Sugerencias de reglas                              */
/* -------------------------------------------------------------------------- */

/**
 * Una sugerencia nace cuando la MISMA corrección (campo + antes → después)
 * aparece en ≥ MIN_RUNS runs de proveedores distintos. Con 300 contratos al
 * año el umbral es bajo a propósito: la decisión la toma un admin, el
 * sistema sólo señala. Nunca crea reglas por su cuenta.
 */
const MIN_RUNS = 2;
const MIN_SUPPLIERS = 2;

export interface PublicSuggestion {
  id: string;
  field: string;
  before: string | null;
  after: string | null;
  occurrences: number;
  evidence: { suppliers: string[]; runs: number };
  proposedText: string;
  status: string;
  ruleId: string | null;
  createdAt: string;
  updatedAt: string;
}

const FIELD_LABEL: Record<string, string> = {
  prices_include_tax: "si los precios incluyen impuesto",
  tax_rate_pct: "la tasa de impuesto",
  commission_default_pct: "la comisión por defecto",
  currency: "la moneda",
  tipo_unidad: "el tipo de unidad (N = por noche, S = por servicio)",
  "shared_fields.pais": "el país del proveedor",
  "shared_fields.type_of_business": "el tipo de negocio",
  "shared_fields.tipo_unidad": "el tipo de unidad",
  "shared_fields.tipo_servicio": "el tipo de servicio",
  "shared_fields.tipo_moneda": "la moneda",
  tipo_servicio: "el tipo de servicio de la fila",
  ocupacion: "el código de ocupación",
  categoria: "la categoría del producto",
  meals_included: "el plan de alimentación",
};

function human(v: string | null): string {
  if (v === null || v === "") return "vacío";
  if (v === "true") return "sí";
  if (v === "false") return "no";
  return `«${v}»`;
}

function proposeText(field: string, before: string | null, after: string | null, n: number): string {
  const what = FIELD_LABEL[field] ?? `el campo ${field}`;
  return (
    `Al determinar ${what}, cuando el documento no lo diga de forma explícita, usar ${human(after)} ` +
    `en lugar de ${human(before)}. (Sugerida porque el revisor hizo esta misma corrección en ${n} contratos distintos; ` +
    `ajusta el texto para que describa la condición real antes de aceptarla.)`
  );
}

function toPublicSuggestion(r: {
  id: string; field: string; before: string | null; after: string | null; occurrences: number;
  evidence: unknown; proposedText: string; status: string; ruleId: string | null; createdAt: Date; updatedAt: Date;
}): PublicSuggestion {
  const ev = (r.evidence ?? {}) as { suppliers?: unknown; runs?: unknown };
  return {
    id: r.id,
    field: r.field,
    before: r.before,
    after: r.after,
    occurrences: r.occurrences,
    evidence: {
      suppliers: Array.isArray(ev.suppliers) ? ev.suppliers.filter((x): x is string => typeof x === "string") : [],
      runs: typeof ev.runs === "number" ? ev.runs : r.occurrences,
    },
    proposedText: r.proposedText,
    status: r.status,
    ruleId: r.ruleId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Recalcula candidatos desde el feedback de los runs y sincroniza la tabla. */
async function refreshSuggestions(): Promise<void> {
  // Sin filtro JSON-null de Prisma (varía entre versiones): filtramos en JS.
  const rows = await prisma.contractRun.findMany({
    orderBy: { processedAt: "desc" },
    take: 2000,
    select: { feedback: true, catalogPrefill: true, filename: true },
  });
  const report = buildQualityReport("all", rows.map((r) => ({
    feedback: (r.feedback as RunFeedback | null) ?? null,
    supplier: r.catalogPrefill && typeof r.catalogPrefill === "object"
      ? (((r.catalogPrefill as { proveedor_codigo?: unknown }).proveedor_codigo as string | undefined) ?? null)
      : null,
    filename: r.filename,
  })));
  for (const rec of report.recurring) {
    if (rec.runs < MIN_RUNS || rec.suppliers.length < MIN_SUPPLIERS) continue;
    const key = transitionKey(rec);
    const evidence = { suppliers: rec.suppliers, runs: rec.runs };
    await prisma.agentRuleSuggestion.upsert({
      where: { key },
      create: {
        key,
        field: rec.field,
        before: rec.before,
        after: rec.after,
        occurrences: rec.runs,
        evidence,
        proposedText: proposeText(rec.field, rec.before, rec.after, rec.runs),
      },
      // Lo ya decidido (accepted/dismissed) no se reabre; sólo refrescamos evidencia.
      update: { occurrences: rec.runs, evidence },
    });
  }
}

export async function listSuggestions(_req: Request, res: Response): Promise<void> {
  try {
    await refreshSuggestions();
  } catch (err) {
    // La lista sigue sirviendo lo que ya hay; el refresh no es crítico.
    logger.warn("refreshSuggestions failed", { error: err instanceof Error ? err.message : String(err) });
  }
  const rows = await prisma.agentRuleSuggestion.findMany({
    orderBy: [{ status: "asc" }, { occurrences: "desc" }, { updatedAt: "desc" }],
    take: 100,
  });
  res.json({ suggestions: rows.map(toPublicSuggestion), thresholds: { runs: MIN_RUNS, suppliers: MIN_SUPPLIERS } });
}

export async function acceptSuggestion(
  req: Request<{ id: string }, unknown, { text?: unknown }>,
  res: Response,
): Promise<void> {
  const sug = await prisma.agentRuleSuggestion.findUnique({ where: { id: req.params.id } });
  if (!sug) throw ApiError.notFound("Sugerencia no encontrada");
  if (sug.status === "accepted") throw ApiError.badRequest("La sugerencia ya fue aceptada.");
  const text = cleanText(req.body?.text ?? sug.proposedText);
  const rule = await prisma.agentRule.create({ data: { text, createdBy: req.auth?.id ?? null } });
  const updated = await prisma.agentRuleSuggestion.update({
    where: { id: sug.id },
    data: { status: "accepted", ruleId: rule.id },
  });
  logger.info("Agent rule suggestion accepted", { requestId: req.id, actorId: req.auth?.id, suggestionId: sug.id, ruleId: rule.id });
  res.json({ suggestion: toPublicSuggestion(updated), rule: toPublic(rule) });
}

export async function dismissSuggestion(req: Request<{ id: string }>, res: Response): Promise<void> {
  try {
    const updated = await prisma.agentRuleSuggestion.update({
      where: { id: req.params.id },
      data: { status: "dismissed" },
    });
    logger.info("Agent rule suggestion dismissed", { requestId: req.id, actorId: req.auth?.id, suggestionId: updated.id });
    res.json({ suggestion: toPublicSuggestion(updated) });
  } catch (err) {
    if (isPrismaKnownError(err) && err.code === "P2025") throw ApiError.notFound("Sugerencia no encontrada");
    throw err;
  }
}
