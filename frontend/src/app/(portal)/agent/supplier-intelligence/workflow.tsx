"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Cloud,
  CloudUpload,
  FileSpreadsheet,
  FileText,
  ImageIcon,
  Loader2,
  MessageSquareText,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  ChevronDown,
  History,
  HelpCircle,
  Info,
  Search,
  ScanSearch,
  ShieldCheck,
  UserCheck,
  UserPlus,
  Download,
  Send,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import { combinePipelineUsage } from "@/lib/anthropicUsage";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  api,
  ApiError,
  describeRequestFailure,
  type AnalyzeBriefMeta,
  type BriefChatMessage,
  type CatalogSupplier,
  type PreScanResult,
  type ContractConfigVariables,
  type ExtractContractResponse,
  type ExtractedContract,
  type ExtractedContractRow,
  type ExtractedRowFieldKey,
  type ExtractedSharedFieldKey,
  type ExtractedSharedFields,
  type ExtractionConfianza,
  type ExtractionSourcePage,
  type GenerateXlsxCatalogPrefill,
  type GenerateXlsxManualFields,
  type ManualBankPrefill,
  type RunCorrection,
  type RunFeedback,
  type SupplierMemory,
  type TableChatMessage,
} from "@/lib/api";
import { useAuth } from "@/lib/useAuth";
import { SaveEvalCaseCard } from "./saveEvalCase";
import {
  qaBrief,
  qaRows,
  worstSeverity,
  type BriefQaResult,
  type QaFinding,
  type QaOption,
  type QaQuestion,
  type QaSeverity,
} from "@/lib/contractQa";
import { ConfigVariablesStep } from "./configStep";
import {
  findServiceForSupplierWithAI,
  listSuppliers,
  normalizeKey,
  withServices,
  type SupplierMatch,
} from "@/lib/supplierLookup";
import {
  CATEGORIAS_BY_TIPO_SERVICIO,
  TIPOS_SERVICIO,
} from "@/lib/serviceTypesCatalog";

/**
 * UUID v4 for `ExtractionMeta.extraction_id`. `crypto.randomUUID` needs a
 * secure context; on plain-http LAN setups we fall back to getRandomValues.
 */
function newExtractionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Three-step supplier-contract workflow wired to the backend agent at
 * `POST /api/supplier-intelligence/extract`.
 *
 *   1. Upload   — drag & drop a .pdf / .docx / .doc / .xlsx / .xls (≤20 MB).
 *   2. Review   — Tabla plana de 52 columnas (A..AZ). Cada combinación
 *                 product × season es una fila. Las columnas compartidas
 *                 (razón social, cédula, bancos…) muestran el mismo valor
 *                 en todas las filas; editar una propaga al resto. Source
 *                 page en tooltip al hover sobre cada celda.
 *   3. Download — POST /generate-xlsx con los datos aprobados y descarga el
 *                 xlsx final (clonado de plantilla-agente-utopia.xlsx).
 */

type Step = 1 | 2 | 3 | 4;

export type FileKind = "pdf" | "docx" | "xlsx" | "image";

/* -------------------------------------------------------------------------- */
/*                       Catalog prefill from master                          */
/* -------------------------------------------------------------------------- */

/**
 * Datos que vienen del catálogo lista-proveedores cuando el usuario marca
 * "Sí, existente" en step 1. Estos pre-llenan las columnas A, B, C, N del
 * xlsx. Cuando no hay match, el usuario los puede llenar a mano en step 2.
 */
export type CatalogPrefill = {
  tipo_actividad: string | null;
  zona_turismo: string | null;
  /** Código corto del proveedor en el maestro (columna C del xlsx). */
  proveedor_codigo: string | null;
  codigo_servicio: string | null;
};

/**
 * Respuesta al "¿Es un proveedor existente?" del Paso 1. `null` = todavía no
 * respondió (campo requerido). Si es existente, el proveedor elegido en el
 * dropdown es el que alimenta el prefill de catálogo — ya no se adivina por
 * nombre.
 */
export type SupplierChoice =
  | { existing: false }
  | { existing: true; supplier: CatalogSupplier };

export type PreScanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; result: PreScanResult }
  | { status: "error"; message: string };

