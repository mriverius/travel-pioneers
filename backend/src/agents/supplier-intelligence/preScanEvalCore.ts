/**
 * Núcleo del runner de regresión del pre-scan — compartido por el script
 * `npm run eval:prescan` y por la pantalla «Casos de prueba» del portal.
 *
 * Un caso = documentos de UN contrato + `expected` (lo que el pre-scan debe
 * leer). Los del repo viven en `backend/evals/prescan/<slug>/`; los creados
 * desde la UI viven en la DB (`eval_cases`). Determinístico: sin IA.
 *
 * `expected` (todas las claves opcionales; sólo se comprueba lo presente):
 * {
 *   "suppliers": [{ "codigo": "RIOSLODGE", "nombre": "RIOS LODGE", "actividad": "HO", "zona": "TUR" }],
 *   "supplier": { "codigo": "RIOSLODGE", "confidence": "alta" },
 *   "taxes": { "included": false, "percent": 13 },
 *   "commission": { "net": true },
 *   "currencies": ["USD"],
 *   "cedulas": ["3-102-845791"],
 *   "legalName": "Pacuare Canyon Lodge LLC. Limited",
 *   "validity": { "start": "2027-01-01", "end": "2027-12-31" },
 *   "seasons": [{ "name": "High Season", "ranges": ["01-01>03-31", "06-01>08-31", "11-01>12-31"] }],
 *   "seasonsCount": 2,
 *   "priceMentions": 76,
 *   "bankAccounts": [{ "iban": "CR30010710302104675229", "currency": "CRC" }],
 *   "cancellationTerms": [{ "daysBefore": 45, "percent": 0, "season": "high" }],
 *   "paymentTerms": [{ "daysBefore": 45, "percent": 100, "season": "high" }],
 *   "checkIn": "12:00 p.m.", "checkOut": "10:00 a.m.",
 *   "crossDocumentWarnings": 1
 * }
 * Cuando `suppliers` no viene, el caso se evalúa contra el maestro real.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import {
  preScan,
  type PreScanInputFile,
  type PreScanResult,
  type SupplierLite,
} from "./preScanService.js";

export type Json = Record<string, unknown>;

export function kindOf(file: string): PreScanInputFile["kind"] | null {
  const ext = extname(file).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".xlsx" || ext === ".xls") return "xlsx";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
  return null;
}

export interface Check { name: string; ok: boolean; expected: unknown; actual: unknown }

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function evaluatePreScan(r: PreScanResult, exp: Json): Check[] {
  const checks: Check[] = [];
  const add = (name: string, expected: unknown, actual: unknown, ok = eq(expected, actual)) =>
    checks.push({ name, ok, expected, actual });

  const i = r.inferences;
  const f = r.facts;

  if (exp.supplier) {
    const e = exp.supplier as { codigo?: string; confidence?: string };
    const top = r.supplier.candidates[0];
    if (e.codigo !== undefined) add("supplier.codigo", e.codigo, top?.codigo ?? null);
    if (e.confidence !== undefined) add("supplier.confidence", e.confidence, r.supplier.confidence);
  }
  if (exp.taxes) {
    const e = exp.taxes as { included?: boolean | null; percent?: number | null };
    if (e.included !== undefined) add("taxes.included", e.included, i.taxes?.included ?? null);
    if (e.percent !== undefined) add("taxes.percent", e.percent, i.taxes?.percent ?? null);
  }
  if (exp.commission) {
    const e = exp.commission as { net?: boolean; percent?: number | null };
    if (e.net !== undefined) add("commission.net", e.net, i.commission?.net ?? null);
    if (e.percent !== undefined) add("commission.percent", e.percent, i.commission?.percent ?? null);
  }
  if (exp.currencies) add("currencies", exp.currencies, f.currencies);
  if (exp.cedulas) {
    const e = exp.cedulas as string[];
    add("cedulas ⊇", e, f.cedulas, e.every((c) => f.cedulas.includes(c)));
  }
  if (exp.legalName !== undefined) add("legalName", exp.legalName, i.legalName);
  if (exp.validity) {
    const e = exp.validity as { start?: string; end?: string };
    add("validity", e, i.validity ? { start: i.validity.start, end: i.validity.end } : null,
      !!i.validity && (e.start === undefined || e.start === i.validity.start) && (e.end === undefined || e.end === i.validity.end));
  }
  if (exp.seasons) {
    const e = exp.seasons as { name?: string | null; ranges: string[] }[];
    const actual = i.seasons.map((s) => ({ name: s.name, ranges: s.ranges.map((x) => `${x.start}>${x.end}`) }));
    const ok = e.length === actual.length && e.every((es, idx) => {
      const a = actual[idx];
      if (!a) return false;
      if (es.name !== undefined && (es.name ?? "").toLowerCase() !== (a.name ?? "").toLowerCase()) return false;
      return eq(es.ranges, a.ranges);
    });
    add("seasons", e, actual, ok);
  }
  if (exp.seasonsCount !== undefined) add("seasons (count)", exp.seasonsCount, i.seasons.length);
  if (exp.priceMentions !== undefined) add("priceMentions", exp.priceMentions, i.priceMentions);
  if (exp.estimatedProducts !== undefined) add("estimatedProducts", exp.estimatedProducts, i.estimatedProducts);
  if (exp.bankAccounts) {
    const e = exp.bankAccounts as { iban: string; currency?: string | null; accountNumber?: string | null; bank?: string | null }[];
    const actual = i.bankAccounts.map((b) => ({ iban: b.iban, currency: b.currency, accountNumber: b.accountNumber, bank: b.bank }));
    const ok = e.every((eb) => {
      const a = i.bankAccounts.find((b) => b.iban === eb.iban);
      if (!a) return false;
      if (eb.currency !== undefined && eb.currency !== a.currency) return false;
      if (eb.accountNumber !== undefined && eb.accountNumber !== a.accountNumber) return false;
      if (eb.bank !== undefined && (eb.bank ?? "").toLowerCase() !== (a.bank ?? "").toLowerCase()) return false;
      return true;
    });
    add("bankAccounts ⊇", e, actual, ok);
  }
  const termSet = (xs: { daysBefore: number | null; percent: number | null; season: string | null }[]) =>
    xs.map((t) => `${t.daysBefore}|${t.percent}|${t.season ?? ""}`);
  if (exp.cancellationTerms) {
    const e = termSet(exp.cancellationTerms as never);
    const a = termSet(i.cancellationTerms);
    add("cancellationTerms ⊇", e, a, e.every((x) => a.includes(x)));
  }
  if (exp.paymentTerms) {
    const e = termSet(exp.paymentTerms as never);
    const a = termSet(i.paymentTerms);
    add("paymentTerms ⊇", e, a, e.every((x) => a.includes(x)));
  }
  if (exp.checkIn !== undefined) add("checkIn", exp.checkIn, i.checkIn);
  if (exp.checkOut !== undefined) add("checkOut", exp.checkOut, i.checkOut);
  if (exp.minNights !== undefined) add("minNights", exp.minNights, i.minNights);
  if (exp.crossDocumentWarnings !== undefined) add("crossDocumentWarnings (count)", exp.crossDocumentWarnings, r.crossDocumentWarnings.length);
  if (exp.phones) {
    const e = exp.phones as string[];
    const norm = (p: string) => p.replace(/\D/g, "").slice(-8);
    add("phones ⊇", e, f.phones, e.every((p) => f.phones.some((q) => norm(q) === norm(p))));
  }
  if (exp.emails) {
    const e = exp.emails as string[];
    add("emails ⊇", e, f.emails, e.every((p) => f.emails.includes(p)));
  }
  return checks;
}


export interface EvalCaseInput {
  slug: string;
  title: string;
  source: "repo" | "db";
  files: PreScanInputFile[];
  expected: Json;
}

export interface EvalCaseResult {
  slug: string;
  title: string;
  source: "repo" | "db";
  checks: Check[];
  ms: number;
  error?: string;
}

/** Carpetas de `backend/evals/prescan/` → casos. Vacío si la carpeta no existe (deploy sin fixtures). */
export function loadRepoCases(root: string, onlySlug?: string | null): EvalCaseInput[] {
  if (!existsSync(root)) return [];
  const out: EvalCaseInput[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    if (onlySlug && !name.endsWith(onlySlug)) continue;
    const expectedPath = join(dir, "expected.json");
    const expected = existsSync(expectedPath) ? (JSON.parse(readFileSync(expectedPath, "utf8")) as Json) : {};
    const files: PreScanInputFile[] = readdirSync(dir)
      .filter((f) => f !== "expected.json" && kindOf(f))
      .sort()
      .map((f) => ({ kind: kindOf(f)!, buffer: readFileSync(join(dir, f)), filename: f }));
    if (files.length === 0) continue;
    out.push({ slug: name, title: name, source: "repo", files, expected });
  }
  return out;
}

