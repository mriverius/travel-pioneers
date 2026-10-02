/**
 * Señal de aprendizaje de un run ("feedback").
 *
 * No es telemetría de la IA: es la diferencia entre lo que el sistema
 * propuso (pre-scan determinístico, brief de la IA, filas de la IA) y lo que
 * el revisor humano APROBÓ. Con 300 contratos al año no hay volumen para
 * entrenar nada, pero sí para medir dónde falla cada capa y para detectar
 * correcciones recurrentes que merecen ser una regla permanente.
 *
 * El frontend la construye al aprobar (Paso 3 → xlsx) y la envía en
 * `POST /contracts` junto con el run. Se guarda tal cual en
 * `contract_runs.feedback` (JSONB) tras una validación de forma y tamaño.
 */

export type CorrectionScope = "brief" | "shared" | "row";
export type CorrectionSource = "user" | "prescan";

export interface Correction {
  scope: CorrectionScope;
  /** Clave del campo (`prices_include_tax`, `shared_fields.cedula`, `precio_rack_iva`…). */
  field: string;
  /** Índice de fila (sólo scope "row"). */
  row?: number;
  before: string | null;
  after: string | null;
  /** "prescan": el hueco lo llenó el documento (no la persona). */
  source: CorrectionSource;
}

export interface QaFindingRef {
  id: string;
  severity: "error" | "warning" | "info";
  topic: string;
}

export interface QaAnswerRef {
  id: string;
  topic: string;
  required: boolean;
  /** optionId elegido ("doc", "ai", "excl", "incl"…) o "skip". */
  answer: string;
}

export interface RunFeedback {
  version: 1;
  pre_scan: {
    ran: boolean;
    text_available: boolean;
    documents: number;
    detected: { codigo: string; confidence: "alta" | "media" | "ninguna" } | null;
    /** Código elegido por el usuario en el Paso 1 (null = proveedor nuevo). */
    chosen: string | null;
    /** detected.codigo === chosen; null cuando no hay con qué comparar. */
    supplier_hit: boolean | null;
  } | null;
  brief: {
    corrections: Correction[];
    /** Claves que el pre-scan rellenó porque la IA las dejó vacías. */
    prescan_filled: string[];
    qa_findings: QaFindingRef[];
    questions: QaAnswerRef[];
    chat_messages: number;
  } | null;
  rows: {
    total: number;
    added: number;
    removed: number;
    corrections: Correction[];
    qa_findings: QaFindingRef[];
    acknowledged_errors: boolean;
    chat_messages: number;
  };
  comments_chars: number;
  agency_rules: number;
}

const MAX_JSON_BYTES = 96 * 1024;
const MAX_CORRECTIONS = 400;
const MAX_VALUE_CHARS = 240;

function str(v: unknown, max = MAX_VALUE_CHARS): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) : s;
}

function int(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function corrections(v: unknown): Correction[] {
  if (!Array.isArray(v)) return [];
  const out: Correction[] = [];
  for (const c of v.slice(0, MAX_CORRECTIONS)) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const scope = o.scope;
    if (scope !== "brief" && scope !== "shared" && scope !== "row") continue;
    if (typeof o.field !== "string" || !o.field) continue;
    out.push({
      scope,
      field: o.field.slice(0, 80),
      ...(typeof o.row === "number" ? { row: Math.floor(o.row) } : {}),
      before: str(o.before),
      after: str(o.after),
      source: o.source === "prescan" ? "prescan" : "user",
    });
  }
  return out;
}

function findings(v: unknown): QaFindingRef[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 200)
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .filter((f) => typeof f.id === "string" && typeof f.topic === "string")
    .map((f) => ({
      id: String(f.id).slice(0, 80),
      severity: f.severity === "error" || f.severity === "warning" ? f.severity : "info",
      topic: String(f.topic).slice(0, 40),
    }));
}

function answers(v: unknown): QaAnswerRef[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 100)
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .filter((f) => typeof f.id === "string" && typeof f.answer === "string")
    .map((f) => ({
      id: String(f.id).slice(0, 80),
      topic: typeof f.topic === "string" ? f.topic.slice(0, 40) : "other",
      required: f.required === true,
      answer: String(f.answer).slice(0, 40),
    }));
}

/**
 * Valida y normaliza el feedback que manda el cliente. Devuelve `null`
 * (y el motivo) cuando no es utilizable: el save del run NUNCA debe fallar
 * por culpa del feedback — es señal secundaria.
 */