/** Candidato del pre-scan → forma de catálogo (sin servicios; se piden al analizar). */
function candidateToSupplier(c: PreScanResult["supplier"]["candidates"][number]): CatalogSupplier {
  return {
    id: c.id,
    codigo: c.codigo,
    nombre: c.nombre,
    actividad: c.actividad,
    zona: c.zona,
    servicios: [],
    serviceCount: c.serviceCount,
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * Fallback + contraste del brief IA con lo leído sin IA en el pre-scan.
 *
 *  - Rellena huecos (el brief dejó `null`) con datos determinísticos del
 *    documento: correo, teléfono, país, cédula, vigencia, moneda, IVA,
 *    comisión. Nunca pisa un valor que la IA sí dio.
 *  - Devuelve avisos cuando ambos tienen valor y discrepan: es justo el
 *    tipo de error que envenena todas las filas (IVA incluido o no, moneda).
 */
function reconcileBriefWithPreScan(
  brief: ContractConfigVariables,
  scan: PreScanResult,
): ContractConfigVariables {
  const inf = scan.inferences;
  const facts = scan.facts;
  const sf = { ...brief.shared_fields };
  const out: ContractConfigVariables = { ...brief, shared_fields: sf };

  const fill = <K extends keyof typeof sf>(key: K, value: string | null | undefined) => {
    if ((sf[key] === null || sf[key] === "") && value) sf[key] = value as (typeof sf)[K];
  };
  fill("reservations_email", facts.emails.find((e) => /reserv|book|ventas|sales/i.test(e)) ?? facts.emails[0]);
  fill("telefono", facts.phones[0]);
  fill("cedula", facts.cedulas[0]);
  fill("pais", inf.country?.value);
  fill("proveedor", inf.legalName);
  fill("direccion", inf.address);
  if (inf.validity) {
    fill("contract_starts", inf.validity.start);
    fill("contract_ends", inf.validity.end);
  }

  if (out.currency === null && facts.currencies.length === 1) out.currency = facts.currencies[0]!;
  if (inf.taxes) {
    if (out.prices_include_tax === null && inf.taxes.included !== null) out.prices_include_tax = inf.taxes.included;
    if (out.tax_rate_pct === null && inf.taxes.percent !== null) out.tax_rate_pct = inf.taxes.percent;
  }
  if (inf.commission && out.commission_default_pct === null) {
    out.commission_default_pct = inf.commission.net ? 0 : inf.commission.percent;
  }
  return out;
}

/**
 * JSON compacto de hechos verificados para el prompt (ver backend
 * `buildContextBlock`). Sólo lo que ayuda al modelo a anclar o validar; nada
 * de snippets largos ni listas gigantes (tope ~24 KB en el backend).
 *
 *  - `documents[].pageMap`: lectura dirigida — en qué página están tarifas,
 *    temporadas, políticas y bancos, para que el modelo no "lea" 25 páginas
 *    de cláusulas legales buscando una tabla.
 *  - `previousConfirmed`: memoria del proveedor (lo que un revisor aprobó la
 *    última vez). Prioridad media: el documento actual manda.
 */
function buildPreScanHints(
  scan: PreScanResult | null,
  supplier: CatalogSupplier | null,
  memory: SupplierMemory | null,
): Record<string, unknown> | null {
  if (!scan && !supplier && !memory) return null;
  const out: Record<string, unknown> = {};
  if (supplier) {
    out.supplier = {
      codigo: supplier.codigo,
      nombre: supplier.nombre,
      actividad: supplier.actividad,
      zona: supplier.zona,
      servicios: supplier.servicios.slice(0, 60).map((s) => ({
        codigo: s.codigo,
        descripcion: s.descripcion,
        actividad: s.actividad ?? null,
        zona: s.zona ?? null,
      })),
    };
  }
  if (scan && scan.documents.some((d) => d.textAvailable)) {
    const f = scan.facts;
    const i = scan.inferences;
    out.documents = scan.documents.map((d) => ({
      filename: d.filename,
      pages: d.pages?.total ?? null,
      contributes: d.contributes,
      pageMap: (d.pageMap ?? [])
        .filter((pg) => pg.prices > 0 || pg.topics.length > 0)
        .slice(0, 80)
        .map((pg) => ({ page: pg.page, prices: pg.prices, topics: pg.topics })),
    }));
    out.identity = {
      legalName: i.legalName,
      cedulas: f.cedulas,
      address: i.address,
      country: i.country?.value ?? null,
      emails: f.emails,
      phones: f.phones,
      website: i.website,
    };
    out.validity = i.validity;
    out.currencies = f.currencies;
    out.taxes = i.taxes ? { included: i.taxes.included, percent: i.taxes.percent } : null;
    out.commission = i.commission ? { net: i.commission.net, percent: i.commission.percent } : null;
    out.rateBasis = i.rateBasis;
    out.occupancies = i.occupancies;
    out.seasons = i.seasons;
    out.minNights = i.minNights;
    out.checkIn = i.checkIn;
    out.checkOut = i.checkOut;
    out.meals = i.meals;
    out.paymentTerms = i.paymentTerms.map((t) => ({ daysBefore: t.daysBefore, percent: t.percent, season: t.season }));
    out.cancellationTerms = i.cancellationTerms.map((t) => ({ daysBefore: t.daysBefore, percent: t.percent, season: t.season }));
    out.childTerms = i.childTerms;
    out.bankAccounts = i.bankAccounts;
    out.priceMentions = i.priceMentions;
    out.distinctPrices = i.prices.length;
    out.estimatedProducts = i.estimatedProducts;
    out.productHints = i.productHints;
  }
  if (memory) {
    out.previousConfirmed = {
      processedAt: memory.processedAt,
      filename: memory.filename,
      shared: memory.shared,
      seasons: memory.seasons,
      occupancies: memory.occupancies,
      codigosServicio: memory.codigosServicio,
      products: memory.products.slice(0, 40),
      rowCount: memory.rowCount,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/* --------------------------- Feedback (aprendizaje) ----------------------- */

/**
 * Aplana un brief a `clave → texto` para poder diferenciar lo que propuso
 * la IA de lo que la persona aprobó. Objetos y arrays se serializan: nos
 * interesa saber QUÉ campo cambió, no reconstruirlo.
 */
function flattenBrief(b: ContractConfigVariables): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const scalar = (v: unknown): string | null =>
    v === null || v === undefined || v === "" ? null : typeof v === "string" ? v : JSON.stringify(v);
  for (const [k, v] of Object.entries(b.shared_fields ?? {})) out[`shared_fields.${k}`] = scalar(v);
  const keys: (keyof ContractConfigVariables)[] = [
    "prices_include_tax", "tax_rate_pct", "tax_note", "commission_default_pct", "commission_summary",
    "meal_plan_note", "currency", "bank_accounts", "additional_person", "special_periods_note",
    "product_categories", "seasons_detail", "expected_row_estimate", "notes", "tipo_unidad",
    "occupancy_codes", "occupancies_by_product", "max_adults_per_room", "quadruple_allowed", "row_plan",
  ];
  for (const k of keys) out[k] = scalar(b[k]);
  return out;
}

function diffFlat(
  before: Record<string, string | null>,
  after: Record<string, string | null>,
  scope: RunCorrection["scope"],
  prescanFilled: Set<string> = new Set(),
): RunCorrection[] {
  const out: RunCorrection[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const a = before[k] ?? null;
    const b = after[k] ?? null;
    if ((a ?? "").trim() === (b ?? "").trim()) continue;
    out.push({ scope, field: k, before: a, after: b, source: prescanFilled.has(k) && a === null ? "prescan" : "user" });
  }
  return out;
}

/** Diferencias por celda entre las filas de la IA y las aprobadas (por índice). */
function diffRows(before: ExtractedContractRow[], after: ExtractedContractRow[]): RunCorrection[] {
  const out: RunCorrection[] = [];
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const a = before[i]!;
    const b = after[i]!;
    for (const k of Object.keys(a) as (keyof ExtractedContractRow)[]) {
      const va = a[k] ?? null;
      const vb = b[k] ?? null;
      if ((va ?? "").trim() === (vb ?? "").trim()) continue;
      out.push({ scope: "row", field: k, row: i, before: va, after: vb, source: "user" });
      if (out.length >= 400) return out;
    }
  }
  return out;
}

/** Parte del feedback que se conoce al salir del Paso 2 (el resto lo agrega el Paso 3). */
type FeedbackBase = Pick<RunFeedback, "pre_scan" | "brief" | "comments_chars" | "agency_rules">;

/* ----------------------------- QA (UI) ------------------------------------ */

const QA_STYLE: Record<QaSeverity, { row: string; icon: string; label: string }> = {
  error: { row: "text-red-100/90", icon: "text-red-400", label: "errores" },
  warning: { row: "text-amber-100/90", icon: "text-amber-400", label: "advertencias" },
  info: { row: "text-muted-foreground", icon: "text-sky-400", label: "informativos" },
};

function QaIcon({ severity, className }: { severity: QaSeverity; className: string }) {
  return severity === "info" ? <Info className={className} /> : <AlertTriangle className={className} />;
}

/**
 * Lista de hallazgos del revisor determinístico, agrupados por severidad.
 * Sin hallazgos muestra un "todo en orden" explícito: el usuario debe saber
 * que la verificación corrió y no encontró nada, no sólo que no hay avisos.
 */
function QaFindingsPanel({
  findings,
  title,
  defaultOpen = true,
}: {
  findings: QaFinding[];
  title: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (findings.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-[12.5px] text-emerald-200">
        <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
        <span>
          <span className="font-semibold">{title}:</span> sin hallazgos.
        </span>
      </div>
    );
  }
  const worst = worstSeverity(findings);
  const border =
    worst === "error"
      ? "border-red-500/40 bg-red-500/5"
      : worst === "warning"
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-border bg-secondary/20";
  const groups = (["error", "warning", "info"] as QaSeverity[])
    .map((sev) => [sev, findings.filter((f) => f.severity === sev)] as const)
    .filter(([, xs]) => xs.length > 0);
  return (
    <div className={`rounded-xl border ${border} px-4 py-3 space-y-2`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-foreground">
          <ShieldCheck className="h-4 w-4 text-primary" />
          {title}
        </span>
        <span className="flex items-center gap-2.5 text-[11.5px]">
          {groups.map(([sev, xs]) => (
            <span key={sev} className={QA_STYLE[sev].icon}>
              {xs.length} {QA_STYLE[sev].label}
            </span>
          ))}
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {open &&
        groups.map(([sev, xs]) => (
          <div key={sev} className="space-y-1">
            {xs.map((f) => (
              <div key={f.id} className={`flex items-start gap-2 text-[12px] ${QA_STYLE[sev].row}`}>
                <QaIcon severity={sev} className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${QA_STYLE[sev].icon}`} />
                <span>
                  <span className="font-medium">{f.title}.</span> {f.detail}
                </span>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/**
 * Paso 2 — preguntas que el revisor humano debe decidir antes de extraer.
 * Cada opción (a) corrige el brief y (b) se envía a la extracción como
 * instrucción del usuario (prioridad máxima). "Omitir" deja el brief como
 * está y sólo desbloquea el botón.
 */
function BriefQaPanel({
  qa,
  answers,
  resolutions,
  onAnswer,
  onSkip,
  onUndo,
}: {
  qa: BriefQaResult;
  answers: Record<string, string>;
  resolutions: Record<string, { title: string; instruction: string }>;
  onAnswer: (q: QaQuestion, o: QaOption) => void;
  onSkip: (q: QaQuestion) => void;
  onUndo: (id: string) => void;
}) {
  const open = qa.questions.filter((q) => answers[q.id] === undefined);
  const skipped = qa.questions.filter((q) => answers[q.id] === "skip");
  const resolved = Object.entries(resolutions);
  return (
    <div className="space-y-3">
      <QaFindingsPanel findings={qa.findings} title="Revisión automática del brief (sin IA)" />
      {(open.length > 0 || skipped.length > 0 || resolved.length > 0) && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 space-y-3">
          <div>
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-foreground">
              <HelpCircle className="h-4 w-4 text-primary" />
              Preguntas antes de extraer
            </p>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              Tu respuesta corrige el brief y viaja a la extracción como instrucción tuya
              (prioridad máxima, por encima del documento).
            </p>
          </div>
          {open.map((q) => (
            <div key={q.id} className="rounded-lg border border-border bg-card/60 px-3 py-2.5 space-y-2">
              <div>
                <p className="text-[12.5px] font-medium text-foreground">
                  {q.title}
                  {q.required && (
                    <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                      obligatoria
                    </span>
                  )}
                </p>
                <p className="text-[11.5px] text-muted-foreground">{q.detail}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => onAnswer(q, o)}
                    className="rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 text-[12px] text-foreground transition-colors hover:bg-primary/20"
                  >
                    {o.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => onSkip(q)}
                  className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-secondary/60"
                >
                  Omitir (dejar como está)
                </button>
              </div>
            </div>
          ))}
          {(resolved.length > 0 || skipped.length > 0) && (
            <div className="space-y-1 border-t border-border/60 pt-2">
              {resolved.map(([id, r]) => (
                <div key={id} className="flex items-start justify-between gap-2 text-[12px] text-emerald-200/90">
                  <span className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    <span>
                      <span className="font-medium">{r.title}</span> — {r.instruction}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onUndo(id)}
                    className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    quitar
                  </button>
                </div>
              ))}
              {skipped.map((q) => (
                <div key={q.id} className="flex items-start justify-between gap-2 text-[12px] text-muted-foreground">
                  <span className="flex items-start gap-2">
                    <Undo2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>Omitida: {q.title}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onUndo(q.id)}
                    className="shrink-0 text-[11px] hover:text-foreground"
                  >
                    reabrir
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const MEMORY_LABELS: Record<string, string> = {
  cedula: "Cédula",
  reservations_email: "Correo reservas",
  telefono: "Teléfono",
  pais: "País",
  contract_starts: "Inicio vigencia",
  contract_ends: "Fin vigencia",
  tipo_unidad: "Tipo unidad",
  tipo_moneda: "Moneda",
  banco: "Banco",
  numero_cuenta: "Cuenta",
};

/**
 * Memoria explícita del proveedor: lo que el revisor aprobó la última vez vs.
 * lo que dice el brief actual. Es referencia, no verdad: un contrato nuevo
 * puede cambiar la cuenta o la vigencia. Por eso sólo marca diferencias.
 */
function SupplierMemoryPanel({
  memory,
  brief,
}: {
  memory: SupplierMemory | null;
  brief: ContractConfigVariables | null;
}) {
  const [open, setOpen] = useState(false);
  if (!memory) return null;
  const sf = brief?.shared_fields;
  const cur: Record<string, string | null> = {
    cedula: sf?.cedula ?? null,
    reservations_email: sf?.reservations_email ?? null,
    telefono: sf?.telefono ?? null,
    pais: sf?.pais ?? null,
    contract_starts: sf?.contract_starts ?? null,
    contract_ends: sf?.contract_ends ?? null,
    tipo_unidad: brief?.tipo_unidad ?? null,
    tipo_moneda: brief?.currency ?? null,
    banco: brief?.bank_accounts?.[0]?.bank ?? null,
    numero_cuenta: brief?.bank_accounts?.[0]?.account_number ?? null,
  };
  const norm = (v: string | null) => (v ?? "").replace(/[\s-]+/g, "").toLowerCase();
  const rows = Object.keys(MEMORY_LABELS)
    .map((k) => ({ k, label: MEMORY_LABELS[k]!, prev: memory.shared[k] ?? null, cur: cur[k] ?? null }))
    .filter((r) => r.prev || r.cur)
    .map((r) => ({ ...r, differs: !!r.prev && !!r.cur && norm(r.prev) !== norm(r.cur) }));
  const diffs = rows.filter((r) => r.differs).length;
  const prevSeasons = memory.seasons.map((x) => x.name).filter((x): x is string => !!x);
  const curSeasons = (brief?.seasons_detail ?? []).map((x) => x.name).filter((x): x is string => !!x);
  const curProducts = brief?.row_plan?.categories.length ?? brief?.product_categories.length ?? null;
  const date = new Date(memory.processedAt);
  const when = Number.isNaN(date.getTime())
    ? memory.processedAt
    : date.toLocaleDateString("es-CR", { year: "numeric", month: "short", day: "numeric" });

  return (
    <div className="rounded-xl border border-border bg-secondary/20 px-4 py-3 space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-foreground">
          <History className="h-4 w-4 text-primary" />
          Memoria del proveedor
          <span className="font-normal text-muted-foreground">
            · último contrato aprobado {when} ({memory.rowCount} filas)
          </span>
        </span>
        <span className="flex items-center gap-2 text-[11.5px]">
          <span className={diffs > 0 ? "text-amber-400" : "text-muted-foreground"}>
            {diffs > 0 ? `${diffs} diferencia(s)` : "sin diferencias"}
          </span>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {open && (
        <div className="space-y-2 text-[12px]">
          <p className="text-[11.5px] text-muted-foreground">
            Referencia, no verdad: el contrato actual manda. Las diferencias sólo indican qué
            conviene mirar dos veces. Estos valores también viajan al modelo como contexto de
            prioridad media.
          </p>
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {rows.map((r) => (
              <div key={r.k} className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1">
                <span className="text-muted-foreground">{r.label}</span>
                <span className={`text-right ${r.differs ? "text-amber-200" : "text-foreground"}`}>
                  {r.differs ? (
                    <>
                      <span className="line-through opacity-60">{r.prev}</span> → {r.cur}
                    </>
                  ) : (
                    (r.cur ?? r.prev)
                  )}
                </span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
            <span>
              Temporadas antes: <span className="text-foreground">{prevSeasons.join(", ") || "—"}</span>
              {" · "}ahora: <span className="text-foreground">{curSeasons.join(", ") || "—"}</span>
            </span>
            <span>
              Productos antes: <span className="text-foreground">{memory.products.length}</span>
              {" · "}ahora: <span className="text-foreground">{curProducts ?? "—"}</span>
            </span>
            {memory.occupancies.length > 0 && (
              <span>
                Ocupaciones antes: <span className="text-foreground">{memory.occupancies.join(", ")}</span>
              </span>
            )}
            {memory.codigosServicio.length > 0 && (
              <span>
                Códigos de servicio antes: <span className="text-foreground">{memory.codigosServicio.join(", ")}</span>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export type CatalogMatchInfo =
  | {
      status: "matched";
      supplierName: string;
      supplierCode: string;
      matchedBy: SupplierMatch["matchedBy"];
      serviceMatched: boolean;
      aiConfidence?: SupplierMatch["aiConfidence"];
      aiReasoning?: string;
    }
  | { status: "not_found"; query: string; aiAttempted: boolean }
  | { status: "skipped"; reason: "new_supplier" | "no_query" };

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Mirrors `MAX_UPLOAD_FILES` in the backend `uploadMiddleware`. Kept in sync
 * manually — if the backend raises this, bump it here too.
 */
const MAX_FILES_PER_REQUEST = 10;

const STEP2_ANALYSIS_FOOTER =
  "Corre en dos fases: un pre-análisis rápido (Sonnet 5.5) que detecta las reglas " +
  "globales y luego la extracción completa que consolida todos los documentos. " +
  "Puede tardar varios minutos — mantené esta pestaña abierta.";

const STEP3_EXTRACT_FOOTER =
  "Extrayendo y estructurando todas las tarifas del contrato. El modelo está generando " +
  "cada combinación de habitación × temporada × ocupación. Puede tardar varios minutos " +
  "con contratos extensos — mantené esta pestaña abierta.";

const STEP3_RENDER_FOOTER =
  "Preparando la tabla con todas las filas generadas. Esto puede tomar unos segundos " +
  "según la cantidad de combinaciones — ya casi está listo.";

const ACCEPT_ATTR = [
  "application/pdf",
  ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".docx",
  "application/msword",
  ".doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsx",
  "application/vnd.ms-excel",
  ".xls",
  // Imágenes — Claude las lee nativamente con vision. Las
  // extensiones se incluyen además del MIME porque algunos sistemas
  // (notablemente Windows arrastrando desde el escritorio) suben con
  // MIME genérico application/octet-stream y nos quedamos sin señal.
  "image/jpeg",
  ".jpg",
  ".jpeg",
  "image/png",
  ".png",
  "image/gif",
  ".gif",
  "image/webp",
  ".webp",
].join(",");

const STEPS: { id: Step; label: string; hint: string }[] = [
  {
    id: 1,
    label: "Cargar documento",
    hint: "PDF, Word, Excel o imagen · máx 20 MB",
  },
  {
    id: 2,
    label: "Variables de configuración",
    hint: "Confirma IVA, comisión, temporadas…",
  },
  { id: 3, label: "Revisar información", hint: "Tabla con todas las filas" },
  { id: 4, label: "Descargar xlsx", hint: "Genera el archivo final" },
];

function inferKind(mime: string, name: string): FileKind | null {
  const lower = name.toLowerCase();
  // Match the extension as a token, not just at the end of the string. The
  // backend's `meta.filename` can be a combined display string like
  // `contrato.pdf (+2 más)` when multiple documents were uploaded; that still
  // needs to resolve to a kind so step 3 can persist the run with the right
  // file_kind. We anchor on `.ext` followed by a non-letter (word boundary,
  // space, end-of-string) so `.pdf2026` doesn't get mistaken for a PDF.
  if (mime === "application/pdf" || /\.pdf(\b|$|[^a-z])/i.test(lower)) {
    return "pdf";
  }
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword" ||
    /\.docx?(\b|$|[^a-z])/i.test(lower)
  ) {
    return "docx";
  }
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    /\.xlsx?(\b|$|[^a-z])/i.test(lower)
  ) {
    return "xlsx";
  }
  // Imágenes — todas comparten un único `file_kind = "image"` para no
  // explosionar el universo de tipos en BD. El media_type específico
  // (jpeg vs png vs …) lo resuelve el backend desde el MIME del upload.
  if (
    mime.startsWith("image/") ||
    /\.(jpe?g|png|gif|webp)(\b|$|[^a-z])/i.test(lower)
  ) {
    return "image";
  }
  return null;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Copia un `File` del picker/drop a memoria. Tras varios minutos en Paso 2,
 * algunos browsers invalidan la referencia original y el Paso 3 falla al
 * re-subir el mismo archivo ("Failed to fetch" / NotReadableError).
 */
async function materializeUploadFile(file: File): Promise<File> {
  const buffer = await file.arrayBuffer();
  return new File([buffer], file.name, {
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified,
  });
}

async function materializeUploadFiles(files: File[]): Promise<File[]> {
  return Promise.all(files.map(materializeUploadFile));
}

function fileIcon(kind: FileKind) {
  if (kind === "xlsx")
    return <FileSpreadsheet className="w-4 h-4 text-emerald-300" />;
  if (kind === "docx") return <FileText className="w-4 h-4 text-sky-300" />;
  if (kind === "image") return <ImageIcon className="w-4 h-4 text-violet-300" />;
  return <FileText className="w-4 h-4 text-amber-300" />;
}

/* ============================================================================
   SUPPLIER WORKFLOW (orchestrator)
   ========================================================================== */

export interface ApprovedPayload {
  sharedFields: ExtractedSharedFields;
  rows: ExtractedContractRow[];
  catalogPrefill: GenerateXlsxCatalogPrefill | null;
  manualFields: GenerateXlsxManualFields | null;
  /** Señal de aprendizaje del run (diffs IA → aprobado, QA, respuestas). */
  feedback: RunFeedback | null;
}

export function SupplierWorkflow() {
  const { session } = useAuth();
  const isAdmin = session?.user.role === "admin";
  const [step, setStep] = useState<Step>(1);
  /**
   * Documentos del contrato, todos pares. Internamente el primero vive en
   * `primaryFile` y el resto en `secondaryFiles` porque el flujo (brief por
   * documento, nombre del run en el historial) está escrito sobre esa forma;
   * la UI muestra una sola lista y el orden sólo da nombre al run.
   */
  const [primaryFile, setPrimaryFile] = useState<File | null>(null);
  const [secondaryFiles, setSecondaryFiles] = useState<File[]>([]);
  const selectedFiles = useMemo(
    () => (primaryFile ? [primaryFile, ...secondaryFiles] : []),
    [primaryFile, secondaryFiles],
  );
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<ExtractContractResponse | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Variables de Configuración detectadas en la Fase 1 (step 1 → 2) — UNA por
   * documento (flujo multi-documento). `briefs` es la salida de la IA (se
   * reemplaza al re-analizar); `editedBriefs` son los drafts vivos que el
   * usuario edita en cada tab (se envían a la extracción). `metas` guarda
   * filename/model/etc. por documento. `briefVersions` fuerza el remount del
   * editor cuando la IA reemplaza un brief tras un refine.
   */
  const [briefs, setBriefs] = useState<ContractConfigVariables[]>([]);
  const [editedBriefs, setEditedBriefs] = useState<ContractConfigVariables[]>(
    [],
  );
  const [metas, setMetas] = useState<AnalyzeBriefMeta[]>([]);
  const [chatHistories, setChatHistories] = useState<BriefChatMessage[][]>([]);
  const [briefVersions, setBriefVersions] = useState<number[]>([]);
  const [fileLabels, setFileLabels] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  /** True mientras corre la extracción principal disparada desde el step 2. */
  const [extracting, setExtracting] = useState(false);
  const [preparingGrid, setPreparingGrid] = useState(false);
  /** Índice del tab que Opus está re-analizando (null = ninguno). */
  const [refiningTab, setRefiningTab] = useState<number | null>(null);

  /** Actualiza el draft vivo del documento `i` sin perder los de otros tabs. */
  const handleDraftChange = useCallback(
    (i: number, edited: ContractConfigVariables) => {
      setEditedBriefs((prev) => {
        if (prev[i] === edited) return prev;
        const next = [...prev];
        next[i] = edited;
        return next;
      });
    },
    [],
  );

  const [comments, setComments] = useState("");
  const [supplierChoice, setSupplierChoice] = useState<SupplierChoice | null>(
    null,
  );
  const isExistingSupplier =
    supplierChoice === null ? null : supplierChoice.existing;

  /**
   * Pre-scan determinístico (sin IA) del contrato primario. Arranca en cuanto
   * hay archivo, se cancela si cambia, y con confianza "alta" pre-selecciona
   * el proveedor en el dropdown (marcado como detectado) si el usuario aún no
   * eligió nada. Con "media" sólo sugiere.
   */
  const [preScan, setPreScan] = useState<PreScanState>({ status: "idle" });
  const [autoDetectedId, setAutoDetectedId] = useState<string | null>(null);
  /** Proveedor confirmado (con servicios) — ancla del QA y del prompt. */
  const [confirmedSupplier, setConfirmedSupplier] = useState<CatalogSupplier | null>(null);
  /** Memoria del proveedor: último run aprobado (Paso 2 + hints). */
  const [supplierMemory, setSupplierMemory] = useState<SupplierMemory | null>(null);
  /** Respuestas del revisor a las preguntas del QA (optionId o "skip"). */
  const [qaAnswers, setQaAnswers] = useState<Record<string, string>>({});
  /** Tema/obligatoriedad de cada pregunta respondida (la pregunta desaparece al responder). */
  const [qaMeta, setQaMeta] = useState<Record<string, { topic: string; required: boolean }>>({});
  /** Briefs tal como los devolvió la IA (antes del relleno del pre-scan y de ediciones). */
  const [aiBriefs, setAiBriefs] = useState<ContractConfigVariables[]>([]);
  /** Claves que el pre-scan rellenó porque la IA las dejó vacías. */
  const [prescanFilled, setPrescanFilled] = useState<string[]>([]);
  /** Cantidad de reglas permanentes activas (para el feedback). */
  const [agencyRuleCount, setAgencyRuleCount] = useState(0);
  /** Feedback parcial construido al confirmar el Paso 2. */
  const [feedbackBase, setFeedbackBase] = useState<FeedbackBase | null>(null);
  /** Instrucciones derivadas de las respuestas; viajan a la extracción. */
  const [qaResolutions, setQaResolutions] = useState<
    Record<string, { title: string; instruction: string }>
  >({});

  /**
   * QA determinístico del brief (Paso 2). Se recalcula con cada edición: al
   * responder una pregunta el brief cambia y la pregunta desaparece sola.
   */
  const briefQa = useMemo<BriefQaResult>(() => {
    const b = editedBriefs[0] ?? briefs[0];
    if (!b) return { findings: [], questions: [] };
    return qaBrief({
      brief: b,
      scan: preScan.status === "done" ? preScan.result : null,
      supplier: confirmedSupplier,
      comments,
    });
  }, [editedBriefs, briefs, preScan, confirmedSupplier, comments]);
  const pendingRequired = briefQa.questions.filter(
    (q) => q.required && qaAnswers[q.id] === undefined,
  );

  const answerQuestion = (q: QaQuestion, o: QaOption) => {
    const base = editedBriefs[0] ?? briefs[0];
    if (base && o.patch) {
      const patched =
        typeof o.patch === "function" ? o.patch(base) : { ...base, ...o.patch };
      handleDraftChange(0, patched);
    }
    setQaAnswers((prev) => ({ ...prev, [q.id]: o.id }));
    setQaMeta((prev) => ({ ...prev, [q.id]: { topic: q.topic, required: q.required } }));
    setQaResolutions((prev) => ({ ...prev, [q.id]: { title: q.title, instruction: o.instruction } }));
  };
  const skipQuestion = (q: QaQuestion) => {
    setQaAnswers((prev) => ({ ...prev, [q.id]: "skip" }));
    setQaMeta((prev) => ({ ...prev, [q.id]: { topic: q.topic, required: q.required } }));
  };
  const undoAnswer = (id: string) => {
    setQaAnswers((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setQaResolutions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };
  /** Hechos verificados que viajan a brief / refine / extract. */
  const [preScanHints, setPreScanHints] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!primaryFile) return;
    const controller = new AbortController();
    const files = [primaryFile, ...secondaryFiles];
    // Debounce corto: al soltar 3 archivos seguidos queremos UN request con
    // los 3, no tres requests. También evita un setState síncrono en el effect.
    const t = window.setTimeout(() => {
      setPreScan({ status: "loading" });
      api.supplierIntelligence
        .preScan(files, { signal: controller.signal })
        .then(({ scan }) => {
          if (controller.signal.aborted) return;
          setPreScan({ status: "done", result: scan });
          const top = scan.supplier.candidates[0];
          if (top && scan.supplier.confidence === "alta") {
            // Sólo rellenamos si el usuario no eligió nada todavía; el
            // updater funcional evita leer estado viejo desde el closure.
            setSupplierChoice((prev) =>
              prev === null ? { existing: true, supplier: candidateToSupplier(top) } : prev,
            );
            setAutoDetectedId(top.id);
          }
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setPreScan({
            status: "error",
            message: describeRequestFailure(
              err,
              "No pudimos analizar el documento. Puedes continuar normalmente.",
            ),
          });
        });
    }, 350);
    return () => {
      window.clearTimeout(t);
      controller.abort();
    };
  }, [primaryFile, secondaryFiles]);

  const chooseSupplier = (next: SupplierChoice) => {
    setSupplierChoice(next);
    setAutoDetectedId(null);
  };
  const [catalogPrefill, setCatalogPrefill] = useState<CatalogPrefill | null>(
    null,
  );
  const [, setCatalogMatchInfo] = useState<CatalogMatchInfo | null>(null);
  const [matchingPhase, setMatchingPhase] = useState<"local" | "ai" | null>(
    null,
  );

  const [approvedPayload, setApprovedPayload] = useState<ApprovedPayload | null>(
    null,
  );

  useEffect(() => {
    if (!analyzing && !extracting) return;
    const id = window.setInterval(() => {
      setProgress((p) => {
        if (p >= 90) return p;
        const step = Math.max(0.4, (90 - p) * 0.06);
        return Math.min(90, p + step);
      });
    }, 180);
    return () => window.clearInterval(id);
  }, [analyzing, extracting]);

  useEffect(() => {
    if (!preparingGrid) return;
    // Primer tick inmediato (salto a 15%) y luego avance suave hasta 92%.
    const kick = window.setTimeout(() => setProgress(15), 0);
    const id = window.setInterval(() => {
      setProgress((p) => (p >= 92 ? p : Math.min(92, p + 6)));
    }, 120);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(id);
    };
  }, [preparingGrid]);

  /**
   * Valida archivos entrantes contra formato, tamaño y duplicados.
   */
  const validateIncomingFiles = (
    incoming: File[],
    seen: Set<string>,
    maxToAccept: number,
    limitMessage: string,
  ): { accepted: File[]; errors: string[] } => {
    const accepted: File[] = [];
    const errors: string[] = [];

    for (const file of incoming) {
      if (accepted.length >= maxToAccept) {
        errors.push(`${limitMessage} — se descartó "${file.name}".`);
        continue;
      }
      const kind = inferKind(file.type, file.name);
      if (!kind) {
        errors.push(
          `${file.name}: formato no admitido. Usa PDF, Word, Excel o imagen (JPG/PNG/GIF/WebP).`,
        );
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        errors.push(
          `${file.name}: excede el límite de 20 MB (${humanSize(file.size)}).`,
        );
        continue;
      }
      const key = `${file.name}|${file.size}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      accepted.push(file);
    }

    return { accepted, errors };
  };

  const buildSeenKeys = (): Set<string> => {
    const seen = new Set<string>();
    if (primaryFile) seen.add(`${primaryFile.name}|${primaryFile.size}`);
    for (const f of secondaryFiles) seen.add(`${f.name}|${f.size}`);
    return seen;
  };

  /**
   * Una sola zona de carga: los documentos son pares (tarifario, políticas,
   * anexos…). Internamente seguimos guardando `primaryFile` + `secondaryFiles`
   * porque el resto del flujo (briefs por documento, nombre del run en el
   * historial) está escrito sobre esa forma; el primer archivo de la lista
   * ocupa el slot "primary" y nada más depende de ello.
   */
  const acceptFiles = async (incoming: FileList | File[]) => {
    setServerError(null);
    const list = Array.from(incoming);
    if (list.length === 0) {
      setUploadError(null);
      return;
    }
    const slotsLeft = MAX_FILES_PER_REQUEST - selectedFiles.length;
    if (slotsLeft <= 0) {
      setUploadError(
        `Máximo ${MAX_FILES_PER_REQUEST} documentos por contrato — quita alguno para agregar más.`,
      );
      return;
    }
    const seen = buildSeenKeys();
    const { accepted, errors } = validateIncomingFiles(
      list,
      seen,
      slotsLeft,
      `Máximo ${MAX_FILES_PER_REQUEST} documentos por contrato`,
    );
    setUploadError(errors.length > 0 ? errors.join(" ") : null);
    if (accepted.length === 0) return;
    try {
      const persisted = await materializeUploadFiles(accepted);
      if (!primaryFile) {
        setPrimaryFile(persisted[0]!);
        setSecondaryFiles((prev) => [...prev, ...persisted.slice(1)]);
      } else {
        setSecondaryFiles((prev) => [...prev, ...persisted]);
      }
    } catch (err) {
      setUploadError(
        describeRequestFailure(
          err,
          "No se pudieron leer uno o más archivos. Intenta seleccionarlos de nuevo.",
        ),
      );
    }
  };

  const handleFilesDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    void acceptFiles(Array.from(files));
  };

  const handleFilesPick = (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    e.target.value = "";
    void acceptFiles(files);
  };

  /** Quita el proveedor auto-detectado cuando cambia el conjunto de archivos. */
  const forgetAutoDetection = () => {
    setPreScan({ status: "idle" });
    if (
      autoDetectedId !== null &&
      supplierChoice?.existing === true &&
      supplierChoice.supplier.id === autoDetectedId
    ) {
      setSupplierChoice(null);
    }
    setAutoDetectedId(null);
  };

  /** Índice sobre la lista combinada (0 = slot primary). */
  const removeFileAt = (index: number) => {
    setUploadError(null);
    setServerError(null);
    if (index === 0) {
      // El siguiente documento pasa a ocupar el slot primary.
      const [next, ...rest] = secondaryFiles;
      setPrimaryFile(next ?? null);
      setSecondaryFiles(rest);
    } else {
      setSecondaryFiles((prev) => prev.filter((_, i) => i !== index - 1));
    }
    forgetAutoDetection();
  };

  const clearAllFiles = () => {
    setPrimaryFile(null);
    setSecondaryFiles([]);
    setUploadError(null);
    setServerError(null);
    forgetAutoDetection();
  };

  /**
   * Step 1 → 2: corre la Fase 1 (pre-análisis) Y el matching contra el catálogo
   * lista-proveedores, de modo que el step 2 pueda mostrar TODO lo compartido —
   * identidad del proveedor + reglas globales + clasificación de catálogo
   * (Tipo Actividad, Zona Turismo, Proveedor código). El matching usa el nombre
   * del proveedor que trae el brief; el hint de servicio usa el inventario de
   * categorías del brief (todavía no hay filas).
   */
  const startAnalysis = async () => {
    if (!primaryFile || analyzing || isExistingSupplier === null) {
      return;
    }
    setAnalyzing(true);
    setServerError(null);
    setProgress(4);
    resetConfigState();
    setStep(2);
    try {
      const files = selectedFiles;

      // Proveedor confirmado con sus servicios (el dropdown trae el catálogo
      // resumido) — lo necesitamos ANTES del brief para que viaje como ancla.
      let confirmedSupplier: CatalogSupplier | null = null;
      let memory: SupplierMemory | null = null;
      if (supplierChoice?.existing) {
        confirmedSupplier = supplierChoice.supplier;
        try {
          confirmedSupplier = await withServices(confirmedSupplier);
        } catch (err) {
          console.warn("[workflow] no se pudieron cargar los servicios del proveedor", err);
        }
        // Memoria del proveedor: lo aprobado la última vez. Opcional — si
        // falla seguimos sin ella.
        try {
          memory = (await api.supplierIntelligence.lastRun(confirmedSupplier.codigo)).memory;
        } catch (err) {
          console.warn("[workflow] no se pudo cargar la memoria del proveedor", err);
        }
      }
      setConfirmedSupplier(confirmedSupplier);
      setSupplierMemory(memory);
      // Sólo para el feedback (cuántas reglas estaban activas). No bloquea.
      api.agentRules
        .list()
        .then(({ rules }) => setAgencyRuleCount(rules.filter((r) => r.enabled).length))
        .catch(() => setAgencyRuleCount(0));
      const hints = buildPreScanHints(
        preScan.status === "done" ? preScan.result : null,
        confirmedSupplier,
        memory,
      );
      setPreScanHints(hints);

      const responses: Awaited<ReturnType<typeof api.supplierIntelligence.analyzeBrief>>[] = [];
      for (const f of files) {
        responses.push(
          await api.supplierIntelligence.analyzeBrief([f], {
            comments,
            isExistingSupplier,
            preScanHints: hints,
          }),
        );
      }
      setProgress(100);

      // El documento PRIMARIO (primero) maneja el matching contra el catálogo.
      const brief = responses[0]!.brief;
      let prefill: CatalogPrefill | null = null;
      let matchInfo: CatalogMatchInfo | null = null;
      if (confirmedSupplier) {
        // El proveedor viene elegido a mano en el Paso 1 — no hay que
        // adivinarlo por nombre. Solo resolvemos el servicio.
        setMatchingPhase("local");
        const chosen = confirmedSupplier;
        const match: SupplierMatch = {
          supplier: chosen,
          matchedBy: "manual",
          query: chosen.nombre ?? chosen.codigo,
        };

        // Hint de servicio desde el BRIEF (no hay filas todavía en este
        // punto del flujo gated): usamos el inventario de categorías de
        // producto + país + moneda como señal para elegir entre los
        // servicios del proveedor.
        const dedupe = (xs: Array<string | null>, cap: number): string[] =>
          Array.from(
            new Set(xs.filter((s): s is string => !!s && s.trim() !== "")),
          ).slice(0, cap);
        const categorias = dedupe(brief.product_categories, 8);
        const hintParts = [
          brief.shared_fields.nombre_comercial
            ? `Proveedor: ${brief.shared_fields.nombre_comercial}`
            : null,
          brief.shared_fields.type_of_business
            ? `Tipo negocio: ${brief.shared_fields.type_of_business}`
            : null,
          categorias.length > 0
            ? `Categorías/Productos: ${categorias.join(", ")}`
            : null,
          brief.currency ? `Moneda: ${brief.currency}` : null,
          brief.shared_fields.pais
            ? `País proveedor: ${brief.shared_fields.pais}`
            : null,
          comments?.trim() ? `Notas: ${comments.trim()}` : null,
          selectedFiles[0]?.name
            ? `Archivo: ${selectedFiles[0].name}` +
              (selectedFiles.length > 1
                ? ` (+${selectedFiles.length - 1} más)`
                : "")
            : null,
        ].filter((s): s is string => s !== null);
        const serviceHint = hintParts.join(" · ");

        setMatchingPhase("ai");
        const serviceMatch = await findServiceForSupplierWithAI(
          match.supplier,
          serviceHint,
          { enableAIFallback: true },
        );
        setMatchingPhase(null);

        // Actividad/zona: las del servicio elegido cuando las tiene (varios
        // proveedores mezclan hotel + tours + transporte), si no, las del
        // proveedor (el valor más frecuente en el maestro).
        const svc = serviceMatch?.service ?? null;
        prefill = {
          tipo_actividad: svc?.actividad ?? match.supplier.actividad,
          zona_turismo: svc?.zona ?? match.supplier.zona,
          proveedor_codigo: match.supplier.codigo,
          codigo_servicio: svc?.codigo ?? null,
        };
        matchInfo = {
          status: "matched",
          supplierName: match.supplier.nombre ?? match.supplier.codigo,
          supplierCode: match.supplier.codigo,
          matchedBy: match.matchedBy,
          serviceMatched: serviceMatch !== null,
        };
      } else {
        matchInfo = { status: "skipped", reason: "new_supplier" };
      }
      setCatalogPrefill(prefill);
      setCatalogMatchInfo(matchInfo);

      await new Promise((r) => setTimeout(r, 300));
      // Fusiona bancos/políticas de docs secundarios (T&C) en el brief primario
      // para que el Paso 2 no quede vacío (caso Lapa Rios rates + TC).
      const rawBriefs = responses.map((r) => r.brief);
      const merged = mergeSecondaryBriefIntoPrimary(rawBriefs);
      // Pre-scan (sin IA) rellena huecos del brief primario y avisa si la
      // IA contradice lo que el documento dice literalmente.
      let newBriefs = merged;
      let filled: string[] = [];
      if (preScan.status === "done" && merged[0]) {
        const rec = reconcileBriefWithPreScan(merged[0], preScan.result);
        filled = diffFlat(flattenBrief(merged[0]), flattenBrief(rec), "brief").map((c) => c.field);
        newBriefs = [rec, ...merged.slice(1)];
      }
      setAiBriefs(merged);
      setPrescanFilled(filled);
      setBriefs(newBriefs);
      setEditedBriefs(newBriefs.map((b) => b));
      setMetas(responses.map((r) => r.meta));
      setChatHistories(newBriefs.map(() => []));
      setBriefVersions(newBriefs.map(() => 0));
      setFileLabels(files.map((f) => f.name));
      setActiveTab(0);
    } catch (err) {
      setServerError(
        describeRequestFailure(
          err,
          "No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.",
        ),
      );
      setProgress(0);
    } finally {
      setAnalyzing(false);
      setMatchingPhase(null);
    }
  };

  /** Sincroniza `seasons` (nombres) con `seasons_detail` antes de extraer. */
  const normalizeBrief = (
    b: ContractConfigVariables,
  ): ContractConfigVariables => {
    const seasonNames = b.seasons_detail
      .map((s) => s.name?.trim())
      .filter((s): s is string => !!s);
    return {
      ...b,
      seasons: seasonNames.length > 0 ? seasonNames : b.seasons,
    };
  };

  /**
   * Paso 2 — chat: re-analiza el brief del documento `tabIndex` con Opus según
   * el feedback del usuario. Cada documento tiene su propio historial.
   */
  const refineConfig = async (tabIndex: number, message: string) => {
    const file = selectedFiles[tabIndex];
    const prevBrief = editedBriefs[tabIndex] ?? briefs[tabIndex];
    if (
      !file ||
      !prevBrief ||
      refiningTab !== null ||
      extracting ||
      isExistingSupplier === null
    ) {
      return;
    }
    const userMsg = message.trim();
    if (!userMsg) return;

    setRefiningTab(tabIndex);
    setServerError(null);
    setChatHistories((prev) => {
      const next = [...prev];
      next[tabIndex] = [...(next[tabIndex] ?? []), { role: "user", content: userMsg }];
      return next;
    });

    try {
      const response = await api.supplierIntelligence.refineBrief([file], {
        comments,
        isExistingSupplier,
        preScanHints,
        previousBrief: prevBrief,
        feedbackMessage: userMsg,
        chatHistory: chatHistories[tabIndex] ?? [],
      });
      setBriefs((prev) => {
        const next = [...prev];
        next[tabIndex] = response.brief;
        return next;
      });
      setEditedBriefs((prev) => {
        const next = [...prev];
        next[tabIndex] = response.brief;
        return next;
      });
      setBriefVersions((prev) => {
        const next = [...prev];
        next[tabIndex] = (next[tabIndex] ?? 0) + 1;
        return next;
      });
      setMetas((prev) => {
        const next = [...prev];
        const cur = next[tabIndex];
        next[tabIndex] = cur
          ? {
              ...cur,
              model: response.meta.model,
              processed_at: response.meta.processed_at,
              input_tokens: response.meta.input_tokens,
              output_tokens: response.meta.output_tokens,
              cost_usd: response.meta.cost_usd,
            }
          : response.meta;
        return next;
      });
      const assistantReply =
        response.brief.logic_summary?.trim() ||
        "Actualicé el análisis según tus correcciones.";
      setChatHistories((prev) => {
        const next = [...prev];
        next[tabIndex] = [
          ...(next[tabIndex] ?? []),
          { role: "assistant", content: assistantReply },
        ];
        return next;
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setServerError(err.message);
      } else {
        setServerError(
          "No pudimos reanalizar el documento. Revisa tu conexión e intenta de nuevo.",
        );
      }
    } finally {
      setRefiningTab(null);
    }
  };

  const handleGridReady = useCallback(() => {
    setProgress(100);
    setPreparingGrid(false);
  }, []);

  /**
   * Step 2 → 3: el usuario confirmó TODOS los briefs (uno por documento).
   * Corremos la extracción enviando el array de briefs validados; el backend
   * salta la Fase 1, consolida los documentos en un único conjunto de filas y
   * pasamos a la revisión de la grilla.
   */
  const confirmConfig = async () => {
    if (
      extracting ||
      preparingGrid ||
      refiningTab !== null ||
      isExistingSupplier === null ||
      briefs.length === 0
    ) {
      return;
    }
    if (!primaryFile) {
      setStep(3);
      setServerError(
        "Los documentos ya no están disponibles en esta sesión. Volvé al Paso 1 y cargá los archivos de nuevo.",
      );
      return;
    }
    if (pendingRequired.length > 0) {
      setServerError(
        `Responde u omite las ${pendingRequired.length} pregunta(s) obligatoria(s) antes de extraer.`,
      );
      return;
    }
    const source = briefs.map((b, i) => editedBriefs[i] ?? b);
    const finalBriefs = source.map(normalizeBrief);
    setEditedBriefs(finalBriefs);
    // Señal de aprendizaje del Paso 1 + 2: qué detectó el pre-scan, qué
    // corrigió la persona sobre el brief de la IA, qué preguntó el QA.
    {
      const scan = preScan.status === "done" ? preScan.result : null;
      const detectedTop = scan?.supplier.candidates[0] ?? null;
      const chosen = supplierChoice?.existing ? supplierChoice.supplier.codigo : null;
      const ai0 = aiBriefs[0];
      const fin0 = finalBriefs[0];
      setFeedbackBase({
        pre_scan: {
          ran: !!scan,
          text_available: !!scan && scan.documents.some((d) => d.textAvailable),
          documents: scan?.documents.length ?? selectedFiles.length,
          detected: detectedTop ? { codigo: detectedTop.codigo, confidence: scan!.supplier.confidence } : null,
          chosen,
          supplier_hit: detectedTop && chosen ? detectedTop.codigo === chosen : null,
        },
        brief:
          ai0 && fin0
            ? {
                corrections: diffFlat(flattenBrief(ai0), flattenBrief(fin0), "brief", new Set(prescanFilled)),
                prescan_filled: prescanFilled,
                qa_findings: briefQa.findings.map((f) => ({ id: f.id, severity: f.severity, topic: f.topic })),
                questions: Object.entries(qaAnswers).map(([id, answer]) => ({
                  id,
                  topic: qaMeta[id]?.topic ?? "other",
                  required: qaMeta[id]?.required ?? false,
                  answer,
                })),
                chat_messages: chatHistories.reduce((n, h) => n + h.filter((m) => m.role === "user").length, 0),
              }
            : null,
        comments_chars: comments.trim().length,
        agency_rules: agencyRuleCount,
      });
    }
    // Las respuestas del revisor viajan como instrucciones del usuario: en el
    // prompt tienen la misma prioridad que los comentarios del Paso 1.
    const resolutionTexts = Object.values(qaResolutions).map((r) => r.instruction);
    const extractComments = [
      comments.trim(),
      resolutionTexts.length > 0
        ? "RESOLUCIONES DEL REVISOR (Paso 2 — aplicar tal cual):\n" +
          resolutionTexts.map((t) => `- ${t}`).join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    setExtracting(true);
    setPreparingGrid(false);
    setServerError(null);
    setProgress(4);
    setResult(null);
    setStep(3);
    try {
      const filesToExtract = await materializeUploadFiles(selectedFiles);
      const response = await api.supplierIntelligence.extract(filesToExtract, {
        comments: extractComments,
        isExistingSupplier,
        preScanHints,
        confirmedConfigs: finalBriefs,
      });
      setProgress(100);
      // One idempotency key per extraction: every xlsx download of this
      // result (Paso 3 "Descargar aquí", Paso 4 auto-download, re-clicks)
      // saves against the same key, so Historial and the dashboard count
      // the contract exactly once.
      setResult({
        ...response,
        meta: { ...response.meta, extraction_id: newExtractionId() },
      });
      setPreparingGrid(true);
    } catch (err) {
      setServerError(
        describeRequestFailure(
          err,
          "No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.",
        ),
      );
      setProgress(0);
    } finally {
      setExtracting(false);
    }
  };

  const resetConfigState = () => {
    setBriefs([]);
    setEditedBriefs([]);
    setMetas([]);
    setChatHistories([]);
    setBriefVersions([]);
    setFileLabels([]);
    setActiveTab(0);
    setRefiningTab(null);
    setQaAnswers({});
    setQaMeta({});
    setQaResolutions({});
    setAiBriefs([]);
    setPrescanFilled([]);
    setFeedbackBase(null);
  };

  const reset = () => {
    setStep(1);
    setPrimaryFile(null);
    setSecondaryFiles([]);
    setResult(null);
    setUploadError(null);
    setServerError(null);
    setProgress(0);
    setComments("");
    setSupplierChoice(null);
    setPreScan({ status: "idle" });
    setAutoDetectedId(null);
    setPreScanHints(null);
    setConfirmedSupplier(null);
    setSupplierMemory(null);
    setCatalogPrefill(null);
    setCatalogMatchInfo(null);
    setMatchingPhase(null);
    setApprovedPayload(null);
    setExtracting(false);
    setPreparingGrid(false);
    resetConfigState();
  };

  /** Step 3 ← error o volver: regresa al Paso 2 conservando briefs y archivos. */
  const backToConfig = () => {
    setStep(2);
    setServerError(null);
    setProgress(0);
    setExtracting(false);
    setPreparingGrid(false);
    setResult(null);
  };

  /** Step 2 ← 1: volver del config a la carga sin perder los archivos. */
  const backToUpload = () => {
    setStep(1);
    setServerError(null);
    setProgress(0);
    resetConfigState();
  };

  const approve = (payload: ApprovedPayload) => {
    setApprovedPayload(payload);
    setStep(4);
  };

  return (
    <>
      <section className="relative overflow-hidden rounded-2xl border border-border bg-card/80 shadow-[0_1px_0_0_hsl(var(--primary)/0.08)_inset]">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-20 left-1/2 h-56 w-[70%] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
        />

      <div className="relative px-5 sm:px-8 pt-6 pb-5 border-b border-border">
        <ol className="flex items-center justify-between gap-2">
          {STEPS.map((s, i) => {
            const state: "complete" | "current" | "upcoming" =
              step > s.id ? "complete" : step === s.id ? "current" : "upcoming";
            return (
              <li
                key={s.id}
                className="flex-1 flex items-center"
                aria-current={state === "current" ? "step" : undefined}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-8 h-8 rounded-full border flex items-center justify-center text-[12.5px] font-semibold shrink-0 transition-colors ${
                      state === "complete"
                        ? "bg-primary text-primary-foreground border-primary shadow-[0_0_14px_0_hsl(var(--primary)/0.35)]"
                        : state === "current"
                          ? "bg-primary/15 text-primary border-primary/50 animate-pulse-glow"
                          : "bg-secondary/50 text-muted-foreground border-border"
                    }`}
                  >
                    {state === "complete" ? <Check className="w-4 h-4" /> : s.id}
                  </div>
                  <div className="hidden sm:block min-w-0">
                    <p
                      className={`text-[13px] font-semibold truncate ${
                        state === "upcoming"
                          ? "text-muted-foreground"
                          : "text-foreground"
                      }`}
                    >
                      {s.label}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {s.hint}
                    </p>
                  </div>
                </div>
                {i < STEPS.length - 1 && (
                  <div
                    aria-hidden
                    className={`flex-1 h-px mx-3 sm:mx-4 transition-colors ${
                      step > s.id ? "bg-primary/50" : "bg-border"
                    }`}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <div key={step} className="animate-page-enter">
        {step === 1 && (
          <UploadStep
            files={selectedFiles}
            uploadError={uploadError}
            serverError={serverError}
            analyzing={analyzing}
            fileInputRef={fileInputRef}
            comments={comments}
            onCommentsChange={setComments}
            supplierChoice={supplierChoice}
            onSupplierChoiceChange={chooseSupplier}
            preScan={preScan}
            autoDetectedId={autoDetectedId}
            onDrop={handleFilesDrop}
            onPick={handleFilesPick}
            onRemove={removeFileAt}
            onClearAll={clearAllFiles}
            onStart={startAnalysis}
          />
        )}

        {step === 2 && analyzing && briefs.length === 0 && (
          <div className="px-5 sm:px-8 py-7">
            <AnalysisProgressCard
              files={selectedFiles}
              totalBytes={selectedFiles.reduce((acc, f) => acc + f.size, 0)}
              progress={progress}
              matchingPhase={matchingPhase}
              footerDescription={STEP2_ANALYSIS_FOOTER}
            />
          </div>
        )}

        {step === 2 && !analyzing && briefs.length === 0 && serverError && (
          <div className="px-5 sm:px-8 py-7 space-y-4">
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{serverError}</span>
            </div>
            <button
              type="button"
              onClick={backToUpload}
              className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-border bg-secondary/40 text-[13.5px] text-foreground hover:bg-secondary/70 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Volver
            </button>
          </div>
        )}

        {step === 2 && briefs.length > 0 && (
          <div className="px-5 sm:px-8 pt-5">
            {/* Tabs por documento (solo si hay más de uno) */}
            {briefs.length > 1 && (
              <div className="flex flex-wrap gap-1.5 border-b border-border pb-3">
                {fileLabels.map((label, i) => {
                  const active = i === activeTab;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setActiveTab(i)}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className="max-w-[180px] truncate">{label}</span>
                      {refiningTab === i && (
                        <Loader2 className="h-3 w-3 animate-spin text-primary" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Revisor determinístico + memoria, ANTES del resumen de la IA:
                es lo que la persona debe decidir primero. Mismo padding que
                el contenido de ConfigVariablesStep para alinear anchos. */}
            <div className="px-5 sm:px-8 pt-7 space-y-4">
              <BriefQaPanel
                qa={briefQa}
                answers={qaAnswers}
                resolutions={qaResolutions}
                onAnswer={answerQuestion}
                onSkip={skipQuestion}
                onUndo={undoAnswer}
              />
              <SupplierMemoryPanel
                memory={supplierMemory}
                brief={editedBriefs[0] ?? briefs[0] ?? null}
              />
            </div>

            {/* Editores: TODOS montados, el inactivo oculto, para no perder
                ediciones al cambiar de tab. */}
            {briefs.map((b, i) => (
              <div key={i} className={i === activeTab ? "" : "hidden"}>
                <ConfigVariablesStep
                  key={`${i}-${briefVersions[i] ?? 0}`}
                  config={b}
                  meta={
                    metas[i] ?? {
                      filename: fileLabels[i] ?? "",
                      size_bytes: 0,
                      model: "",
                      processed_at: "",
                    }
                  }
                  catalogPrefill={catalogPrefill}
                  extracting={extracting}
                  isRefining={refiningTab === i}
                  chatHistory={chatHistories[i] ?? []}
                  serverError={null}
                  onConfirm={() => confirmConfig()}
                  onRefine={(msg) => refineConfig(i, msg)}
                  onBack={backToUpload}
                  onDraftChange={(edited) => handleDraftChange(i, edited)}
                  onCatalogChange={setCatalogPrefill}
                  showActions={false}
                />
              </div>
            ))}

            {/* Acciones GLOBALES (una sola extracción para todos los docs) */}
            <div className="px-5 sm:px-8 pb-7 space-y-4">
              {serverError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
                >
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{serverError}</span>
                </div>
              )}
              <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
                <button
                  type="button"
                  onClick={backToUpload}
                  disabled={extracting || refiningTab !== null}
                  className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-border bg-secondary/40 text-[13.5px] text-foreground hover:bg-secondary/70 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Volver
                </button>
                <div className="flex flex-col items-end gap-1">
                {pendingRequired.length > 0 && (
                  <span className="text-[11.5px] text-amber-300">
                    {pendingRequired.length} pregunta(s) obligatoria(s) sin responder
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => confirmConfig()}
                  disabled={extracting || refiningTab !== null || pendingRequired.length > 0}
                  className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {extracting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Extrayendo tarifas…
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      {briefs.length > 1
                        ? "Confirmar todo y extraer tarifas"
                        : "Confirmar y extraer tarifas"}
                    </>
                  )}
                </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 3 && extracting && (
          <div className="px-5 sm:px-8 py-7">
            <AnalysisProgressCard
              files={selectedFiles}
              totalBytes={selectedFiles.reduce((acc, f) => acc + f.size, 0)}
              progress={progress}
              matchingPhase={null}
              getPhase={extractionPhase}
              footerDescription={STEP3_EXTRACT_FOOTER}
            />
          </div>
        )}

        {step === 3 && !extracting && !result && serverError && (
          <div className="px-5 sm:px-8 py-7 space-y-4">
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{serverError}</span>
            </div>
            <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-2">
              <button
                type="button"
                onClick={backToConfig}
                className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-border bg-secondary/40 text-[13.5px] text-foreground hover:bg-secondary/70 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                Volver a configuración
              </button>
              <button
                type="button"
                onClick={() => confirmConfig()}
                className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
              >
                <RotateCcw className="w-4 h-4" />
                Reintentar extracción
              </button>
            </div>
          </div>
        )}

        {step === 3 && preparingGrid && result && (
          <div className="px-5 sm:px-8 py-7">
            <AnalysisProgressCard
              files={selectedFiles}
              totalBytes={selectedFiles.reduce((acc, f) => acc + f.size, 0)}
              progress={progress}
              matchingPhase={null}
              getPhase={gridRenderPhase}
              footerDescription={STEP3_RENDER_FOOTER}
            />
          </div>
        )}

        {step === 3 && result && (
          <div
            className={
              preparingGrid
                ? "fixed opacity-0 pointer-events-none -z-10 h-0 overflow-hidden"
                : undefined
            }
            aria-hidden={preparingGrid}
          >
            <ReviewStep
              result={result}
              preScanResult={preScan.status === "done" ? preScan.result : null}
              confirmedBrief={editedBriefs[0] ?? briefs[0] ?? null}
              supplier={confirmedSupplier}
              feedbackBase={feedbackBase}
              catalogPrefill={catalogPrefill}
              briefMetas={metas}
              comments={comments}
              onApprove={approve}
              onBack={backToConfig}
              onGridReady={preparingGrid ? handleGridReady : undefined}
            />
          </div>
        )}

        {step === 4 && result && approvedPayload && (
          <>
            <DownloadStep
              payload={approvedPayload}
              meta={result.meta}
              briefMetas={metas}
              onReset={reset}
            />
            {isAdmin && (
              <div className="px-5 sm:px-8 pb-7">
                <SaveEvalCaseCard
                  files={selectedFiles}
                  payload={approvedPayload}
                  brief={editedBriefs[0] ?? briefs[0] ?? null}
                  preScan={preScan.status === "done" ? preScan.result : null}
                  supplierCodigo={supplierChoice?.existing ? supplierChoice.supplier.codigo : null}
                />
              </div>
            )}
          </>
        )}
      </div>
    </section>

    <div className="text-center mt-4">
      <p className="text-[11px] text-muted-foreground/60">Version 2.0.4 - Octubre 01</p>
    </div>
    </>
  );
}

/* ============================================================================
   STEP 1 — Upload
   ========================================================================== */

function UploadStep({
  files,
  uploadError,
  serverError,
  analyzing,
  fileInputRef,
  comments,
  onCommentsChange,
  supplierChoice,
  onSupplierChoiceChange,
  preScan,
  autoDetectedId,
  onDrop,
  onPick,
  onRemove,
  onClearAll,
  onStart,
}: {
  files: File[];
  uploadError: string | null;
  serverError: string | null;
  analyzing: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  comments: string;
  onCommentsChange: (value: string) => void;
  supplierChoice: SupplierChoice | null;
  onSupplierChoiceChange: (value: SupplierChoice) => void;
  preScan: PreScanState;
  autoDetectedId: string | null;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onPick: (e: ChangeEvent<HTMLInputElement>) => void;
  onRemove: (index: number) => void;
  onClearAll: () => void;
  onStart: () => void;
}) {
  const COMMENTS_MAX = 5000;
  const slotsLeft = MAX_FILES_PER_REQUEST - files.length;
  const canAdd = slotsLeft > 0 && !analyzing;
  const hasFiles = files.length > 0;
  const canSubmit = hasFiles && !analyzing && supplierChoice !== null;

  return (
    <div className="px-5 sm:px-8 py-7 space-y-5">
      <DocumentUploadSection
        title="Documentos del contrato"
        description={`Tarifario, políticas, anexos, catálogos… todos los archivos de este contrato juntos (hasta ${MAX_FILES_PER_REQUEST}). Se analizan como un solo contrato.`}
        disabled={!canAdd}
        inputRef={fileInputRef}
        multiple
        onDrop={onDrop}
        onPick={onPick}
        emptyTitle="Arrastra los documentos aquí"
        emptyHint={
          hasFiles
            ? "o haz click para agregar más archivos"
            : "o haz click para buscar en tu equipo"
        }
      >
        {hasFiles && (
          <div className="mt-3 rounded-lg border border-border/60 bg-card/40 divide-y divide-border/60">
            <header className="flex items-center justify-between px-3 py-2 border-b border-border/60">
              <p className="text-[11.5px] font-medium text-foreground">
                {files.length} {files.length === 1 ? "documento" : "documentos"}
              </p>
              {files.length > 1 && (
                <button
                  type="button"
                  onClick={onClearAll}
                  disabled={analyzing}
                  className="text-[10.5px] text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                >
                  Quitar todos
                </button>
              )}
            </header>
            <ul>
              {files.map((f, idx) => (
                <UploadedFileRow
                  key={`${f.name}|${f.size}|${idx}`}
                  file={f}
                  onRemove={() => onRemove(idx)}
                />
              ))}
            </ul>
            {canAdd && (
              <div className="px-3 py-2 border-t border-border/60">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 text-[11.5px] text-primary hover:text-primary/80 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Agregar otro
                  <span className="text-muted-foreground/80">
                    ({slotsLeft} {slotsLeft === 1 ? "disponible" : "disponibles"})
                  </span>
                </button>
              </div>
            )}
          </div>
        )}
      </DocumentUploadSection>

      {uploadError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
        >
          <X className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{uploadError}</span>
        </div>
      )}

      {serverError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{serverError}</span>
        </div>
      )}

      {hasFiles && preScan.status !== "idle" && (
        <PreScanCard
          state={preScan}
          choice={supplierChoice}
          autoDetectedId={autoDetectedId}
          onChoose={onSupplierChoiceChange}
          disabled={analyzing}
        />
      )}

      <CommentsField
        value={comments}
        onChange={onCommentsChange}
        max={COMMENTS_MAX}
        disabled={analyzing}
      />

      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
        <button
          type="button"
          onClick={onStart}
          disabled={!canSubmit}
          className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
        >
          {analyzing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Analizando contrato…
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              Analizar con IA
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function DocumentUploadSection({
  title,
  badge,
  description,
  disabled,
  inputRef,
  multiple,
  onDrop,
  onPick,
  emptyTitle,
  emptyHint,
  children,
}: {
  title: string;
  badge?: string;
  description: string;
  disabled: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  multiple: boolean;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onPick: (e: ChangeEvent<HTMLInputElement>) => void;
  emptyTitle: string;
  emptyHint: string;
  children?: ReactNode;
}) {
  const [dragActive, setDragActive] = useState(false);
  const hasContent = !!children;

  return (
    <div className="space-y-2">
      <div>
        <p className="text-[13px] font-semibold text-foreground">
          {title}
          {badge && (
            <span className="ml-2 inline-flex items-center rounded border border-border bg-secondary/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {badge}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">{description}</p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          setDragActive(false);
          if (disabled) {
            e.preventDefault();
            return;
          }
          onDrop(e);
        }}
        onClick={() => {
          if (!disabled) inputRef.current?.click();
        }}
        role="button"
        tabIndex={0}
        aria-disabled={disabled}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !disabled) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={`group rounded-2xl border-2 border-dashed p-6 sm:p-7 text-center transition-all ${
          disabled
            ? "cursor-not-allowed opacity-60 border-border bg-secondary/20"
            : dragActive
              ? "cursor-pointer border-primary bg-primary/10 shadow-[0_0_30px_0_hsl(var(--primary)/0.25)]"
              : "cursor-pointer border-border bg-secondary/20 hover:border-primary/50 hover:bg-primary/5"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple={multiple}
          onChange={onPick}
          className="hidden"
        />
        {!hasContent && (
          <>
            <div className="mx-auto w-12 h-12 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center animate-pulse-glow">
              <CloudUpload className="w-5 h-5 text-primary" />
            </div>
            <p className="mt-3 text-[14px] font-semibold text-foreground">
              {emptyTitle}
            </p>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {emptyHint}
            </p>
            <div className="mt-3 inline-flex flex-wrap items-center justify-center gap-1.5 text-[10.5px] text-muted-foreground/80">
              <Badge label="PDF" />
              <Badge label="DOCX" />
              <Badge label="XLSX" />
              <Badge label="JPG" />
              <Badge label="PNG" />
              <span className="opacity-60">· hasta 20 MB c/u</span>
            </div>
          </>
        )}
        {hasContent && children}
      </div>
    </div>
  );
}

function UploadedFileRow({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const fkind = inferKind(file.type, file.name);
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="w-8 h-8 rounded-lg bg-secondary/70 border border-border/60 flex items-center justify-center shrink-0">
        {fkind ? (
          fileIcon(fkind)
        ) : (
          <FileText className="w-4 h-4 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0 text-left">
        <p className="text-[13px] text-foreground truncate">{file.name}</p>
        <p className="text-[11px] text-muted-foreground">
          {humanSize(file.size)}
          {fkind ? ` · ${fkind.toUpperCase()}` : ""}
        </p>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        aria-label={`Quitar ${file.name}`}
        className="text-muted-foreground hover:text-destructive transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * Tarjeta de pre-scan (Paso 1): lo que un revisor quiere ver antes de gastar
 * una llamada a Claude — proveedor detectado, datos duros del documento y
 * contratos anteriores del mismo proveedor con avisos de cambios.
 */
function PreScanCard({
  state,
  choice,
  autoDetectedId,
  onChoose,
  disabled,
}: {
  state: PreScanState;
  choice: SupplierChoice | null;
  autoDetectedId: string | null;
  onChoose: (next: SupplierChoice) => void;
  disabled: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card/60 px-4 py-3 text-[12.5px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        Leyendo los documentos para identificar al proveedor (sin IA)…
      </div>
    );
  }
  if (state.status === "error") {
    // Sin pre-scan igual hay que elegir proveedor: mostramos el selector.
    return (
      <div className="rounded-xl border border-amber-500/40 bg-card/60 px-4 py-3.5 space-y-3">
        <div className="flex items-start gap-2.5 text-[12.5px] text-muted-foreground">
          <ScanSearch className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{state.message} Elige el proveedor para continuar.</span>
        </div>
        <ExistingSupplierSelect value={choice} onChange={onChoose} disabled={disabled} compact />
      </div>
    );
  }
  if (state.status !== "done") return null;

  const { result } = state;
  const { confidence, candidates } = result.supplier;
  const top = candidates[0] ?? null;
  const chosenId = choice?.existing ? choice.supplier.id : null;
  const facts = result.facts;
  const inf = result.inferences;
  const warnings = result.previous?.warnings ?? [];
  const needsChoice = choice === null;
  const hasFacts =
    facts.cedulas.length + facts.ibans.length + facts.emails.length + facts.phones.length + facts.dates.length > 0;
  const anyText = result.documents.some((d) => d.textAvailable);
  // Si el pre-scan no pudo proponer nada, el selector va abierto de entrada.
  const pickerOpen = showPicker || !anyText || confidence === "ninguna";

  const tone = needsChoice
    ? "border-amber-500/40 bg-amber-500/5"
    : confidence === "alta"
      ? "border-primary/40 bg-primary/5"
      : "border-border bg-card/60";

  const chip = (label: string, value: string, title?: string) => (
    <span
      key={label}
      title={title}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-background/50 px-2 py-1 text-[11.5px]"
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
  const chips: React.ReactNode[] = [];
  if (inf.country) chips.push(chip("País", inf.country.value, inf.country.reasons.join(" · ")));
  if (inf.validity) {
    chips.push(
      chip(
        "Vigencia",
        `${inf.validity.start} → ${inf.validity.end}`,
        inf.validity.source === "year" ? "Inferida del año del documento; confírmala en el Paso 2." : "Explícita en el documento",
      ),
    );
  }
  if (facts.currencies.length > 0) chips.push(chip("Moneda", facts.currencies.join(", ")));
  if (inf.taxes) {
    const t = inf.taxes;
    const v = t.included === false ? `+ ${t.percent ?? "?"}% (no incluido)` : t.included === true ? `incluido${t.percent ? ` (${t.percent}%)` : ""}` : `${t.percent}%`;
    chips.push(chip("Impuesto", v, t.snippet));
  }
  if (inf.commission) {
    chips.push(chip("Comisión", inf.commission.net ? "neta / no comisionable" : `${inf.commission.percent}%`, inf.commission.snippet));
  }
  if (inf.rateBasis.length > 0) chips.push(chip("Tarifa", inf.rateBasis.join(", ")));
  if (inf.occupancies.length > 0) chips.push(chip("Ocupación", inf.occupancies.join(" · ")));
  if (inf.seasons.length > 0) {
    chips.push(
      chip(
        "Temporadas",
        String(inf.seasons.length),
        inf.seasons
          .map((se) => `${se.name ?? "Temporada"}: ${se.ranges.map((r) => `${r.start}→${r.end}`).join(", ")}`)
          .join("\n"),
      ),
    );
  }
  if (inf.minNights) chips.push(chip("Mín. noches", String(inf.minNights)));
  if (inf.priceMentions > 0) {
    chips.push(
      chip(
        "Precios",
        `${inf.priceMentions} (${inf.prices.length} distintos)${inf.estimatedProducts ? ` ≈ ${inf.estimatedProducts} productos` : ""}`,
        inf.estimatedProducts
          ? `${inf.priceMentions} precios = ${inf.estimatedProducts} productos × ${inf.occupancies.filter((o) => o !== "CHD").length || 1} ocupaciones × ${Math.max(1, inf.seasons.length)} temporadas`
          : undefined,
      ),
    );
  }
  if (inf.checkIn || inf.checkOut) chips.push(chip("Check-in/out", `${inf.checkIn ?? "—"} / ${inf.checkOut ?? "—"}`));
  if (inf.paymentTerms.length > 0) {
    chips.push(
      chip(
        "Pago",
        inf.paymentTerms
          .slice(0, 3)
          .map((t) => `${t.percent !== null ? `${t.percent}%` : "pago"}${t.daysBefore !== null ? ` ${t.daysBefore}d` : ""}${t.season ? ` (${t.season === "high" ? "alta" : "baja"})` : ""}`)
          .join(" · "),
        inf.paymentTerms[0]!.sentence,
      ),
    );
  }
  if (inf.cancellationTerms.length > 0) {
    chips.push(
      chip(
        "Cancelación",
        inf.cancellationTerms
          .slice(0, 3)
          .map((t) => `${t.daysBefore}d → ${t.percent !== null ? `${t.percent}%` : "?"}${t.season ? ` (${t.season === "high" ? "alta" : "baja"})` : ""}`)
          .join(" · "),
        inf.cancellationTerms[0]!.sentence,
      ),
    );
  }
  if (inf.bankAccounts.length > 0) {
    chips.push(
      chip(
        "Bancos",
        inf.bankAccounts.map((b) => `${b.bank ?? "banco"}${b.currency ? ` ${b.currency}` : ""}`).join(" · "),
        inf.bankAccounts.map((b) => `${b.bank ?? ""} ${b.currency ?? ""} ${b.accountNumber ?? ""} ${b.iban ?? ""}`.trim()).join("\n"),
      ),
    );
  }

  return (
    <div className={`rounded-xl border ${tone} px-4 py-3.5 space-y-3`}>
      {/* Proveedor */}
      <div className="flex items-start gap-2.5">
        <ScanSearch className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          {!anyText ? (
            <>
              <p className="text-[13px] font-semibold text-foreground">
                {result.kind === "image" ? "Imagen" : "Documento sin texto legible"}
                <span className="ml-1.5 text-rose-300" aria-hidden>*</span>
              </p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                No pudimos leer texto sin IA (parece escaneado). Elige el
                proveedor o márcalo como nuevo; el agente leerá el documento en
                el análisis.
              </p>
            </>
          ) : top && confidence !== "ninguna" ? (
            <>
              <p className="text-[13px] font-semibold text-foreground">
                {confidence === "alta" ? "Proveedor detectado" : "Posible proveedor"}
                {": "}
                <span className="text-primary">{top.nombre ?? top.codigo}</span>
                <span className="ml-1.5 rounded-full border border-border bg-secondary/60 px-1.5 py-0.5 font-mono text-[10.5px] font-normal text-muted-foreground">
                  {top.codigo}
                </span>
                {chosenId === top.id && autoDetectedId === top.id && (
                  <span className="ml-1.5 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10.5px] font-medium text-primary">
                    seleccionado
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {[top.actividad, top.zona].filter(Boolean).join(" · ") || "Sin clasificación"}
                {" · "}
                {top.serviceCount} servicio{top.serviceCount === 1 ? "" : "s"}
                {" · "}
                {top.reasons.slice(0, 2).join("; ")}
              </p>
            </>
          ) : (
            <>
              <p className="text-[13px] font-semibold text-foreground">
                No encontramos el proveedor en el maestro
                <span className="ml-1.5 text-rose-300" aria-hidden>*</span>
              </p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                Búscalo abajo o márcalo como nuevo. Si existe con otro nombre,
                puedes corregirlo en Proveedores.
              </p>
            </>
          )}
        </div>
      </div>

      {/* Acciones */}
      <div className="flex flex-wrap items-center gap-1.5">
        {anyText &&
          confidence !== "ninguna" &&
          candidates.slice(0, 3).map((c, i) => {
            const selected = chosenId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                disabled={disabled}
                onClick={() => onChoose({ existing: true, supplier: candidateToSupplier(c) })}
                title={c.reasons.join("; ")}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors disabled:opacity-50 ${
                  selected
                    ? "border-primary/50 bg-primary/15 text-primary"
                    : "border-border bg-secondary/40 text-foreground hover:bg-secondary/70"
                }`}
              >
                {selected ? <Check className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />}
                {i === 0 ? (selected ? "Confirmado" : "Confirmar proveedor") : (c.nombre ?? c.codigo)}
              </button>
            );
          })}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChoose({ existing: false })}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors disabled:opacity-50 ${
            choice !== null && !choice.existing
              ? "border-primary/50 bg-primary/15 text-primary"
              : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/70"
          }`}
        >
          <UserPlus className="h-3.5 w-3.5" />
          Es un proveedor nuevo
        </button>
        {!pickerOpen && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setShowPicker(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground disabled:opacity-50"
          >
            <Search className="h-3.5 w-3.5" />
            Elegir otro
          </button>
        )}
      </div>

      {pickerOpen && (
        <ExistingSupplierSelect
          value={choice}
          onChange={(next) => {
            onChoose(next);
            setShowPicker(false);
          }}
          disabled={disabled}
          autoDetected={choice?.existing === true && autoDetectedId === choice.supplier.id}
          compact
        />
      )}

      {/* Qué aportó cada documento */}
      {result.documents.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-border/70 bg-background/40 px-3 py-2 text-[12px]">
          {result.documents.map((d) => (
            <li key={`${d.role}-${d.filename}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="truncate max-w-[260px] font-medium text-foreground" title={d.filename}>
                {d.filename}
              </span>
              <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
                {d.pages ? `${d.pages.total} pág.` : d.kind}
              </span>
              <span className={d.textAvailable ? "text-muted-foreground" : "text-amber-300"}>
                {d.contributes.join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Avisos: discrepancias entre documentos + contraste con contrato anterior */}
      {(warnings.length > 0 || result.crossDocumentWarnings.length > 0) && (
        <ul className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[12px]">
          {[...result.crossDocumentWarnings, ...warnings].map((w) => (
            <li key={w} className="flex items-start gap-2 text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Lo que ya sabemos del documento (sin IA) */}
      {chips.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            Leído del documento — para verificar en el Paso 2
          </p>
          <div className="flex flex-wrap gap-1.5">{chips}</div>
        </div>
      )}

      {(hasFacts || inf.productHints.length > 0 || inf.childPolicy || inf.cancellationPolicy || inf.paymentPolicy) && (
        <div>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="text-[12px] text-primary/80 hover:text-primary transition-colors"
          >
            {showDetails ? "Ocultar detalles" : "Ver más detalles del documento"}
            {result.pages ? ` · ${result.pages.total} pág.` : ""}
          </button>
          {showDetails && (
            <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 text-[12px]">
              <FactRow label="Razón social" values={inf.legalName ? [inf.legalName] : []} />
              <FactRow label="Cédula" values={facts.cedulas} mono />
              <FactRow label="Dirección" values={inf.address ? [inf.address] : []} />
              <FactRow
                label="Cuentas bancarias"
                values={
                  inf.bankAccounts.length > 0
                    ? inf.bankAccounts.map((b) => [b.bank, b.currency, b.accountNumber, b.iban].filter(Boolean).join(" · "))
                    : facts.ibans
                }
                mono
              />
              <FactRow label="Comidas" values={inf.meals.slice(0, 3)} />
              <FactRow label="Correos" values={facts.emails.slice(0, 4)} />
              <FactRow label="Teléfonos" values={facts.phones.slice(0, 4)} mono />
              <FactRow
                label="Fechas"
                values={facts.dates.slice(0, 6)}
                extra={facts.yearRange ? `años ${facts.yearRange.min}–${facts.yearRange.max}` : undefined}
              />
              <FactRow label="Productos mencionados" values={inf.productHints.slice(0, 10)} />
              {inf.seasons.length > 0 && (
                <FactRow
                  label="Temporadas"
                  values={inf.seasons.map(
                    (se) => `${se.name ?? "Temporada"}: ${se.ranges.map((r) => `${r.start}→${r.end}`).join(", ")}`,
                  )}
                />
              )}
              <FactRow label="Niños" values={inf.childTerms.length > 0 ? inf.childTerms.slice(0, 3) : inf.childPolicy ? [inf.childPolicy] : []} />
              <FactRow label="Cancelación" values={inf.cancellationPolicy ? [inf.cancellationPolicy] : []} />
              <FactRow label="Pago" values={inf.paymentPolicy ? [inf.paymentPolicy] : []} />
              <FactRow label="Web" values={inf.website ? [inf.website] : []} />
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

function FactRow({
  label,
  values,
  mono = false,
  extra,
}: {
  label: string;
  values: string[];
  mono?: boolean;
  extra?: string;
}) {
  if (values.length === 0 && !extra) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 flex flex-wrap gap-1 ${mono ? "font-mono" : ""}`}>
        {values.map((v) => (
          <span key={v} className="rounded border border-border bg-secondary/50 px-1.5 py-0.5 text-foreground">
            {v}
          </span>
        ))}
        {extra && <span className="self-center text-muted-foreground">{extra}</span>}
      </dd>
    </div>
  );
}

/**
 * "¿Es un proveedor existente?" — combobox con búsqueda sobre el maestro de
 * proveedores (GET /suppliers, cacheado en `supplierLookup`). La primera
 * opción, fija, es "No, es un proveedor nuevo". Elegir un proveedor fija el
 * prefill de catálogo del Paso 2 sin pasar por el matching por nombre.
 */
function ExistingSupplierSelect({
  value,
  onChange,
  disabled,
  autoDetected = false,
  compact = false,
}: {
  value: SupplierChoice | null;
  onChange: (next: SupplierChoice) => void;
  disabled: boolean;
  /** El valor actual lo puso el pre-scan; se muestra como "detectado". */
  autoDetected?: boolean;
  /** Sin tarjeta ni título: sólo el combobox (para embeber en el pre-scan). */
  compact?: boolean;
}) {
  const [suppliers, setSuppliers] = useState<CatalogSupplier[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let cancelled = false;
    listSuppliers()
      .then((list) => {
        if (cancelled) return;
        setSuppliers(list);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          describeRequestFailure(
            err,
            "No pudimos cargar la lista de proveedores. Revisa tu conexión.",
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // Cerrar al hacer click fuera.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const MAX_VISIBLE = 80;
  const filtered = useMemo(() => {
    const list = suppliers ?? [];
    const k = normalizeKey(query);
    if (!k) return list;
    const tokens = k.split(" ").filter(Boolean);
    return list.filter((s) => {
      const hay = `${normalizeKey(s.nombre)} ${normalizeKey(s.codigo)}`;
      return tokens.every((t) => hay.includes(t));
    });
  }, [suppliers, query]);
  const visible = filtered.slice(0, MAX_VISIBLE);
  const hiddenCount = filtered.length - visible.length;

  // Índice 0 = "proveedor nuevo"; 1..n = proveedores visibles.
  const optionCount = visible.length + 1;

  const openList = () => {
    if (disabled) return;
    setOpen(true);
    setHighlight(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const select = (choice: SupplierChoice) => {
    onChange(choice);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(optionCount - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlight === 0) select({ existing: false });
      else {
        const s = visible[highlight - 1];
        if (s) select({ existing: true, supplier: s });
      }
    }
  };

  // Mantener la opción resaltada a la vista al navegar con teclado.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${highlight}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const untouched = value === null;
  const triggerLabel =
    value === null
      ? "Selecciona un proveedor o indica que es nuevo"
      : value.existing
        ? (value.supplier.nombre ?? value.supplier.codigo)
        : "No, es un proveedor nuevo";
  const TriggerIcon = value?.existing ? UserCheck : UserPlus;

  return (
    <div
      className={
        compact
          ? ""
          : `rounded-xl border bg-card/60 transition-colors ${
              untouched ? "border-amber-500/40" : "border-border"
            }`
      }
    >
      <div className={compact ? "" : "flex flex-col gap-3 px-4 py-3.5"}>
        {!compact && (
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold text-foreground">
              ¿Es un proveedor existente?{" "}
              <span className="text-rose-300" aria-hidden>
                *
              </span>
            </p>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              Elige el proveedor del maestro para pre-llenar actividad, zona y
              códigos, o indica que es uno nuevo. Campo requerido.
            </p>
          </div>
        )}

        <div ref={rootRef} className="relative">
          <button
            type="button"
            onClick={() => (open ? setOpen(false) : openList())}
            onKeyDown={(e) => {
              if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                openList();
              }
            }}
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label="¿Es un proveedor existente?"
            className={`w-full h-10 pl-3 pr-9 rounded-md border bg-input/70 text-left text-[13px] outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 ${
              untouched ? "border-amber-500/40 text-muted-foreground" : "border-border text-foreground"
            }`}
          >
            <span className="flex items-center gap-2 min-w-0">
              {value !== null && (
                <TriggerIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
              )}
              <span className="truncate">{triggerLabel}</span>
              {value?.existing && (
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {autoDetected && (
                    <span className="rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10.5px] font-medium text-primary">
                      detectado
                    </span>
                  )}
                  <span className="rounded-full border border-border bg-secondary/60 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                    {value.supplier.codigo}
                  </span>
                </span>
              )}
            </span>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
          </button>

          {open && (
            <div
              className="absolute z-30 mt-1.5 w-full overflow-hidden rounded-lg border border-border bg-card shadow-2xl animate-fade-in"
              onKeyDown={onKeyDown}
            >
              <div className="relative border-b border-border">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHighlight(e.target.value ? 1 : 0);
                  }}
                  placeholder="Buscar por nombre o código…"
                  aria-label="Buscar proveedor"
                  className="h-10 w-full bg-transparent pl-9 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground/60 outline-none"
                />
              </div>

              <ul
                ref={listRef}
                role="listbox"
                aria-label="Proveedores"
                className="max-h-72 overflow-y-auto overscroll-contain py-1"
              >
                <li
                  role="option"
                  aria-selected={value !== null && !value.existing}
                  data-index={0}
                  onMouseEnter={() => setHighlight(0)}
                  onClick={() => select({ existing: false })}
                  className={`mx-1 flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors ${
                    highlight === 0 ? "bg-primary/15 text-foreground" : "text-foreground hover:bg-secondary/60"
                  }`}
                >
                  <UserPlus className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="font-medium">No, es un proveedor nuevo</span>
                  {value !== null && !value.existing && (
                    <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                  )}
                </li>

                <li className="mx-3 my-1 border-t border-border/70" aria-hidden />

                {suppliers === null && !loadError && (
                  <li className="flex items-center gap-2 px-4 py-3 text-[12.5px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Cargando proveedores…
                  </li>
                )}
                {loadError && (
                  <li className="px-4 py-3 text-[12.5px]">
                    <p className="text-destructive">{loadError}</p>
                    <button
                      type="button"
                      onClick={() => setReloadToken((t) => t + 1)}
                      className="mt-1.5 text-primary hover:underline"
                    >
                      Reintentar
                    </button>
                  </li>
                )}
                {suppliers !== null && visible.length === 0 && (
                  <li className="px-4 py-3 text-[12.5px] text-muted-foreground">
                    {suppliers.length === 0
                      ? "El maestro de proveedores está vacío."
                      : "Ningún proveedor coincide con la búsqueda."}
                  </li>
                )}
                {visible.map((s, i) => {
                  const idx = i + 1;
                  const selected = value?.existing === true && value.supplier.id === s.id;
                  return (
                    <li
                      key={s.id}
                      role="option"
                      aria-selected={selected}
                      data-index={idx}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() => select({ existing: true, supplier: s })}
                      className={`mx-1 flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors ${
                        highlight === idx ? "bg-primary/15" : "hover:bg-secondary/60"
                      }`}
                    >
                      <UserCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-foreground">
                          {s.nombre ?? s.codigo}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {[s.actividad, s.zona].filter(Boolean).join(" · ") || "Sin clasificación"}
                          {" · "}
                          {s.serviceCount} servicio{s.serviceCount === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full border border-border bg-secondary/60 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                        {s.codigo}
                      </span>
                      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                    </li>
                  );
                })}
                {hiddenCount > 0 && (
                  <li className="px-4 py-2 text-[11.5px] text-muted-foreground">
                    +{hiddenCount} más — sigue escribiendo para acotar.
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CommentsField({
  value,
  onChange,
  max,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  max: number;
  disabled: boolean;
}) {
  const remaining = max - value.length;
  const showCounter = value.length > Math.floor(max * 0.8);
  const overLimit = value.length > max;

  return (
    <div className="rounded-xl border border-border bg-card/60">
      <div className="px-4 py-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <MessageSquareText className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-[12.5px] font-semibold text-foreground">
            Comentarios adicionales{" "}
            <span className="text-muted-foreground/70 font-normal">
              (opcional)
            </span>
          </p>
        </div>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          A veces el correo trae datos o correcciones que no están en los
          documentos («los precios sí incluyen el 13 % de IVA, el PDF está
          mal»). Lo que escribas aquí{" "}
          <span className="font-semibold text-foreground">
            tiene prioridad sobre el documento
          </span>{" "}
          y queda marcado como instrucción del usuario en el resultado.
        </p>
      </div>
      <div className="px-4 py-3 space-y-1.5">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={3}
          maxLength={max}
          placeholder="Pega aquí cualquier información adicional del cuerpo del correo…"
          aria-label="Comentarios adicionales"
          className="w-full resize-y rounded-lg border border-border bg-secondary/30 px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/60 focus:bg-secondary/50 disabled:cursor-not-allowed disabled:opacity-50"
        />
        {showCounter && (
          <p
            className={`text-right text-[11px] tabular-nums ${
              overLimit ? "text-destructive" : "text-muted-foreground"
            }`}
            aria-live="polite"
          >
            {remaining} caracteres restantes
          </p>
        )}
      </div>
    </div>
  );
}

function Badge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-border bg-secondary/40 text-[10.5px] font-semibold tracking-wider">
      {label}
    </span>
  );
}

/**
 * Fases mostradas durante el análisis. El % es una estimación temporal (no
 * hay streaming del backend), pero los tramos reflejan el flujo real de dos
 * pasadas: pre-análisis rápido (Sonnet 4.6) que detecta las reglas globales,
 * y luego la extracción completa (Opus 5.5) que genera todas las filas — esta
 * última es la que se lleva la mayor parte del tiempo, de ahí el tramo ancho.
 */
function extractionPhase(progress: number): string {
  if (progress < 12) return "Iniciando extracción de tarifas…";
  if (progress < 35) return "Procesando habitaciones y temporadas…";
  if (progress < 70) return "Generando combinaciones habitación × temporada × ocupación…";
  if (progress < 90) return "Estructurando filas para la grilla…";
  if (progress < 100) return "Finalizando extracción…";
  return "Listo";
}

function gridRenderPhase(progress: number): string {
  if (progress < 50) return "Preparando columnas de la tabla…";
  if (progress < 85) return "Cargando filas generadas…";
  return "Aplicando formato a la grilla…";
}

function analysisPhase(progress: number): string {
  if (progress < 14) return "Preparando el documento…";
  if (progress < 32) return "Analizando reglas globales del contrato…";
  if (progress < 88) return "Extrayendo todas las tarifas con IA…";
  if (progress < 100) return "Validando datos extraídos…";
  return "Listo";
}

function AnalysisProgressCard({
  files,
  totalBytes,
  progress,
  matchingPhase,
  footerDescription,
  getPhase,
}: {
  files: File[];
  totalBytes: number;
  progress: number;
  matchingPhase: "local" | "ai" | null;
  footerDescription?: string;
  getPhase?: (progress: number) => string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  const phase = getPhase
    ? getPhase(progress)
    : matchingPhase === "ai"
      ? "Buscando coincidencia en el maestro con IA…"
      : matchingPhase === "local"
        ? "Buscando coincidencia en el maestro…"
        : analysisPhase(progress);

  const primary = files[0];
  const primaryKind = primary ? inferKind(primary.type, primary.name) : null;
  const headlineName = primary
    ? files.length === 1
      ? primary.name
      : `${primary.name} (+${files.length - 1} más)`
    : "";

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50">
        <div className="w-8 h-8 rounded-lg bg-secondary/70 border border-border/60 flex items-center justify-center shrink-0">
          {primaryKind ? (
            fileIcon(primaryKind)
          ) : (
            <FileText className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] text-foreground truncate">{headlineName}</p>
          <p className="text-[11px] text-muted-foreground">
            {files.length === 1
              ? `${humanSize(totalBytes)}${primaryKind ? ` · ${primaryKind.toUpperCase()}` : ""}`
              : `${files.length} documentos · ${humanSize(totalBytes)} total`}
          </p>
        </div>
        <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
      </div>
      <div className="px-4 py-3.5 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-foreground/90 truncate">{phase}</p>
          <p
            className="text-[12.5px] font-semibold text-primary tabular-nums"
            aria-live="polite"
          >
            {matchingPhase === "ai" ? "—" : `${pct}%`}
          </p>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Progreso del análisis"
          className="relative h-1.5 w-full overflow-hidden rounded-full bg-secondary/70 border border-border/50"
        >
          <div
            className={`h-full rounded-full bg-primary shadow-[0_0_12px_0_hsl(var(--primary)/0.5)] transition-[width] duration-200 ease-out ${
              matchingPhase === "ai" ? "animate-pulse" : ""
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {footerDescription ??
            (matchingPhase === "ai"
              ? "Pidiéndole a Claude que elija el proveedor del catálogo. Puede tardar 30-60s para contratos con muchas combinaciones."
              : files.length > 1
                ? `Corre en dos fases: un pre-análisis rápido (Opus) que ` +
                  `detecta las reglas globales y luego la extracción completa ` +
                  `que consolida ${files.length} documentos. Puede ` +
                  `tardar varios minutos — mantené esta pestaña abierta.`
                : "Corre en dos fases: un pre-análisis rápido (Opus) que " +
                  "detecta las reglas globales (impuestos, bancos, persona " +
                  "adicional) y luego la extracción completa. Los " +
                  "contratos densos pueden tardar varios minutos — mantené esta " +
                  "pestaña abierta.")}
        </p>
      </div>
    </div>
  );
}

/* ============================================================================
   COLUMN DEFINITIONS — flat 52-col schema (A..AZ)
   ========================================================================== */

export interface SelectOption {
  codigo: string;
  descripcion: string;
}

/**
 * Scope de cada columna:
 *  - "shared": el mismo valor en TODAS las filas del xlsx. Editar una celda
 *    propaga el cambio al resto de filas. Sub-tipos:
 *      - ai:      la IA la extrae del contrato (mapea a ExtractedSharedFields)
 *      - catalog: viene del prefill contra lista-proveedores
 *      - manual:  no la extrae ni la IA ni el catálogo; el usuario la escribe
 *  - "row": valor independiente por combinación product × season.
 */
type ColumnScope =
  | { kind: "shared"; source: "ai" | "catalog" | "manual" }
  | { kind: "row" };

export interface ColumnDef {
  excelCol: string;
  key: string;
  label: string;
  scope: ColumnScope;
  inputType?: "text" | "date" | "email" | "number";
  multiline?: boolean;
  minWidth: number;
  placeholder?: string;
  /**
   * Marca la columna como monetaria. El render read-only antepone el código
   * de moneda del contrato (`sharedFields.tipo_moneda` — ej. "USD", "CRC",
   * "CAD") al valor; si `tipo_moneda` está vacío, no mostramos prefijo para
   * no inventar una moneda incorrecta (un proveedor de Costa Rica facturando
   * en colones no debería ver "$ 295" por defecto).
   *
   * El valor almacenado y el editor permanecen como número plano — el código
   * de moneda vive solo en el render para no contaminar el payload del
   * backend ni la lógica de comparación de strings.
   */
  currency?: true;
  options?: (ctx: {
    tipoServicio: string | null;
  }) => ReadonlyArray<SelectOption>;
}

const TIPO_UNIDAD_OPTIONS: ReadonlyArray<SelectOption> = [
  { codigo: "N", descripcion: "Por noche" },
  { codigo: "S", descripcion: "Por servicio" },
];

/**
 * Opciones para "Tipo Tarifa" (columnas X, AA, AC, AD, AG).
 *
 * Convención del sistema: el writer xlsx espera literalmente el código
 * "1" o "2" en esas celdas y la inferencia automática
 * (`inferTipoTarifa` en xlsxGenerator.ts) emite los mismos códigos —
 * mantener la UI restringida a "1"/"2" evita free-text como "Por
 * persona" o "Wholesale" que rompía la plantilla downstream. Las cinco
 * columnas (regular X/AA + fin de semana AC/AD/AG) usan el MISMO set
 * de opciones.
 */
const TIPO_TARIFA_OPTIONS: ReadonlyArray<SelectOption> = [
  { codigo: "1", descripcion: "Fija" },
  { codigo: "2", descripcion: "Porcentual" },
];

/**
 * Opciones para "Condiciones Crédito" (columna AP). El maestro espera
 * literalmente el código numérico:
 *   "1" = CONTADO, "2" = CRÉDITO, "3" = PREPAGO
 * El usuario elige la modalidad y el plazo concreto ("30 días neto",
 * etc.) va en la columna AQ (`plazo`).
 */
const COND_CREDITO_OPTIONS: ReadonlyArray<SelectOption> = [
  { codigo: "1", descripcion: "Contado" },
  { codigo: "2", descripcion: "Crédito" },
  { codigo: "3", descripcion: "Prepago" },
];

/**
 * Devuelve la fecha tal cual está guardada (`YYYY-MM-DD`). El sistema
 * mantiene un único formato extremo a extremo — input nativo `<input
 * type="date">` lee/escribe en ISO, el normalizador server-side
 * (`normalizeDate` en validators.ts) garantiza ISO antes de persistir,
 * y la grilla muestra ISO. Si llega algo distinto (ej. una run viejo
 * pre-guardrail) lo dejamos pasar literal — preferible a "Invalid Date".
 */
function formatDateDisplay(value: string): string {
  return value;
}

/**
 * Devuelve el valor formateado para mostrar en la celda read-only:
 *   - Fechas → YYYY-MM-DD (mismo formato que el storage)
 *   - Columnas con `currency` → "<código> <valor>" (ej. "USD 295", "CRC 150000").
 *     `tipoMoneda` viene del contrato. Si está vacío, NO mostramos prefijo —
 *     preferimos un valor sin prefijo a inventar una moneda. Si el valor ya
 *     empieza con el código (porque la IA lo extrajo literal, ej. "USD 295"),
 *     no lo duplicamos.
 */
export function formatCellDisplay(
  col: ColumnDef,
  value: string,
  tipoMoneda: string | null,
): string {
  const formatted = col.inputType === "date" ? formatDateDisplay(value) : value;
  if (col.currency) {
    const code = tipoMoneda?.trim();
    if (!code) return formatted;
    const trimmed = formatted.trimStart();
    if (trimmed.toUpperCase().startsWith(code.toUpperCase())) return formatted;
    return `${code} ${formatted}`;
  }
  return formatted;
}

/**
 * Las 52 columnas A..AZ de la plantilla xlsx en orden. Fuente de verdad para
 * el render de la tabla y para construir el payload del backend.
 */
export const ALL_COLUMNS: ColumnDef[] = [
  { excelCol: "A",  key: "tipo_actividad",    label: "Tipo Actividad",     scope: { kind: "shared", source: "catalog" }, minWidth: 130, placeholder: "Ej: Hospedaje" },
  { excelCol: "B",  key: "zona_turismo",      label: "Zona Turismo",       scope: { kind: "shared", source: "catalog" }, minWidth: 140, placeholder: "Ej: Pacífico Central" },
  { excelCol: "C",  key: "proveedor_codigo",  label: "Proveedor (código)", scope: { kind: "shared", source: "catalog" }, minWidth: 130, placeholder: "Ej: PARADOR" },
  { excelCol: "D",  key: "proveedor",         label: "Razón Social",       scope: { kind: "shared", source: "ai" },      minWidth: 200, placeholder: "Ej: ACME S.A." },
  { excelCol: "E",  key: "cedula",            label: "Cédula Jurídica",    scope: { kind: "shared", source: "ai" },      minWidth: 140, placeholder: "3-101-123456" },
  { excelCol: "F",  key: "fecha",             label: "Contract Date",      scope: { kind: "shared", source: "ai" },      minWidth: 130, inputType: "date" },
  { excelCol: "G",  key: "nombre_comercial",  label: "Nombre Comercial",   scope: { kind: "shared", source: "ai" },      minWidth: 180, placeholder: "Ej: ACME" },
  { excelCol: "H",  key: "pais",              label: "País",               scope: { kind: "shared", source: "ai" },      minWidth: 110, placeholder: "Costa Rica" },
  { excelCol: "I",  key: "state_province",    label: "State / Province",   scope: { kind: "shared", source: "ai" },      minWidth: 130, placeholder: "Puntarenas" },
  { excelCol: "J",  key: "direccion",         label: "Location",           scope: { kind: "shared", source: "ai" },      minWidth: 240, placeholder: "Calle, ciudad…", multiline: true },
  { excelCol: "K",  key: "type_of_business",  label: "Type of Business",   scope: { kind: "shared", source: "ai" },      minWidth: 150, placeholder: "Ej: Hotel" },
  { excelCol: "L",  key: "contract_starts",   label: "Contract Starts",    scope: { kind: "shared", source: "ai" },      minWidth: 140, inputType: "date" },
  { excelCol: "M",  key: "contract_ends",     label: "Contract Ends",      scope: { kind: "shared", source: "ai" },      minWidth: 140, inputType: "date" },
  // Bug #2: codigo_servicio es POR FILA — la IA lo deriva del nombre del
  // producto de cada fila (antes era shared y replicaba "MASTER" para
  // todas). El catálogo lo sigue trayendo como hint via prefill, pero el
  // valor que termina en el xlsx sale de `rows[i].codigo_servicio`.
  { excelCol: "N",  key: "codigo_servicio",   label: "Cod. Servicio",      scope: { kind: "row" },                       minWidth: 130, placeholder: "Ej: MAS, SUI…" },
  { excelCol: "O",  key: "product_name",      label: "Product Name",       scope: { kind: "row" },                       minWidth: 170, placeholder: "Garden, Suites…" },
  // tipo_unidad / tipo_servicio son POR FILA (Bug #1 / #5) — permiten
  // mixed bundles (hotel "HO"/"N" + tours "TO"/"S" en el mismo contrato).
  // El backend modela ambos como shared + override per-row; la UI los trata
  // como row para que cada fila muestre su valor efectivo y el usuario
  // pueda editar los overrides. Igual que codigo_servicio.
  { excelCol: "P",  key: "tipo_unidad",       label: "Tipo Unidad",        scope: { kind: "row" },                       minWidth: 130, options: () => TIPO_UNIDAD_OPTIONS },
  { excelCol: "Q",  key: "tipo_servicio",     label: "Tipo Servicio",      scope: { kind: "row" },                       minWidth: 140, options: () => TIPOS_SERVICIO },
  { excelCol: "R",  key: "categoria",         label: "Categoría",          scope: { kind: "row" },                       minWidth: 140, options: ({ tipoServicio }) => tipoServicio ? (CATEGORIAS_BY_TIPO_SERVICIO[tipoServicio] ?? []) : [] },
  { excelCol: "S",  key: "ocupacion",         label: "Ocupación",          scope: { kind: "row" },                       minWidth: 100, placeholder: "DBL, SGL…" },
  { excelCol: "T",  key: "season_name",       label: "Season Name",        scope: { kind: "row" },                       minWidth: 120, placeholder: "ALTA, BAJA…" },
  { excelCol: "U",  key: "season_starts",     label: "Season Starts",      scope: { kind: "row" },                       minWidth: 140, inputType: "date" },
  { excelCol: "V",  key: "season_ends",       label: "Season Ends",        scope: { kind: "row" },                       minWidth: 140, inputType: "date" },
  { excelCol: "W",  key: "meals_included",    label: "Meals Included",     scope: { kind: "row" },                       minWidth: 140, placeholder: "BREAKFAST…" },
  { excelCol: "X",  key: "tipo_tarifa_neta",  label: "Tipo Tarifa Neta",   scope: { kind: "shared", source: "manual" },  minWidth: 140, options: () => TIPO_TARIFA_OPTIONS, placeholder: "1=Fija, 2=Porcentual" },
  { excelCol: "Y",  key: "precios_neto_iva",  label: "Precios Neto c/IVA", scope: { kind: "row" },                       minWidth: 110, placeholder: "295", currency: true },
  { excelCol: "Z",  key: "precio_rack_iva",   label: "Precio Rack c/IVA",  scope: { kind: "row" },                       minWidth: 110, placeholder: "295", currency: true },
  { excelCol: "AA", key: "tipo_tarifa_mayorista",     label: "Tipo Tarifa Mayorista",     scope: { kind: "shared", source: "manual" }, minWidth: 150, options: () => TIPO_TARIFA_OPTIONS, placeholder: "1=Fija, 2=Porcentual" },
  { excelCol: "AB", key: "porcentaje_comision",       label: "% Comisión",                scope: { kind: "row" },                      minWidth: 90,  placeholder: "0 / 25" },
  { excelCol: "AC", key: "tipo_tarifa_fds",           label: "Tipo Tarifa Fin Semana",    scope: { kind: "shared", source: "manual" }, minWidth: 150, options: () => TIPO_TARIFA_OPTIONS, placeholder: "1=Fija, 2=Porcentual" },
  { excelCol: "AD", key: "t_tar_neta_fds",            label: "T.Tar Neta Fin Semana",     scope: { kind: "shared", source: "manual" }, minWidth: 150, options: () => TIPO_TARIFA_OPTIONS, placeholder: "1=Fija, 2=Porcentual" },
  { excelCol: "AE", key: "precios_neto_iva_fds",      label: "Precios Neto FdS",          scope: { kind: "row" },                      minWidth: 110, placeholder: "295", currency: true },
  { excelCol: "AF", key: "precio_rack_iva_fds",       label: "Precio Rack FdS",           scope: { kind: "row" },                      minWidth: 110, placeholder: "295", currency: true },
  { excelCol: "AG", key: "tipo_tarifa_mayorista_fds", label: "Tipo Tarifa Mayor. FdS",    scope: { kind: "shared", source: "manual" }, minWidth: 150, options: () => TIPO_TARIFA_OPTIONS, placeholder: "1=Fija, 2=Porcentual" },
  { excelCol: "AH", key: "porcentaje_comision_fds",   label: "% Comisión FdS",            scope: { kind: "row" },                      minWidth: 100, placeholder: "0 / 25" },
  { excelCol: "AI", key: "cancellation_policy",       label: "Cancelation Policy",        scope: { kind: "row" },                      minWidth: 280, multiline: true },
  { excelCol: "AJ", key: "range_payment_policy",      label: "Range Payment Policy",      scope: { kind: "row" },                      minWidth: 220, multiline: true },
  { excelCol: "AK", key: "others_payment_cancel",     label: "Others in Payment / Cancel",scope: { kind: "shared", source: "ai" }, minWidth: 220, multiline: true, placeholder: "Periodos especiales (Navidad, etc.)" },
  { excelCol: "AL", key: "kids_policy",               label: "Kids Policy",               scope: { kind: "row" },                      minWidth: 220, multiline: true },
  { excelCol: "AM", key: "other_included",            label: "Other Included",            scope: { kind: "row" },                      minWidth: 200, multiline: true },
  { excelCol: "AN", key: "feeds_adicionales",         label: "Fees Adicionales",          scope: { kind: "row" },                      minWidth: 180, multiline: true },
  { excelCol: "AO", key: "reservations_email",        label: "Reservations Email",        scope: { kind: "shared", source: "ai" },     minWidth: 200, inputType: "email" },
  // Teléfono NO tiene columna en la plantilla (la IA lo extrae para
  // validación E.164), pero sí viaja en el payload y queda en el historial
  // del run. Se muestra igual para que el operador pueda corregirlo desde la
  // misma grilla en lugar de tener un campo invisible e ineditable. El badge
  // "—" indica que no se escribe en ninguna celda del xlsx.
  { excelCol: "—",  key: "telefono",                   label: "Teléfono",                  scope: { kind: "shared", source: "ai" },     minWidth: 150, placeholder: "+506 2777 0000" },
  { excelCol: "AP", key: "cond_credito",              label: "Condiciones Crédito",       scope: { kind: "shared", source: "manual" }, minWidth: 150, options: () => COND_CREDITO_OPTIONS, placeholder: "1=Contado, 2=Crédito, 3=Prepago" },
  { excelCol: "AQ", key: "plazo",                     label: "Plazo",                     scope: { kind: "shared", source: "manual" }, minWidth: 120, placeholder: "30 días" },
  { excelCol: "AR", key: "numero_cuenta",             label: "Cuenta Bancaria 1",         scope: { kind: "shared", source: "ai" },     minWidth: 200, placeholder: "IBAN preferido" },
  { excelCol: "AS", key: "banco",                     label: "Banco 1",                   scope: { kind: "shared", source: "ai" },     minWidth: 150, placeholder: "Ej: BAC" },
  { excelCol: "AT", key: "tipo_moneda",               label: "Moneda 1",                  scope: { kind: "shared", source: "ai" },     minWidth: 100, placeholder: "USD" },
  { excelCol: "AU", key: "cuenta_bancaria_2",         label: "Cuenta Bancaria 2",         scope: { kind: "shared", source: "manual" }, minWidth: 200 },
  { excelCol: "AV", key: "banco_2",                   label: "Banco 2",                   scope: { kind: "shared", source: "manual" }, minWidth: 150 },
  { excelCol: "AW", key: "moneda_2",                  label: "Moneda 2",                  scope: { kind: "shared", source: "manual" }, minWidth: 100 },
  { excelCol: "AX", key: "cuenta_bancaria_3",         label: "Cuenta Bancaria 3",         scope: { kind: "shared", source: "manual" }, minWidth: 200 },
  { excelCol: "AY", key: "banco_3",                   label: "Banco 3",                   scope: { kind: "shared", source: "manual" }, minWidth: 150 },
  { excelCol: "AZ", key: "moneda_3",                  label: "Moneda 3",                  scope: { kind: "shared", source: "manual" }, minWidth: 100 },
  // Columna 53 — NOTAS (Bug #6 → BA). Cláusulas globales que no
  // encajaron en ninguna otra columna. Es shared (mismo valor en cada
  // fila) y multilínea — un punto y coma separa items.
  { excelCol: "BA", key: "notes",                     label: "Notas",                     scope: { kind: "shared", source: "ai" },     minWidth: 320, multiline: true, placeholder: "Cláusulas/notas que no encajaron en otras columnas" },
];

/** Keys del backend ExtractedSharedFields editables desde la grilla. Todas
 *  tienen columna en el xlsx salvo `telefono`, que se muestra igual para que
 *  el operador pueda corregirlo (ver ALL_COLUMNS). */
// tipo_unidad / tipo_servicio NO viven en AI_SHARED_KEYS porque la UI los
// trata como row-scoped (ver comentario en ALL_COLUMNS arriba). El valor
// shared original del backend se preserva en `data.shared_fields` y se
// reenvía intacto en handleApprove para mantener el contrato de tipos
// ExtractedSharedFields del backend; los overrides editados viajan en
// `rows[i].tipo_unidad` / `tipo_servicio`.
const AI_SHARED_KEYS: ExtractedSharedFieldKey[] = [
  "fecha", "proveedor", "nombre_comercial", "cedula", "direccion",
  // telefono no tiene columna en el xlsx pero sí es editable en la grilla
  // (ver ALL_COLUMNS) y viaja en el payload → tiene que estar en el estado.
  "telefono",
  "pais", "state_province", "type_of_business",
  "contract_starts", "contract_ends", "reservations_email",
  "tipo_moneda", "numero_cuenta", "banco",
  "others_payment_cancel",
  "notes",
];

const CATALOG_KEYS = [
  "tipo_actividad", "zona_turismo", "proveedor_codigo",
] as const;
type CatalogKey = (typeof CATALOG_KEYS)[number];

const MANUAL_KEYS = [
  "tipo_tarifa_neta", "tipo_tarifa_mayorista", "tipo_tarifa_fds",
  "t_tar_neta_fds", "tipo_tarifa_mayorista_fds",
  "cond_credito", "plazo",
  "cuenta_bancaria_2", "banco_2", "moneda_2",
  "cuenta_bancaria_3", "banco_3", "moneda_3",
] as const;
type ManualKey = (typeof MANUAL_KEYS)[number];

type SharedKey = CatalogKey | ExtractedSharedFieldKey | ManualKey;

export const COLS_NEEDING_REVIEW = new Set<string>([
  "tipo_actividad",
  "zona_turismo",
  "proveedor_codigo",
  // codigo_servicio (Bug #2): cada fila trae su propio código derivado
  // por la IA del nombre del producto. El match no es perfecto — el
  // warning sign le recuerda al usuario que verifique cada fila.
  "codigo_servicio",
]);

/* ============================================================================
   STEP 2 — Review (flat 52-col table)
   ========================================================================== */

const CONFIANZA_STYLES: Record<
  ExtractionConfianza,
  { label: string; dot: string; bg: string; border: string; text: string }
> = {
  alta: {
    label: "Confianza alta",
    dot: "bg-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
    text: "text-emerald-300",
  },
  media: {
    label: "Confianza media",
    dot: "bg-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    text: "text-amber-300",
  },
  baja: {
    label: "Confianza baja",
    dot: "bg-rose-400",
    bg: "bg-rose-500/10",
    border: "border-rose-500/30",
    text: "text-rose-300",
  },
};

/**
 * Construye el estado inicial de los campos compartidos a partir de la
 * extracción IA + catalog prefill. Las claves manual arrancan en null
 * (el usuario las llena en la tabla).
 */
function buildInitialSharedValues(
  data: ExtractedContract,
  prefill: CatalogPrefill | null,
  bankPrefill?: ManualBankPrefill | null,
): Record<SharedKey, string | null> {
  const out: Record<string, string | null> = {};
  // 15 AI shared keys con columna shared en la UI. tipo_unidad y
  // tipo_servicio NO están acá — son row-scoped, se inicializan en el
  // estado `rows` (ver useState abajo).
  for (const k of AI_SHARED_KEYS) {
    out[k] = data.shared_fields[k];
  }
  // 3 catalog keys (codigo_servicio dejó de ser shared en Bug #2 — vive
  // por fila en `rows[i].codigo_servicio`).
  out.tipo_actividad = prefill?.tipo_actividad ?? null;
  out.zona_turismo = prefill?.zona_turismo ?? null;
  out.proveedor_codigo = prefill?.proveedor_codigo ?? null;
  // 14 manual keys → null por defecto.
  for (const k of MANUAL_KEYS) {
    out[k] = null;
  }
  // Pre-llenado de cuentas bancarias 2 y 3 desde el brief (Fase 1). El
  // usuario las puede editar/borrar en Step 2, pero ya no tiene que
  // tipearlas a mano cuando el contrato lista varias cuentas.
  if (bankPrefill) {
    out.cuenta_bancaria_2 = bankPrefill.cuenta_bancaria_2 ?? null;
    out.banco_2 = bankPrefill.banco_2 ?? null;
    out.moneda_2 = bankPrefill.moneda_2 ?? null;
    out.cuenta_bancaria_3 = bankPrefill.cuenta_bancaria_3 ?? null;
    out.banco_3 = bankPrefill.banco_3 ?? null;
    out.moneda_3 = bankPrefill.moneda_3 ?? null;
    // Condición de crédito (1/2/3) + plazo, extraídos de los términos de pago.
    out.cond_credito = bankPrefill.cond_credito ?? null;
    out.plazo = bankPrefill.plazo ?? null;
  }
  return out as Record<SharedKey, string | null>;
}

/**
 * Copia bancos y notas de briefs secundarios (T&C) al brief primario cuando
 * el PDF de tarifas las dejó vacías.
 */
function mergeSecondaryBriefIntoPrimary(
  briefs: ContractConfigVariables[],
): ContractConfigVariables[] {
  if (briefs.length <= 1) return briefs;
  const primary = briefs[0]!;
  const rest = briefs.slice(1);

  const bankSeen = new Set(
    primary.bank_accounts.map(
      (a) =>
        `${(a.account_number ?? "").replace(/\s+/g, "").toLowerCase()}|${(a.bank ?? "").toLowerCase()}`,
    ),
  );
  const bank_accounts = [...primary.bank_accounts];
  for (const b of rest) {
    for (const acct of b.bank_accounts ?? []) {
      const key = `${(acct.account_number ?? "").replace(/\s+/g, "").toLowerCase()}|${(acct.bank ?? "").toLowerCase()}`;
      if (!key.replace("|", "") || bankSeen.has(key)) continue;
      bankSeen.add(key);
      bank_accounts.push(acct);
    }
  }

  const pick = (
    a: string | null | undefined,
    ...others: Array<string | null | undefined>
  ): string | null => {
    if (typeof a === "string" && a.trim()) return a;
    for (const o of others) {
      if (typeof o === "string" && o.trim()) return o;
    }
    return a ?? null;
  };

  const merged: ContractConfigVariables = {
    ...primary,
    bank_accounts,
    special_periods_note: pick(
      primary.special_periods_note,
      ...rest.map((b) => b.special_periods_note),
    ),
    notes: pick(primary.notes, ...rest.map((b) => b.notes)),
    commission_summary: pick(
      primary.commission_summary,
      ...rest.map((b) => b.commission_summary),
    ),
    meal_plan_note: pick(
      primary.meal_plan_note,
      ...rest.map((b) => b.meal_plan_note),
    ),
    logic_summary: pick(
      primary.logic_summary,
      ...rest.map((b) => b.logic_summary),
    ),
    additional_person:
      primary.additional_person.length > 0
        ? primary.additional_person
        : (rest.find((b) => b.additional_person.length > 0)?.additional_person ??
          primary.additional_person),
  };

  return [merged, ...rest];
}

/* ============================================================================
   Mini chat de correcciones (Paso 3)
   ========================================================================== */

/**
 * Un turno del hilo. `changes` solo viene en los turnos del asistente: es el
 * resumen DETERMINISTA de lo que el backend aplicó (no lo que el modelo dice
 * que hizo). Mostrar las dos cosas es a propósito — si el modelo dice "ajusté
 * los 42 precios" pero el backend solo tocó 12, la discrepancia queda a la
 * vista en lugar de esconderse.
 */
type ChatTurn = {
  role: "user" | "assistant";
  content: string;
  changes?: string[];
};

/** Estado restaurable por el botón "Deshacer". */
type TableSnapshot = {
  sharedValues: Record<SharedKey, string | null>;
  rows: ExtractedContractRow[];
  rowSources: Record<string, ExtractionSourcePage>[];
};

const CHAT_EXAMPLES = [
  "Revisá los precios, no agregaste el IVA del 13%",
  "La comisión de temporada alta es 20%, no 25%",
  "Poné la misma política de cancelación en todas las filas",
];

/**
 * Chat de correcciones "en caliente" debajo de la tabla del Paso 3.
 *
 * La grilla ya permite editar celda por celda, pero hay correcciones que son
 * inviables a mano: "sumá el IVA a los precios" en un contrato de 80 filas son
 * 160 multiplicaciones. Acá el operador lo pide en una frase, el backend manda
 * el JSON de la tabla a Claude, y las operaciones que devuelve se aplican
 * server-side (la aritmética la hace el servidor, no el modelo).
 */
function TableChat({
  messages,
  busy,
  error,
  canUndo,
  disabled,
  onSend,
  onUndo,
}: {
  messages: ChatTurn[];
  busy: boolean;
  error: string | null;
  canUndo: boolean;
  disabled: boolean;
  onSend: (message: string) => void | Promise<void>;
  onUndo: () => void;
}) {
  const [input, setInput] = useState("");
  const blocked = busy || disabled;

  const send = () => {
    const msg = input.trim();
    if (!msg || blocked) return;
    setInput("");
    void onSend(msg);
  };

  return (
    <section className="rounded-xl border border-primary/25 bg-gradient-to-br from-primary/6 via-card/70 to-card/60">
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-primary/15">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
            <Wand2 className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-foreground">
              Corregir con IA antes de descargar
            </p>
            <p className="text-[11.5px] text-muted-foreground">
              Pedile cambios sobre la tabla en lenguaje natural. Trabaja con los
              datos de arriba, no vuelve a leer el contrato.
            </p>
          </div>
        </div>
        {canUndo && (
          <button
            type="button"
            onClick={onUndo}
            disabled={blocked}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-secondary/40 text-[12.5px] text-foreground hover:bg-secondary/70 transition-colors disabled:opacity-50 shrink-0"
          >
            <Undo2 className="w-3.5 h-3.5" />
            Deshacer
          </button>
        )}
      </header>

      <div className="px-4 py-3 space-y-3">
        {messages.length > 0 && (
          <div className="max-h-[340px] overflow-y-auto space-y-3 pr-1">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg border border-primary/20 bg-primary/15 px-3 py-2 text-[13px] leading-relaxed text-foreground whitespace-pre-wrap">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div
                  key={i}
                  className="rounded-lg border border-border bg-card/70 px-3 py-2.5 space-y-2"
                >
                  <p className="text-[13px] leading-relaxed text-foreground whitespace-pre-wrap">
                    {m.content}
                  </p>
                  {m.changes && m.changes.length > 0 && (
                    <ul className="space-y-1 border-t border-border/60 pt-2">
                      {m.changes.map((c, j) => (
                        <li
                          key={j}
                          className="flex items-start gap-1.5 text-[11.5px] text-muted-foreground"
                        >
                          <Check className="w-3 h-3 mt-0.5 shrink-0 text-emerald-400" />
                          <span>{c}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {m.changes && m.changes.length === 0 && (
                    <p className="text-[11.5px] text-muted-foreground border-t border-border/60 pt-2">
                      No se modificó ninguna celda.
                    </p>
                  )}
                </div>
              ),
            )}
            {busy && (
              <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                Aplicando la corrección sobre la tabla…
              </div>
            )}
          </div>
        )}

        {messages.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {CHAT_EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setInput(ex)}
                disabled={blocked}
                className="rounded-full border border-border bg-secondary/30 px-2.5 py-1 text-[11.5px] text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors disabled:opacity-50"
              >
                {ex}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-[12.5px] text-red-200">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={blocked}
            rows={2}
            placeholder="Ej: Revisá los precios, no agregaste el IVA…"
            className="flex-1 rounded-lg border border-border bg-secondary/30 px-3 py-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/60 focus:bg-secondary/50 resize-y min-h-[64px] disabled:opacity-50"
          />
          <button
            type="button"
            onClick={send}
            disabled={blocked || input.trim() === ""}
            className="inline-flex items-center justify-center gap-2 h-11 sm:h-auto sm:self-stretch px-4 rounded-lg border border-primary/40 bg-primary/10 text-primary text-[13px] font-semibold hover:bg-primary/15 transition-colors disabled:cursor-not-allowed disabled:opacity-50 shrink-0"
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Corrigiendo…
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Corregir
              </>
            )}
          </button>
        </div>
      </div>
    </section>
  );
}

function ReviewStep({
  result,
  preScanResult,
  confirmedBrief,
  supplier,
  feedbackBase,
  catalogPrefill,
  briefMetas,
  comments,
  onApprove,
  onBack,
  onGridReady,
}: {
  result: ExtractContractResponse;
  /** Lectura sin IA del documento (Paso 1) para contrastar la tabla. */
  preScanResult: PreScanResult | null;
  /** Brief confirmado en el Paso 2 (aritmética neto/rack/comisión). */
  confirmedBrief: ContractConfigVariables | null;
  /** Proveedor del maestro (códigos de servicio válidos). */
  supplier: CatalogSupplier | null;
  /** Feedback del Paso 1-2; el Paso 3 agrega sus diffs y lo manda con el run. */
  feedbackBase: FeedbackBase | null;
  catalogPrefill: CatalogPrefill | null;
  briefMetas: AnalyzeBriefMeta[];
  /** Contexto libre que el operador escribió en el Paso 1. Alimenta el chat. */
  comments: string;
  onApprove: (payload: ApprovedPayload) => void;
  onBack: () => void;
  onGridReady?: () => void;
}) {
  const { data, validation, meta } = result;
  const conf = CONFIANZA_STYLES[data.confianza];
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  /* --- Chat de correcciones en caliente (ver TableChat abajo) ------------ */
  const [chatMessages, setChatMessages] = useState<ChatTurn[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  /**
   * Snapshot de la tabla ANTES de la última corrección del asistente, para el
   * botón "Deshacer". Una sola posición: deshacer es una red de seguridad
   * inmediata ("no era eso lo que quería"), no un historial completo.
   */
  const [undoSnapshot, setUndoSnapshot] = useState<TableSnapshot | null>(null);

  useEffect(() => {
    if (!onGridReady) return;
    let active = true;
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (active) onGridReady();
      });
    });
    return () => {
      active = false;
      cancelAnimationFrame(raf);
    };
  }, [onGridReady]);

  // Shared state (34 keys)
  const [sharedValues, setSharedValues] = useState<
    Record<SharedKey, string | null>
  >(() => buildInitialSharedValues(data, catalogPrefill, meta.manual_prefill));
  const setSharedField = (key: SharedKey, value: string | null) => {
    setSharedValues((prev) => ({ ...prev, [key]: value }));
  };

  // Per-row state (one ContractRow per combinación). tipo_unidad y
  // tipo_servicio se hidratan con el shared default cuando la fila llegó
  // con null — así cada celda muestra su valor efectivo. El override
  // se preserva si la IA lo envió diferente al shared (mixed bundles).
  const [rows, setRows] = useState<ExtractedContractRow[]>(() =>
    data.rows.map((r) => ({
      ...r,
      tipo_unidad: r.tipo_unidad ?? data.shared_fields.tipo_unidad,
      tipo_servicio: r.tipo_servicio ?? data.shared_fields.tipo_servicio,
    })),
  );
  /** Filas tal como llegaron de la IA (hidratadas igual), para el diff del feedback. */
  const [aiRows] = useState<ExtractedContractRow[]>(() =>
    data.rows.map((r) => ({
      ...r,
      tipo_unidad: r.tipo_unidad ?? data.shared_fields.tipo_unidad,
      tipo_servicio: r.tipo_servicio ?? data.shared_fields.tipo_servicio,
    })),
  );
  const setRowField = (
    rowIdx: number,
    key: ExtractedRowFieldKey,
    value: string | null,
  ) => {
    setRows((prev) =>
      prev.map((r, i) => (i === rowIdx ? { ...r, [key]: value } : r)),
    );
  };

  /**
   * Páginas de origen por fila, PARALELAS a `rows`. Antes se leían directo de
   * `data.paginas_origen_rows`, que se desalineaba en cuanto el usuario
   * agregaba o borraba una fila (y ahora también cuando el chat lo hace): la
   * fila 8 mostraba el tooltip de la 7. Viven en estado y se mueven junto con
   * las filas.
   */
  const [rowSources, setRowSources] = useState<
    Record<string, ExtractionSourcePage>[]
  >(() => data.rows.map((_, i) => data.paginas_origen_rows[i] ?? {}));

  const addRow = () => {
    setRows((prev) => {
      const last = prev[prev.length - 1];
      const blank: ExtractedContractRow = {
        product_name: last?.product_name ?? null,
        categoria: last?.categoria ?? null,
        tipo_servicio: last?.tipo_servicio ?? null,
        tipo_unidad: last?.tipo_unidad ?? null,
        codigo_servicio: last?.codigo_servicio ?? null,
        ocupacion: last?.ocupacion ?? null,
        season_name: null,
        season_starts: null,
        season_ends: null,
        meals_included: last?.meals_included ?? null,
        precios_neto_iva: null,
        precio_rack_iva: null,
        porcentaje_comision: last?.porcentaje_comision ?? null,
        precios_neto_iva_fds: null,
        precio_rack_iva_fds: null,
        porcentaje_comision_fds: last?.porcentaje_comision_fds ?? null,
        cancellation_policy: last?.cancellation_policy ?? null,
        range_payment_policy: last?.range_payment_policy ?? null,
        kids_policy: last?.kids_policy ?? null,
        other_included: last?.other_included ?? null,
        feeds_adicionales: last?.feeds_adicionales ?? null,
      };
      return [...prev, blank];
    });
    // Fila nueva = sin página de origen conocida.
    setRowSources((prev) => [...prev, {}]);
  };

  const removeRow = (rowIdx: number) => {
    setRows((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== rowIdx);
    });
    setRowSources((prev) =>
      prev.length <= 1 ? prev : prev.filter((_, i) => i !== rowIdx),
    );
  };

  const buildPayload = (): ApprovedPayload => {
    const sharedFields: ExtractedSharedFields = {
      fecha: sharedValues.fecha,
      proveedor: sharedValues.proveedor,
      nombre_comercial: sharedValues.nombre_comercial,
      cedula: sharedValues.cedula,
      direccion: sharedValues.direccion,
      telefono: sharedValues.telefono,
      pais: sharedValues.pais,
      state_province: sharedValues.state_province,
      type_of_business: sharedValues.type_of_business,
      contract_starts: sharedValues.contract_starts,
      contract_ends: sharedValues.contract_ends,
      reservations_email: sharedValues.reservations_email,
      tipo_unidad: data.shared_fields.tipo_unidad,
      tipo_servicio: data.shared_fields.tipo_servicio,
      tipo_moneda: sharedValues.tipo_moneda,
      numero_cuenta: sharedValues.numero_cuenta,
      banco: sharedValues.banco,
      others_payment_cancel: sharedValues.others_payment_cancel,
      notes: sharedValues.notes,
    };

    const hasAnyCatalog = CATALOG_KEYS.some((k) => {
      const v = sharedValues[k];
      return typeof v === "string" && v.trim() !== "";
    });
    const finalCatalogPrefill: GenerateXlsxCatalogPrefill | null =
      hasAnyCatalog || catalogPrefill?.codigo_servicio
        ? {
            tipo_actividad: sharedValues.tipo_actividad,
            zona_turismo: sharedValues.zona_turismo,
            proveedor_codigo: sharedValues.proveedor_codigo,
            codigo_servicio: catalogPrefill?.codigo_servicio ?? null,
          }
        : null;

    const hasAnyManual = MANUAL_KEYS.some((k) => {
      const v = sharedValues[k];
      return typeof v === "string" && v.trim() !== "";
    });
    const sharedBefore: Record<string, string | null> = {};
    const sharedAfter: Record<string, string | null> = {};
    for (const k of Object.keys(sharedFields) as ExtractedSharedFieldKey[]) {
      sharedBefore[k] = data.shared_fields[k] ?? null;
      sharedAfter[k] = sharedFields[k] ?? null;
    }
    const feedback: RunFeedback = {
      version: 1,
      pre_scan: feedbackBase?.pre_scan ?? null,
      brief: feedbackBase?.brief ?? null,
      rows: {
        total: rows.length,
        added: Math.max(0, rows.length - aiRows.length),
        removed: Math.max(0, aiRows.length - rows.length),
        corrections: [
          ...diffFlat(sharedBefore, sharedAfter, "shared"),
          ...diffRows(aiRows, rows),
        ],
        qa_findings: rowFindings.map((f) => ({ id: f.id, severity: f.severity, topic: f.topic })),
        acknowledged_errors: hasQaErrors && ackQaErrors,
        chat_messages: chatMessages.filter((m) => m.role === "user").length,
      },
      comments_chars: feedbackBase?.comments_chars ?? comments.trim().length,
      agency_rules: feedbackBase?.agency_rules ?? 0,
    };

    const finalManualFields: GenerateXlsxManualFields | null = hasAnyManual
      ? {
          tipo_tarifa_neta: sharedValues.tipo_tarifa_neta,
          tipo_tarifa_mayorista: sharedValues.tipo_tarifa_mayorista,
          tipo_tarifa_fds: sharedValues.tipo_tarifa_fds,
          t_tar_neta_fds: sharedValues.t_tar_neta_fds,
          tipo_tarifa_mayorista_fds: sharedValues.tipo_tarifa_mayorista_fds,
          cond_credito: sharedValues.cond_credito,
          plazo: sharedValues.plazo,
          cuenta_bancaria_2: sharedValues.cuenta_bancaria_2,
          banco_2: sharedValues.banco_2,
          moneda_2: sharedValues.moneda_2,
          cuenta_bancaria_3: sharedValues.cuenta_bancaria_3,
          banco_3: sharedValues.banco_3,
          moneda_3: sharedValues.moneda_3,
        }
      : null;

    return {
      sharedFields,
      rows,
      catalogPrefill: finalCatalogPrefill,
      manualFields: finalManualFields,
      feedback,
    };
  };

  /** Descarga el xlsx desde el Paso 3 sin ir al Paso 4. */
  const handleDownloadHere = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(null);
    const payload = buildPayload();
    try {
      const { blob, filename } = await api.supplierIntelligence.generateXlsx({
        shared_fields: payload.sharedFields,
        rows: payload.rows,
        catalog_prefill: payload.catalogPrefill,
        manual_fields: payload.manualFields,
      });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);

      const fileKind = inferKind("", meta.filename);
      if (fileKind) {
        const pipelineUsage = combinePipelineUsage(meta, briefMetas);
        void api.supplierIntelligence
          .saveRun({
            filename: meta.filename,
            file_kind: fileKind,
            file_size: meta.size_bytes,
            ai_model: meta.model,
            shared_fields: payload.sharedFields,
            rows: payload.rows,
            catalog_prefill: payload.catalogPrefill,
            manual_fields: payload.manualFields,
            input_tokens: pipelineUsage.input_tokens,
            output_tokens: pipelineUsage.output_tokens,
            cost_usd: pipelineUsage.cost_usd,
            extraction_id: meta.extraction_id,
            feedback: payload.feedback,
          })
          .catch((err) => console.warn("saveRun failed (non-blocking):", err));
      }
    } catch (err) {
      setDownloadError(
        err instanceof ApiError
          ? err.message
          : "No pudimos generar el xlsx. Revisá tu conexión e intentá de nuevo.",
      );
    } finally {
      setDownloading(false);
    }
  };

  /**
   * Manda la tabla actual + el pedido del operador al asistente y reemplaza el
   * estado con la versión corregida que devuelve el backend.
   *
   * Se manda el JSON de la grilla, NO los documentos: el asistente corrige lo
   * que está en pantalla (recalcular precios con IVA, uniformar una política,
   * borrar filas sobrantes). Para algo que requiera volver a leer el contrato,
   * el camino sigue siendo "Volver a configuración" y re-extraer.
   */
  const handleChatSend = async (message: string) => {
    const msg = message.trim();
    if (!msg || chatBusy || downloading) return;

    const payload = buildPayload();
    setChatBusy(true);
    setChatError(null);
    setChatMessages((prev) => [...prev, { role: "user", content: msg }]);

    try {
      const res = await api.supplierIntelligence.refineTable({
        shared_fields: payload.sharedFields,
        rows: payload.rows,
        catalog_prefill: payload.catalogPrefill,
        manual_fields: payload.manualFields,
        message: msg,
        chat_history: chatMessages.map(
          (m): TableChatMessage => ({ role: m.role, content: m.content }),
        ),
        comments: comments.trim() || null,
      });

      // Guardamos el estado previo ANTES de pisarlo, para que "Deshacer" sea
      // una sola tecla si el asistente entendió mal.
      setUndoSnapshot({
        sharedValues,
        rows,
        rowSources,
      });

      const next = res.table;
      setSharedValues((prev) => {
        const merged: Record<string, string | null> = { ...prev };
        for (const k of AI_SHARED_KEYS) {
          merged[k] = next.shared_fields[k] ?? null;
        }
        for (const k of CATALOG_KEYS) {
          merged[k] = next.catalog_prefill?.[k] ?? null;
        }
        for (const k of MANUAL_KEYS) {
          merged[k] = next.manual_fields?.[k] ?? null;
        }
        return merged as Record<SharedKey, string | null>;
      });
      setRows(next.rows);
      // Re-alineamos las páginas de origen con el mapa que devuelve el
      // backend: sin esto, borrar una fila corre todos los tooltips de abajo.
      setRowSources((prev) =>
        res.row_index_map.map((origin) =>
          origin === null ? {} : (prev[origin] ?? {}),
        ),
      );

      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: res.reply, changes: res.changes },
      ]);
    } catch (err) {
      setChatError(
        describeRequestFailure(
          err,
          "No pudimos aplicar la corrección. Revisá tu conexión e intentá de nuevo.",
        ),
      );
      // El turno del usuario queda en el hilo (para que vea qué pidió) pero
      // sin respuesta: el error se muestra aparte.
    } finally {
      setChatBusy(false);
    }
  };

  const handleUndo = () => {
    if (!undoSnapshot || chatBusy) return;
    setSharedValues(undoSnapshot.sharedValues);
    setRows(undoSnapshot.rows);
    setRowSources(undoSnapshot.rowSources);
    setUndoSnapshot(null);
    setChatMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: "Deshice la última corrección — la tabla volvió a como estaba.",
      },
    ]);
  };

  const handleApprove = () => {
    onApprove(buildPayload());
  };

  const filledRowCells = useMemo(() => {
    let count = 0;
    const rowCols = ALL_COLUMNS.filter((c) => c.scope.kind === "row");
    for (const r of rows) {
      for (const c of rowCols) {
        const v = r[c.key as ExtractedRowFieldKey];
        if (typeof v === "string" && v.trim() !== "") count++;
      }
    }
    return count;
  }, [rows]);

  const rowCount = rows.length;
  const totalRowCells = rowCount * ALL_COLUMNS.filter((c) => c.scope.kind === "row").length;
  const completionPct =
    totalRowCells === 0 ? 0 : Math.round((filledRowCells / totalRowCells) * 100);

  // Sin useMemo manual: el React Compiler lo memoiza y la regla
  // preserve-manual-memoization no puede garantizar el memo a mano aquí.
  const rowFindings = qaRows({ rows, scan: preScanResult, brief: confirmedBrief, supplier });
  const hasQaErrors = worstSeverity(rowFindings) === "error";
  /** El usuario puede seguir con errores, pero tiene que decirlo. */
  const [ackQaErrors, setAckQaErrors] = useState(false);
  const qaBlocked = hasQaErrors && !ackQaErrors;

  return (
    <div className="px-5 sm:px-8 py-7 space-y-5">
      <QaFindingsPanel
        findings={rowFindings}
        title="Verificación automática de la tabla (sin IA)"
      />
      {hasQaErrors && (
        <label className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-100/90">
          <input
            type="checkbox"
            checked={ackQaErrors}
            onChange={(e) => setAckQaErrors(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-red-400"
          />
          <span>
            Revisé los errores de arriba y quiero continuar de todos modos. (Lo normal es
            corregirlos en la tabla o con el chat: cada error suele ser una celda que Utopía
            rechazará o una tarifa que falta.)
          </span>
        </label>
      )}

      {/* Summary banner */}
      <div className="rounded-xl border border-primary/30 bg-gradient-to-br from-primary/12 via-primary/6 to-transparent px-4 py-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
            <CheckCircle2 className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center flex-wrap gap-2">
              <p className="text-[14.5px] font-semibold text-foreground">
                Análisis completado
              </p>
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10.5px] font-semibold uppercase tracking-wider ${conf.bg} ${conf.border} ${conf.text}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${conf.dot}`} />
                {conf.label}
              </span>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-[10.5px] font-semibold uppercase tracking-wider text-emerald-300">
                <CheckCircle2 className="w-3 h-3" />
                {rowCount} {rowCount === 1 ? "fila" : "filas"}
              </span>
            </div>
            <p className="text-[12.5px] text-muted-foreground mt-1 truncate">
              {meta.filename} · {humanSize(meta.size_bytes)} · modelo {meta.model}
            </p>
          </div>
        </div>

        <div className="mt-3 space-y-1">
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-secondary/70 border border-border/50">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-emerald-400 shadow-[0_0_10px_0_hsl(var(--primary)/0.4)] transition-[width] duration-300 ease-out"
              style={{ width: `${completionPct}%` }}
            />
          </div>
          <p className="text-[10.5px] text-muted-foreground tabular-nums">
            {completionPct}% celdas variables con valor — {rowCount} ×{" "}
            {ALL_COLUMNS.filter((c) => c.scope.kind === "row").length} ={" "}
            {totalRowCells} celdas
          </p>
        </div>
      </div>

      {validation.warnings.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12.5px] text-amber-200">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-amber-100 mb-0.5">
              {validation.warnings.length === 1
                ? "1 advertencia"
                : `${validation.warnings.length} advertencias`}
            </p>
            <ul className="space-y-1">
              {validation.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <FullTable
        rows={rows}
        sharedValues={sharedValues}
        paginasOrigenShared={data.paginas_origen_shared}
        paginasOrigenRows={rowSources}
        camposFaltantes={data.campos_faltantes}
        filename={meta.filename}
        onSharedChange={setSharedField}
        onRowChange={setRowField}
        onAddRow={addRow}
        onRemoveRow={removeRow}
      />

      <TableChat
        messages={chatMessages}
        busy={chatBusy}
        error={chatError}
        canUndo={undoSnapshot !== null}
        disabled={downloading}
        onSend={handleChatSend}
        onUndo={handleUndo}
      />

      {downloadError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-[12.5px] text-red-200">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <p>{downloadError}</p>
        </div>
      )}

      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2 pt-2">
        <button
          type="button"
          onClick={onBack}
          disabled={downloading}
          className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg text-[13.5px] border border-border bg-secondary/40 text-foreground hover:bg-secondary/70 disabled:opacity-50"
        >
          <ArrowLeft className="w-4 h-4" />
          Volver a configuración
        </button>
        <div className="flex flex-col-reverse sm:flex-row gap-2">
          <button
            type="button"
            onClick={handleApprove}
            disabled={downloading || qaBlocked}
            className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg text-[13.5px] border border-border text-muted-foreground hover:bg-secondary/50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Continuar al resumen
          </button>
          <button
            type="button"
            onClick={() => void handleDownloadHere()}
            disabled={downloading || qaBlocked}
            className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px] disabled:opacity-60"
          >
            <Download className="w-4 h-4" />
            {downloading ? "Generando…" : "Descargar Excel"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   Full 52-col table
   ========================================================================== */

function FullTable({
  rows,
  sharedValues,
  paginasOrigenShared,
  paginasOrigenRows,
  camposFaltantes,
  filename,
  onSharedChange,
  onRowChange,
  onAddRow,
  onRemoveRow,
}: {
  rows: ExtractedContractRow[];
  sharedValues: Record<SharedKey, string | null>;
  paginasOrigenShared: Record<string, ExtractionSourcePage>;
  paginasOrigenRows: Record<string, ExtractionSourcePage>[];
  camposFaltantes: string[];
  filename: string;
  onSharedChange: (key: SharedKey, value: string | null) => void;
  onRowChange: (
    rowIdx: number,
    key: ExtractedRowFieldKey,
    value: string | null,
  ) => void;
  onAddRow: () => void;
  onRemoveRow: (rowIdx: number) => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card/60 overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border/60 gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-4 h-4 text-emerald-300" />
          </div>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-foreground">
              Datos del xlsx · {rows.length} {rows.length === 1 ? "fila" : "filas"}{" "}
              · {ALL_COLUMNS.length} columnas
            </p>
            <p className="text-[11.5px] text-muted-foreground">
              Todas las celdas son editables: clic para escribir, o elegí del
              desplegable cuando la columna tiene catálogo (con la opción
              «Escribir a mano» para valores fuera de lista). Las columnas con
              fondo sutil son <em className="italic">compartidas</em>: editar una
              propaga a todas las filas.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onAddRow}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-primary/40 bg-primary/10 text-primary text-[12.5px] font-semibold hover:bg-primary/15 transition-colors shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          Agregar fila
        </button>
      </header>

      {/*
        Caja de scroll de la tabla.

        Antes era `overflow-x-auto` sin alto: la barra horizontal vivía al
        fondo de la tabla entera, así que con muchas filas había que
        scrollear la página hasta abajo de todo para encontrarla. UX
        terrible (especialmente en contratos con >20 filas).

        Ahora `overflow-auto` + `max-h` acota la caja a ~viewport menos
        margen para nav + header + warnings + botón "Generar". El thead
        (`sticky top-0`) y la columna `#` (`sticky left-0`) ya estaban
        listos para esto — ahora "sticky" se ancla al borde de ESTA caja,
        no del viewport, así que el header se queda visible cuando se
        scrollea vertical adentro de la tabla y las dos scrollbars
        (vertical + horizontal) están siempre a mano.

        Usamos `dvh` (dynamic viewport) cuando esté disponible — en
        Safari móvil 100vh incluye la URL bar y la caja se cortaría.
        Fallback a `vh` para navegadores viejos.
      */}
      <div className="overflow-auto max-h-[calc(100vh-14rem)] supports-[height:100dvh]:max-h-[calc(100dvh-14rem)]">
        <table className="w-full border-collapse text-[12px]">
          <thead className="bg-secondary/40 border-b border-border/60 sticky top-0 z-10">
            <tr>
              <th
                scope="col"
                rowSpan={2}
                className="sticky left-0 z-20 bg-secondary/80 backdrop-blur px-2 py-1 text-left text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/90 border-r border-border/60 align-middle"
                style={{ minWidth: 44 }}
              >
                #
              </th>
              {ALL_COLUMNS.map((col) => {
                const isShared = col.scope.kind === "shared";
                const needsReview = COLS_NEEDING_REVIEW.has(col.key);
                return (
                  <th
                    key={col.excelCol}
                    scope="col"
                    className={`px-1.5 py-1 text-left border-r border-border/40 whitespace-nowrap align-bottom ${
                      isShared ? "bg-secondary/50" : ""
                    }`}
                    style={{ minWidth: col.minWidth }}
                  >
                    <div className="flex items-center gap-1">
                      <span
                        className="inline-flex items-center justify-center min-w-[26px] h-4 px-1 rounded border border-border/70 bg-card text-[10px] font-mono font-bold text-foreground/80 tabular-nums shrink-0"
                        title={`Columna ${col.excelCol}`}
                      >
                        {col.excelCol}
                      </span>
                      {needsReview && (
                        <span
                          title="Revisar — viene del catálogo lista-proveedores y el match es fuzzy."
                          className="text-amber-300 shrink-0"
                        >
                          <AlertTriangle className="w-3 h-3" />
                        </span>
                      )}
                    </div>
                  </th>
                );
              })}
              <th
                scope="col"
                rowSpan={2}
                className="px-1.5 py-1 text-right align-middle"
                style={{ minWidth: 40 }}
              >
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
            <tr>
              {ALL_COLUMNS.map((col) => {
                const isShared = col.scope.kind === "shared";
                return (
                  <th
                    key={col.excelCol + "_label"}
                    scope="col"
                    className={`px-1.5 pb-1.5 text-left border-r border-border/40 whitespace-nowrap font-semibold align-top ${
                      isShared ? "bg-secondary/50" : ""
                    }`}
                  >
                    <span className="text-[10.5px] uppercase tracking-wider text-foreground/90">
                      {col.label}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className="border-b border-border/30 last:border-b-0 hover:bg-secondary/10 transition-colors"
              >
                <td
                  className="sticky left-0 z-10 bg-card/95 backdrop-blur px-2 py-1 text-[11px] font-mono tabular-nums text-muted-foreground border-r border-border/40 align-top"
                  style={{ minWidth: 44 }}
                >
                  {rowIdx + 1}
                </td>
                {ALL_COLUMNS.map((col) => {
                  const isShared = col.scope.kind === "shared";
                  const value = isShared
                    ? sharedValues[col.key as SharedKey]
                    : row[col.key as ExtractedRowFieldKey];
                  // Source page
                  let source: ExtractionSourcePage | undefined;
                  if (isShared) {
                    source = paginasOrigenShared[col.key];
                  } else {
                    source = paginasOrigenRows[rowIdx]?.[col.key];
                  }
                  // Mark missing if backend listed this AI shared field as faltante
                  const isMarkedMissing =
                    isShared &&
                    col.scope.kind === "shared" &&
                    col.scope.source === "ai" &&
                    camposFaltantes.includes(col.key);

                  // Categoria (R) depende del tipo_servicio efectivo de
                  // ESTA fila (mixed bundles: hotel "HO" + tours "TO" en
                  // el mismo contrato necesitan listas de categorías
                  // distintas por fila).
                  const opts = col.options
                    ? col.options({ tipoServicio: row.tipo_servicio })
                    : undefined;
                  return (
                    <td
                      key={col.excelCol}
                      className={`p-0 align-top border-r border-border/30 ${
                        isShared ? "bg-secondary/15" : ""
                      }`}
                      style={{ minWidth: col.minWidth }}
                    >
                      <CellEditor
                        col={col}
                        value={value}
                        options={opts}
                        source={source}
                        filename={filename}
                        isMarkedMissing={isMarkedMissing}
                        tipoMoneda={sharedValues.tipo_moneda}
                        onSave={(v) => {
                          if (isShared) {
                            onSharedChange(col.key as SharedKey, v);
                          } else {
                            onRowChange(
                              rowIdx,
                              col.key as ExtractedRowFieldKey,
                              v,
                            );
                          }
                        }}
                      />
                    </td>
                  );
                })}
                <td className="px-1 py-1 text-right align-top">
                  <button
                    type="button"
                    onClick={() => onRemoveRow(rowIdx)}
                    disabled={rows.length <= 1}
                    aria-label={`Eliminar fila ${rowIdx + 1}`}
                    title={
                      rows.length <= 1
                        ? "Debe haber al menos 1 fila"
                        : "Eliminar fila"
                    }
                    className="inline-flex items-center justify-center h-7 w-7 rounded border border-transparent text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Valor centinela de la opción "escribir a mano" en las celdas con catálogo.
 * Elegirlo NO guarda nada: cambia la celda a un input de texto libre para que
 * ninguna columna quede bloqueada cuando el valor correcto no está en la lista
 * (catálogo desactualizado, código nuevo del proveedor, etc.).
 */
const FREE_TEXT_SENTINEL = "__tp_free_text__";

/**
 * Editor de celda. Click → modo edit (input/textarea/select). Enter / blur
 * commit. Escape cancel. Source-page se muestra como tooltip al hover.
 *
 * TODA celda es editable, incluidas las que tienen catálogo:
 *   - Si el catálogo tiene opciones, se muestra el `<select>` + la opción
 *     "✏️ Escribir a mano" para meter un valor fuera de lista.
 *   - Si el catálogo llega vacío (ej. `categoria` cuando la fila todavía no
 *     tiene `tipo_servicio`), caemos directo a texto libre en lugar de
 *     renderizar un desplegable sin opciones que no deja corregir nada.
 */
function CellEditor({
  col,
  value,
  options,
  source,
  filename,
  isMarkedMissing,
  tipoMoneda,
  onSave,
}: {
  col: ColumnDef;
  value: string | null;
  options: ReadonlyArray<SelectOption> | undefined;
  source: ExtractionSourcePage | undefined;
  filename: string;
  isMarkedMissing: boolean;
  /**
   * Código de moneda del contrato (`sharedFields.tipo_moneda`). Solo lo
   * usamos cuando `col.currency` está activo — vive a nivel de contrato,
   * no de fila, así que se prefija a *todas* las columnas monetarias.
   */
  tipoMoneda: string | null;
  onSave: (v: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  /**
   * True mientras el usuario escribe a mano en una celda que normalmente
   * muestra un desplegable. Se apaga al confirmar o cancelar, así la celda
   * vuelve a su forma de catálogo (con el valor nuevo marcado como "fuera de
   * catálogo" si corresponde).
   */
  const [freeText, setFreeText] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const hasOptions = !!options && options.length > 0;
  const isSelect = hasOptions && !freeText;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEdit = () => {
    setDraft(value ?? "");
    setEditing(true);
  };
  const commit = () => {
    const trimmed = draft.trim();
    onSave(trimmed === "" ? null : trimmed);
    setEditing(false);
    setFreeText(false);
    setDraft("");
  };
  const cancel = () => {
    setEditing(false);
    setFreeText(false);
    setDraft("");
  };
  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (e.key === "Enter" && !e.shiftKey && !col.multiline) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  const tooltip = useMemo(() => {
    if (source === undefined) return undefined;
    const base =
      typeof source === "number"
        ? `Página ${source}`
        : source === "inferido"
          ? "Inferido"
          : source === "multiple"
            ? "Múltiples páginas"
            : `Página ${source}`;
    return `${base} · ${filename}`;
  }, [source, filename]);

  if (isSelect) {
    const valueInOpts =
      value !== null && options!.some((o) => o.codigo === value);
    return (
      <select
        value={value ?? ""}
        onChange={(e) => {
          const next = e.target.value;
          if (next === FREE_TEXT_SENTINEL) {
            // No es un valor: es "quiero escribirlo yo". Abrimos el input con
            // el valor actual como borrador para que se pueda ajustar en vez
            // de tener que retipearlo entero.
            setDraft(value ?? "");
            setFreeText(true);
            setEditing(true);
            return;
          }
          onSave(next === "" ? null : next);
        }}
        title={tooltip}
        aria-label={col.label}
        className="w-full h-7 rounded border border-transparent bg-transparent px-1 text-[12px] text-foreground outline-none hover:border-border focus:border-primary/60 focus:bg-secondary/40 cursor-pointer"
      >
        <option value="">—</option>
        {options!.map((opt) => (
          <option key={opt.codigo} value={opt.codigo}>
            {opt.codigo} · {opt.descripcion}
          </option>
        ))}
        {value && !valueInOpts && (
          <option value={value} className="italic">
            {value} (fuera de catálogo)
          </option>
        )}
        <option value={FREE_TEXT_SENTINEL}>✏️ Escribir a mano…</option>
      </select>
    );
  }

  if (editing) {
    return col.multiline ? (
      <textarea
        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commit}
        placeholder={col.placeholder}
        rows={3}
        className="w-full resize-y rounded border border-primary/60 bg-secondary/40 px-1.5 py-1 text-[12px] leading-relaxed text-foreground outline-none focus:border-primary"
      />
    ) : (
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type={col.inputType ?? "text"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commit}
        placeholder={col.placeholder}
        className="w-full h-7 rounded border border-primary/60 bg-secondary/40 px-1.5 text-[12px] text-foreground outline-none focus:border-primary"
      />
    );
  }

  const missing = value === null || value === "";
  // Aplicamos formato solo cuando hay valor: las fechas se muestran en
  // YYYY-MM-DD (mismo formato que el storage) y las columnas con
  // `currency` muestran el código de moneda del contrato (ej. "USD 295",
  // "CRC 150000"). El aria-label usa el valor formateado para que un
  // lector de pantalla dicte la misma cifra que ve el usuario.
  const displayValue = missing ? "" : formatCellDisplay(col, value, tipoMoneda);
  return (
    <button
      type="button"
      onClick={startEdit}
      title={tooltip}
      aria-label={`${col.label} — ${missing ? "vacío" : displayValue}. Clic para editar.`}
      className={`w-full min-h-[1.75rem] text-left rounded border border-transparent px-1.5 py-1 text-[12px] leading-snug transition-colors hover:border-border hover:bg-secondary/30 focus:outline-none focus:border-primary/60 focus:bg-secondary/40 ${
        missing
          ? "text-muted-foreground/50 italic"
          : "text-foreground"
      } ${col.multiline ? "whitespace-pre-wrap break-words" : "truncate"}`}
    >
      {missing
        ? isMarkedMissing
          ? "no encontrado"
          : "—"
        : displayValue}
    </button>
  );
}

/* ============================================================================
   STEP 3 — Generate + Download
   ========================================================================== */

function DownloadStep({
  payload,
  meta,
  briefMetas,
  onReset,
}: {
  payload: ApprovedPayload;
  meta: ExtractContractResponse["meta"];
  /** Telemetría del pre-análisis (Paso 2), uno por documento. */
  briefMetas: AnalyzeBriefMeta[];
  onReset: () => void;
}) {
  const [phase, setPhase] = useState<"generating" | "ready" | "error">(
    "generating",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /**
   * Blob descargado. Lo mantenemos en state como `objectURL` para que el
   * botón <a download> pueda apuntar a él. El URL se revoca cuando el
   * componente se desmonta (procesar otro contrato) — ver el cleanup del
   * useEffect de abajo.
   */
  const [ready, setReady] = useState<{
    objectUrl: string;
    filename: string;
    sizeBytes: number;
  } | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    // `startedRef` ya garantiza una sola llamada al backend incluso bajo
    // StrictMode (que monta-desmonta-monta el componente). No usamos un flag
    // `cancelled` capturado en el closure porque, al combinarse con el
    // early-return de `startedRef`, dejaba la promesa original cancelada
    // permanentemente: el cleanup del primer mount ponía `cancelled = true`
    // y el segundo mount no relanzaba la fetch — resultado: phase se quedaba
    // en "generating" para siempre y el botón de descarga no aparecía.
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      try {
        const { blob, filename } = await api.supplierIntelligence.generateXlsx({
          shared_fields: payload.sharedFields,
          rows: payload.rows,
          catalog_prefill: payload.catalogPrefill,
          manual_fields: payload.manualFields,
        });

        const objectUrl = URL.createObjectURL(blob);

        // Best-effort: intentamos disparar la descarga automáticamente. Si el
        // navegador la bloquea (algunos lo hacen cuando la descarga ocurre
        // después de un fetch sin "user gesture" inmediato), no pasa nada —
        // el usuario tiene el botón "Descargar xlsx" abajo como fallback.
        try {
          const a = document.createElement("a");
          a.href = objectUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } catch {
          // Silent — el botón manual sigue funcionando.
        }

        setReady({ objectUrl, filename, sizeBytes: blob.size });
        setPhase("ready");

        // Fire-and-forget: persistimos el run para Historial + métricas.
        // Un fallo aquí NO debe bloquear al usuario — ya tiene el xlsx
        // descargado. Si el guardado falla, se pierde solo la entrada
        // de Historial (el usuario puede re-procesar el contrato).
        const fileKind = inferKind("", meta.filename);
        if (fileKind) {
          const pipelineUsage = combinePipelineUsage(meta, briefMetas);
          void api.supplierIntelligence
            .saveRun({
              filename: meta.filename,
              file_kind: fileKind,
              file_size: meta.size_bytes,
              ai_model: meta.model,
              shared_fields: payload.sharedFields,
              rows: payload.rows,
              catalog_prefill: payload.catalogPrefill,
              manual_fields: payload.manualFields,
              // Pre-análisis (Paso 2, Sonnet 5.5) + extracción (Paso 3, Opus 5.5), cada pasada a su tarifa.
              input_tokens: pipelineUsage.input_tokens,
              output_tokens: pipelineUsage.output_tokens,
              cost_usd: pipelineUsage.cost_usd,
              extraction_id: meta.extraction_id,
              feedback: payload.feedback,
            })
            .catch((err) => {
              // Logueamos a console para que sea visible en dev / Sentry,
              // pero no afectamos la UX. Tracking real cuando exista.
              console.warn("saveRun failed (non-blocking):", err);
            });
        }
      } catch (err) {
        if (err instanceof ApiError) {
          setErrorMsg(err.message);
        } else {
          setErrorMsg(
            "No pudimos generar el xlsx. Revisa tu conexión e intenta de nuevo.",
          );
        }
        setPhase("error");
      }
    })();
  }, [payload, meta, briefMetas]);

  // Revoca el blob URL al desmontar el componente (ej. cuando el usuario
  // hace clic en "Procesar otro contrato"). Hasta entonces lo mantenemos
  // vivo para que el botón <a download> siga funcionando si el usuario
  // hace clic varias veces.
  useEffect(() => {
    const url = ready?.objectUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [ready?.objectUrl]);

  if (phase === "generating") {
    return <DownloadInProgressCard rowCount={payload.rows.length} meta={meta} />;
  }
  if (phase === "error") {
    return (
      <DownloadErrorCard
        message={errorMsg ?? "Error desconocido."}
        onReset={onReset}
      />
    );
  }
  return (
    <DownloadReadyCard
      objectUrl={ready?.objectUrl ?? ""}
      filename={ready?.filename ?? "contrato.xlsx"}
      sizeBytes={ready?.sizeBytes ?? 0}
      rowCount={payload.rows.length}
      meta={meta}
      onReset={onReset}
    />
  );
}

function DownloadInProgressCard({
  rowCount,
  meta,
}: {
  rowCount: number;
  meta: ExtractContractResponse["meta"];
}) {
  return (
    <div className="px-5 sm:px-8 py-10 space-y-6">
      <div className="mx-auto max-w-md text-center">
        <div className="relative mx-auto w-20 h-20 rounded-2xl bg-primary/10 border border-primary/30 flex items-center justify-center animate-pulse-glow">
          <Cloud className="w-9 h-9 text-primary" />
          <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-lg bg-card border border-primary/40 flex items-center justify-center shadow-[0_0_12px_0_hsl(var(--primary)/0.4)]">
            <FileSpreadsheet className="w-4 h-4 text-emerald-300" />
          </div>
        </div>
        <h3 className="mt-5 text-[18px] font-semibold text-foreground">
          Generando xlsx
        </h3>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          Estamos escribiendo {rowCount} {rowCount === 1 ? "fila" : "filas"}{" "}
          en la plantilla.
        </p>
      </div>

      <div className="mx-auto max-w-xl rounded-xl border border-primary/30 bg-primary/5 px-4 py-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-secondary/70 border border-border flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-4 h-4 text-emerald-300" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">
              Origen: {meta.filename}
            </p>
            <p className="text-[11.5px] text-muted-foreground truncate">
              {rowCount} {rowCount === 1 ? "combinación" : "combinaciones"} product
              × season
            </p>
          </div>
          <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Si tarda más de 10s, verifica que el backend esté corriendo y reinicia{" "}
          <code className="px-1 rounded bg-secondary/60 text-foreground/80">
            npm run dev
          </code>{" "}
          si recién agregaste rutas nuevas.
        </p>
      </div>
    </div>
  );
}

/**
 * Pantalla "xlsx listo para descargar". El CTA principal es un `<a download>`
 * que apunta al blob URL — esto es lo más confiable: el navegador ve la
 * acción como una descarga iniciada por gesto explícito del usuario.
 *
 * Por debajo intentamos disparar la descarga automáticamente cuando llegó la
 * respuesta (ver DownloadStep), pero ese auto-click puede ser bloqueado por
 * el navegador. Este botón siempre funciona.
 */
function DownloadReadyCard({
  objectUrl,
  filename,
  sizeBytes,
  rowCount,
  meta,
  onReset,
}: {
  objectUrl: string;
  filename: string;
  sizeBytes: number;
  rowCount: number;
  meta: ExtractContractResponse["meta"];
  onReset: () => void;
}) {
  return (
    <div className="px-5 sm:px-8 py-10 space-y-7">
      <div className="mx-auto max-w-md text-center">
        <div className="relative mx-auto w-20 h-20 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-300" />
          <div
            aria-hidden
            className="absolute inset-0 rounded-2xl ring-2 ring-emerald-400/30 animate-ping pointer-events-none"
          />
        </div>
        <h3 className="mt-5 text-[18px] font-semibold text-foreground">
          xlsx listo para descargar
        </h3>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          Hacé clic en <strong className="text-foreground">Descargar xlsx</strong> abajo
          para guardar el archivo en tu equipo.
        </p>
      </div>

      <div className="mx-auto max-w-xl rounded-xl border border-emerald-500/30 bg-emerald-500/5 divide-y divide-border/50">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-4 h-4 text-emerald-300" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">
              {filename}
            </p>
            <p className="text-[11.5px] text-muted-foreground truncate">
              {humanSize(sizeBytes)} · {rowCount}{" "}
              {rowCount === 1 ? "fila" : "filas"} · listo
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="w-9 h-9 rounded-lg bg-secondary/70 border border-border flex items-center justify-center shrink-0">
            <CloudUpload className="w-4 h-4 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[12.5px] text-foreground truncate">
              Origen: {meta.filename}
            </p>
            <p className="text-[11px] text-muted-foreground truncate">
              {humanSize(meta.size_bytes)} · modelo {meta.model}
            </p>
          </div>
        </div>
      </div>

      {/* CTA principal: <a download> apuntando al blob. Más confiable que
          a.click() programático, porque cuenta como user-gesture explícito. */}
      <div className="mx-auto max-w-xl flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-border bg-secondary/40 text-[13.5px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <RotateCcw className="w-4 h-4" />
          Procesar otro contrato
        </button>
        <a
          href={objectUrl}
          download={filename}
          className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
        >
          <Download className="w-4 h-4" />
          Descargar xlsx
        </a>
      </div>
    </div>
  );
}

function DownloadErrorCard({
  message,
  onReset,
}: {
  message: string;
  onReset: () => void;
}) {
  return (
    <div className="px-5 sm:px-8 py-10 space-y-6">
      <div className="mx-auto max-w-md text-center">
        <div className="mx-auto w-20 h-20 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center">
          <AlertTriangle className="w-10 h-10 text-rose-300" />
        </div>
        <h3 className="mt-5 text-[18px] font-semibold text-foreground">
          No pudimos generar el xlsx
        </h3>
        <p className="mt-1.5 text-[13px] text-muted-foreground break-words">
          {message}
        </p>
      </div>
      <div className="mx-auto max-w-xl flex justify-center">
        <button
          type="button"
          onClick={onReset}
          className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
        >
          <RotateCcw className="w-4 h-4" />
          Volver al inicio
        </button>
      </div>
    </div>
  );
}