/** Metadatos de los casos del repo sin leer los PDFs (para listarlos en la UI). */
export function listRepoCaseMeta(root: string): { slug: string; files: { filename: string; kind: string; size: number }[]; expected: Json }[] {
  if (!existsSync(root)) return [];
  const out: { slug: string; files: { filename: string; kind: string; size: number }[]; expected: Json }[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const expectedPath = join(dir, "expected.json");
    const expected = existsSync(expectedPath) ? (JSON.parse(readFileSync(expectedPath, "utf8")) as Json) : {};
    const files = readdirSync(dir)
      .filter((f) => f !== "expected.json" && kindOf(f))
      .sort()
      .map((f) => ({ filename: f, kind: kindOf(f)!, size: statSync(join(dir, f)).size }));
    if (files.length === 0) continue;
    out.push({ slug: name, files, expected });
  }
  return out;
}

export function suppliersFromExpected(exp: Json): SupplierLite[] | null {
  const list = exp.suppliers as Partial<SupplierLite>[] | undefined;
  if (!list || list.length === 0) return null;
  return list.map((s, idx) => ({
    id: s.id ?? `fixture-${idx}`,
    codigo: s.codigo ?? `S${idx}`,
    nombre: s.nombre ?? null,
    actividad: s.actividad ?? null,
    zona: s.zona ?? null,
    serviceCount: s.serviceCount ?? 0,
  }));
}

/**
 * Corre un caso. `fallbackSuppliers` se usa cuando el expected no trae su
 * propia lista (casos creados desde la UI → maestro real).
 */
export async function runEvalCase(
  c: EvalCaseInput,
  fallbackSuppliers: SupplierLite[] | undefined,
  opts: { dump?: boolean } = {},
): Promise<{ result: EvalCaseResult; raw: PreScanResult | null }> {
  try {
    const suppliers = suppliersFromExpected(c.expected) ?? fallbackSuppliers;
    const r = await preScan(c.files, suppliers ? { suppliers } : {});
    if (opts.dump) {
      const { inferences, ...rest } = r;
      const { prices, sections, ...inf } = inferences;
      console.log(JSON.stringify({ ...rest, inferences: { ...inf, prices: prices.length, sections: sections.length } }, null, 1));
    }
    return { result: { slug: c.slug, title: c.title, source: c.source, checks: evaluatePreScan(r, c.expected), ms: r.durationMs }, raw: r };
  } catch (err) {
    return {
      result: { slug: c.slug, title: c.title, source: c.source, checks: [], ms: 0, error: err instanceof Error ? err.message : String(err) },
      raw: null,
    };
  }
}