export function coerceFeedback(v: unknown): { feedback: RunFeedback | null; reason?: string } {
  if (v === undefined || v === null) return { feedback: null };
  if (typeof v !== "object" || Array.isArray(v)) return { feedback: null, reason: "not-an-object" };
  const raw = JSON.stringify(v);
  if (raw.length > MAX_JSON_BYTES) return { feedback: null, reason: "too-large" };
  const o = v as Record<string, unknown>;

  const ps = o.pre_scan && typeof o.pre_scan === "object" ? (o.pre_scan as Record<string, unknown>) : null;
  const det =
    ps?.detected && typeof ps.detected === "object" && typeof (ps.detected as Record<string, unknown>).codigo === "string"
      ? (ps.detected as { codigo: string; confidence?: unknown })
      : null;
  const conf = det?.confidence;
  const pre_scan: RunFeedback["pre_scan"] = ps
    ? {
        ran: ps.ran === true,
        text_available: ps.text_available === true,
        documents: int(ps.documents),
        detected: det
          ? { codigo: det.codigo.slice(0, 40), confidence: conf === "alta" || conf === "media" ? conf : "ninguna" }
          : null,
        chosen: typeof ps.chosen === "string" ? ps.chosen.slice(0, 40) : null,
        supplier_hit: typeof ps.supplier_hit === "boolean" ? ps.supplier_hit : null,
      }
    : null;

  const br = o.brief && typeof o.brief === "object" ? (o.brief as Record<string, unknown>) : null;
  const brief: RunFeedback["brief"] = br
    ? {
        corrections: corrections(br.corrections),
        prescan_filled: Array.isArray(br.prescan_filled)
          ? br.prescan_filled.filter((x): x is string => typeof x === "string").slice(0, 60)
          : [],
        qa_findings: findings(br.qa_findings),
        questions: answers(br.questions),
        chat_messages: int(br.chat_messages),
      }
    : null;

  const rw = o.rows && typeof o.rows === "object" ? (o.rows as Record<string, unknown>) : {};
  const rows: RunFeedback["rows"] = {
    total: int(rw.total),
    added: int(rw.added),
    removed: int(rw.removed),
    corrections: corrections(rw.corrections),
    qa_findings: findings(rw.qa_findings),
    acknowledged_errors: rw.acknowledged_errors === true,
    chat_messages: int(rw.chat_messages),
  };

  return {
    feedback: {
      version: 1,
      pre_scan,
      brief,
      rows,
      comments_chars: int(o.comments_chars),
      agency_rules: int(o.agency_rules),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                         Agregación (panel de calidad)                      */
/* -------------------------------------------------------------------------- */

export interface QualityReport {
  range: string;
  runs: number;
  /** Runs que traen feedback (los anteriores a esta versión no). */
  runs_with_feedback: number;
  pre_scan: {
    with_text: number;
    comparable: number;
    supplier_hits: number;
    /** Por confianza declarada: cuántas veces acertó / total. */
    by_confidence: Record<string, { hits: number; total: number }>;
  };
  brief: {
    runs: number;
    /** Campos del brief corregidos por una persona (total y promedio por run). */
    user_corrections: number;
    prescan_fills: number;
    questions_asked: number;
    answered_doc: number;
    answered_ai: number;
    answered_other: number;
    skipped: number;
    chat_messages: number;
    /** Campo → veces corregido (top). */
    top_fields: { field: string; count: number }[];
    /** Hallazgo del QA → veces que apareció (top). */
    top_findings: { id: string; severity: string; count: number }[];
  };
  rows: {
    runs: number;
    total_rows: number;
    corrected_cells: number;
    rows_added: number;
    rows_removed: number;
    runs_with_errors_acknowledged: number;
    chat_messages: number;
    top_fields: { field: string; count: number }[];
    top_findings: { id: string; severity: string; count: number }[];
  };
  /** Correcciones recurrentes (misma transición en ≥2 runs). */
  recurring: {
    scope: CorrectionScope;
    field: string;
    before: string | null;
    after: string | null;
    runs: number;
    suppliers: string[];
  }[];
}

interface RunLite {
  feedback: RunFeedback | null;
  supplier: string | null;
  filename: string;
}

function top<T extends string>(counter: Map<T, number>, n: number): { key: T; count: number }[] {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

/** Clave estable de una transición para agrupar correcciones recurrentes. */
export function transitionKey(c: Pick<Correction, "scope" | "field" | "before" | "after">): string {
  const norm = (v: string | null) => (v ?? "∅").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 60);
  return `${c.scope}|${c.field}|${norm(c.before)}→${norm(c.after)}`;
}

/** Campos cuyo valor es categórico/pequeño: sólo estos generan patrones recurrentes útiles. */
export const PATTERN_FIELDS = new Set([
  "prices_include_tax",
  "tax_rate_pct",
  "commission_default_pct",
  "currency",
  "tipo_unidad",
  "shared_fields.pais",
  "shared_fields.type_of_business",
  "tipo_servicio",
  "ocupacion",
  "categoria",
  "meals_included",
  "shared_fields.tipo_unidad",
  "shared_fields.tipo_servicio",
  "shared_fields.tipo_moneda",
]);

export function buildQualityReport(range: string, runs: RunLite[]): QualityReport {
  const withFb = runs.filter((r) => r.feedback);
  const psStats = { with_text: 0, comparable: 0, supplier_hits: 0, by_confidence: {} as Record<string, { hits: number; total: number }> };
  const briefFields = new Map<string, number>();
  const briefFindings = new Map<string, number>();
  const rowFields = new Map<string, number>();
  const rowFindings = new Map<string, number>();
  const recurring = new Map<string, { scope: CorrectionScope; field: string; before: string | null; after: string | null; runs: Set<string>; suppliers: Set<string> }>();
  const b = { runs: 0, user_corrections: 0, prescan_fills: 0, questions_asked: 0, answered_doc: 0, answered_ai: 0, answered_other: 0, skipped: 0, chat_messages: 0 };
  const rw = { runs: 0, total_rows: 0, corrected_cells: 0, rows_added: 0, rows_removed: 0, runs_with_errors_acknowledged: 0, chat_messages: 0 };

  withFb.forEach((r, idx) => {
    const fb = r.feedback!;
    const runKey = `${idx}`;
    if (fb.pre_scan?.ran) {
      if (fb.pre_scan.text_available) psStats.with_text++;
      if (fb.pre_scan.supplier_hit !== null) {
        psStats.comparable++;
        if (fb.pre_scan.supplier_hit) psStats.supplier_hits++;
        const c = fb.pre_scan.detected?.confidence ?? "ninguna";
        const slot = (psStats.by_confidence[c] ??= { hits: 0, total: 0 });
        slot.total++;
        if (fb.pre_scan.supplier_hit) slot.hits++;
      }
    }
    if (fb.brief) {
      b.runs++;
      for (const c of fb.brief.corrections) {
        if (c.source === "prescan") {
          b.prescan_fills++;
          continue;
        }
        b.user_corrections++;
        briefFields.set(c.field, (briefFields.get(c.field) ?? 0) + 1);
        if (PATTERN_FIELDS.has(c.field)) {
          const k = transitionKey(c);
          const slot = recurring.get(k) ?? { scope: c.scope, field: c.field, before: c.before, after: c.after, runs: new Set(), suppliers: new Set() };
          slot.runs.add(runKey);
          slot.suppliers.add(r.supplier ?? r.filename);
          recurring.set(k, slot);
        }
      }
      for (const f of fb.brief.qa_findings) briefFindings.set(`${f.id}|${f.severity}`, (briefFindings.get(`${f.id}|${f.severity}`) ?? 0) + 1);
      for (const q of fb.brief.questions) {
        b.questions_asked++;
        if (q.answer === "skip") b.skipped++;
        else if (q.answer === "doc") b.answered_doc++;
        else if (q.answer === "ai") b.answered_ai++;
        else b.answered_other++;
      }
      b.chat_messages += fb.brief.chat_messages;
    }
    rw.runs++;
    rw.total_rows += fb.rows.total;
    rw.rows_added += fb.rows.added;
    rw.rows_removed += fb.rows.removed;
    rw.chat_messages += fb.rows.chat_messages;
    if (fb.rows.acknowledged_errors) rw.runs_with_errors_acknowledged++;
    const seenRowFields = new Set<string>();
    for (const c of fb.rows.corrections) {
      rw.corrected_cells++;
      rowFields.set(c.field, (rowFields.get(c.field) ?? 0) + 1);
      if (PATTERN_FIELDS.has(c.field)) {
        // Una transición por run: 40 filas con la misma corrección cuentan 1.
        const k = transitionKey(c);
        if (seenRowFields.has(k)) continue;
        seenRowFields.add(k);
        const slot = recurring.get(k) ?? { scope: c.scope, field: c.field, before: c.before, after: c.after, runs: new Set(), suppliers: new Set() };
        slot.runs.add(runKey);
        slot.suppliers.add(r.supplier ?? r.filename);
        recurring.set(k, slot);
      }
    }
    for (const f of fb.rows.qa_findings) rowFindings.set(`${f.id}|${f.severity}`, (rowFindings.get(`${f.id}|${f.severity}`) ?? 0) + 1);
  });

  const splitFinding = (x: { key: string; count: number }) => {
    const [id, severity] = x.key.split("|");
    return { id: id ?? x.key, severity: severity ?? "info", count: x.count };
  };

  return {
    range,
    runs: runs.length,
    runs_with_feedback: withFb.length,
    pre_scan: psStats,
    brief: {
      ...b,
      top_fields: top(briefFields, 12).map((x) => ({ field: x.key, count: x.count })),
      top_findings: top(briefFindings, 12).map(splitFinding),
    },
    rows: {
      ...rw,
      top_fields: top(rowFields, 12).map((x) => ({ field: x.key, count: x.count })),
      top_findings: top(rowFindings, 12).map(splitFinding),
    },
    recurring: [...recurring.values()]
      .filter((x) => x.runs.size >= 2)
      .sort((a, c) => c.runs.size - a.runs.size)
      .slice(0, 20)
      .map((x) => ({ scope: x.scope, field: x.field, before: x.before, after: x.after, runs: x.runs.size, suppliers: [...x.suppliers].slice(0, 10) })),
  };
}
