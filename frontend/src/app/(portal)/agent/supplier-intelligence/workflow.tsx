"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Cloud,
  CloudUpload,
  FileSpreadsheet,
  FileText,
  Loader2,
  MessageSquareText,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  UserCheck,
  UserPlus,
  Download,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  api,
  ApiError,
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
} from "@/lib/api";
import {
  findSupplierByNameWithAI,
  findServiceForSupplierWithAI,
  type SupplierMatch,
} from "@/lib/supplierLookup";
import {
  CATEGORIAS_BY_TIPO_SERVICIO,
  TIPOS_SERVICIO,
} from "@/lib/serviceTypesCatalog";

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

type Step = 1 | 2 | 3;

export type FileKind = "pdf" | "docx" | "xlsx";

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
].join(",");

const STEPS: { id: Step; label: string; hint: string }[] = [
  { id: 1, label: "Cargar documento", hint: "PDF, Word o Excel · máx 20 MB" },
  { id: 2, label: "Revisar información", hint: "Tabla con todas las filas" },
  { id: 3, label: "Descargar xlsx", hint: "Genera el archivo final" },
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
  return null;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(kind: FileKind) {
  if (kind === "xlsx")
    return <FileSpreadsheet className="w-4 h-4 text-emerald-300" />;
  if (kind === "docx") return <FileText className="w-4 h-4 text-sky-300" />;
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
}

export function SupplierWorkflow() {
  const [step, setStep] = useState<Step>(1);
  /**
   * Files queued for extraction. Order is preserved end-to-end: the first
   * file is treated as the "primary" contract by the backend (its name is
   * what populates `meta.filename` once combined), and additional files are
   * sent as supporting documents (amendments, price lists, etc.).
   */
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<ExtractContractResponse | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [comments, setComments] = useState("");
  const [isExistingSupplier, setIsExistingSupplier] = useState<boolean | null>(
    null,
  );
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
    if (!analyzing) return;
    const id = window.setInterval(() => {
      setProgress((p) => {
        if (p >= 90) return p;
        const step = Math.max(0.4, (90 - p) * 0.06);
        return Math.min(90, p + step);
      });
    }, 180);
    return () => window.clearInterval(id);
  }, [analyzing]);

  /**
   * Validate and append a batch of newly picked / dropped files to the queue.
   * Validation errors are aggregated into a single `uploadError` line per
   * batch so the user sees every problem at once instead of having to retry
   * file-by-file. Duplicates (by name + size) are skipped silently — the
   * user dragging the same file twice is almost always an accident.
   *
   * The first error sentence in the message is the one most likely to be
   * actionable, so keep it specific (which file, what limit, what size).
   */
  const acceptFiles = (incoming: FileList | File[]) => {
    setServerError(null);

    const list = Array.from(incoming);
    if (list.length === 0) {
      setUploadError(null);
      return;
    }

    // We validate against the CURRENT files state up-front (read once via
    // the functional getter we already have). The state updater itself must
    // stay pure — pushing into outer arrays from inside `setSelectedFiles`
    // would double-count files under React strict mode (the updater runs
    // twice in development).
    setSelectedFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}|${f.size}`));
      const accepted: File[] = [];
      const errors: string[] = [];

      for (const file of list) {
        const kind = inferKind(file.type, file.name);
        if (!kind) {
          errors.push(
            `${file.name}: formato no admitido. Usa PDF, Word o Excel.`,
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
          // Silently skip duplicates — most often a drag-and-drop double-fire.
          continue;
        }
        if (prev.length + accepted.length >= MAX_FILES_PER_REQUEST) {
          errors.push(
            `Máximo ${MAX_FILES_PER_REQUEST} documentos por análisis — se descartó "${file.name}".`,
          );
          continue;
        }
        seen.add(key);
        accepted.push(file);
      }

      // Surface validation errors as part of the same render. Safe to call
      // from inside the updater: setState calls are batched and idempotent
      // even if the updater itself runs twice in strict mode.
      setUploadError(errors.length > 0 ? errors.join(" ") : null);

      if (accepted.length === 0) return prev;
      return [...prev, ...accepted];
    });
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    // Materialize the FileList into a real array immediately. DataTransfer
    // objects are short-lived and the spec lets browsers null them out once
    // the drop event has been dispatched.
    acceptFiles(Array.from(files));
  };

  const handlePick = (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    // Snapshot the FileList BEFORE resetting the input's value. Setting
    // `value = ""` clears the input's associated FileList in some browsers,
    // which would leave `acceptFiles` with an empty iterable and silently
    // drop the selection — that's the bug that made step 1 look like
    // nothing happened after picking files.
    const files = Array.from(fileList);
    e.target.value = "";
    acceptFiles(files);
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
    setUploadError(null);
    setServerError(null);
  };

  const clearFiles = () => {
    setSelectedFiles([]);
    setUploadError(null);
    setServerError(null);
  };

  const startAnalysis = async () => {
    if (selectedFiles.length === 0 || analyzing || isExistingSupplier === null) {
      return;
    }
    setAnalyzing(true);
    setServerError(null);
    setProgress(4);
    try {
      const response = await api.supplierIntelligence.extract(selectedFiles, {
        comments,
        isExistingSupplier,
      });
      setProgress(100);

      let prefill: CatalogPrefill | null = null;
      let matchInfo: CatalogMatchInfo | null = null;
      if (isExistingSupplier) {
        setMatchingPhase("local");
        const sharedNames = [
          response.data.shared_fields.nombre_comercial,
          response.data.shared_fields.proveedor,
        ]
          .map((s) => s?.trim())
          .filter((s): s is string => !!s);
        if (sharedNames.length === 0) {
          matchInfo = { status: "skipped", reason: "no_query" };
        } else {
          let match: SupplierMatch | null = null;
          let aiAttempted = false;
          for (const c of sharedNames) {
            match = await findSupplierByNameWithAI(c, { enableAIFallback: false });
            if (match) break;
          }
          if (!match) {
            setMatchingPhase("ai");
            aiAttempted = true;
            match = await findSupplierByNameWithAI(sharedNames[0] as string, {
              enableAIFallback: true,
            });
          }
          if (match) {
            // Construimos un contexto rico para el matcher de servicios.
            // CRÍTICO: `product_name`, `categoria` y `meals_included` son
            // ROW-level (no shared), pero son la señal más fuerte para elegir
            // entre servicios del mismo proveedor (ej: PARADOR tiene
            // GARDENEU vs GARDENUS vs VISTASEU vs MASUITEU — sin
            // "Garden"/"Vista Suites"/"Master Suites" la IA tiene que
            // adivinar entre 50+ códigos).
            //
            // `tipo_moneda` se incluye como proxy de mercado:
            // USD/CAD → US & CA, EUR → Europe, CRC → mercado local.
            const shared = response.data.shared_fields;
            const rows = response.data.rows ?? [];
            // Dedupe + cap para no inflar tokens si el contrato tiene 50
            // filas con product_names únicos.
            const dedupe = (xs: Array<string | null>, cap: number): string[] =>
              Array.from(
                new Set(xs.filter((s): s is string => !!s && s.trim() !== "")),
              ).slice(0, cap);
            const productNames = dedupe(rows.map((r) => r.product_name), 8);
            const categorias = dedupe(rows.map((r) => r.categoria), 6);
            const meals = dedupe(rows.map((r) => r.meals_included), 4);

            const hintParts = [
              shared.tipo_servicio
                ? `Tipo servicio: ${shared.tipo_servicio}`
                : null,
              shared.tipo_unidad
                ? `Tipo unidad: ${shared.tipo_unidad}`
                : null,
              shared.nombre_comercial
                ? `Proveedor: ${shared.nombre_comercial}`
                : null,
              productNames.length > 0
                ? `Productos: ${productNames.join(", ")}`
                : null,
              categorias.length > 0
                ? `Categorías: ${categorias.join(", ")}`
                : null,
              meals.length > 0 ? `Meals: ${meals.join(", ")}` : null,
              shared.tipo_moneda ? `Moneda: ${shared.tipo_moneda}` : null,
              shared.pais ? `País proveedor: ${shared.pais}` : null,
              comments?.trim() ? `Notas: ${comments.trim()}` : null,
              selectedFiles[0]?.name
                ? `Archivo: ${selectedFiles[0].name}` +
                  (selectedFiles.length > 1
                    ? ` (+${selectedFiles.length - 1} más)`
                    : "")
                : null,
            ].filter((s): s is string => s !== null);
            const serviceHint = hintParts.join(" · ");

            // Fallback IA si el proveedor tiene varios servicios y el matcher
            // local no resuelve. La llamada es fire-and-await: si falla
            // (red, backend caído, rate limit) el hook devuelve null y el
            // campo queda vacío — el usuario lo llena en step 2.
            setMatchingPhase("ai");
            const serviceMatch = await findServiceForSupplierWithAI(
              match.supplier,
              serviceHint,
              { enableAIFallback: true },
            );
            setMatchingPhase(null);

            prefill = {
              tipo_actividad: match.supplier.actividad,
              zona_turismo: match.supplier.zona,
              proveedor_codigo: match.supplier.codigo,
              codigo_servicio: serviceMatch?.service.codigo ?? null,
            };
            matchInfo = {
              status: "matched",
              supplierName: match.supplier.nombre ?? match.supplier.codigo,
              supplierCode: match.supplier.codigo,
              matchedBy: match.matchedBy,
              serviceMatched: serviceMatch !== null,
              aiConfidence: match.aiConfidence,
              aiReasoning: match.aiReasoning,
            };
          } else {
            matchInfo = {
              status: "not_found",
              query: sharedNames[0] as string,
              aiAttempted,
            };
          }
        }
        setMatchingPhase(null);
      } else {
        matchInfo = { status: "skipped", reason: "new_supplier" };
      }
      setCatalogPrefill(prefill);
      setCatalogMatchInfo(matchInfo);

      await new Promise((r) => setTimeout(r, 450));
      setResult(response);
      setStep(2);
    } catch (err) {
      if (err instanceof ApiError) {
        setServerError(err.message);
      } else {
        setServerError(
          "No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.",
        );
      }
      setProgress(0);
    } finally {
      setAnalyzing(false);
      setMatchingPhase(null);
    }
  };

  const reset = () => {
    setStep(1);
    setSelectedFiles([]);
    setResult(null);
    setUploadError(null);
    setServerError(null);
    setProgress(0);
    setComments("");
    setIsExistingSupplier(null);
    setCatalogPrefill(null);
    setCatalogMatchInfo(null);
    setMatchingPhase(null);
    setApprovedPayload(null);
  };

  const approve = (payload: ApprovedPayload) => {
    setApprovedPayload(payload);
    setStep(3);
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
            progress={progress}
            matchingPhase={matchingPhase}
            fileInputRef={fileInputRef}
            comments={comments}
            onCommentsChange={setComments}
            isExistingSupplier={isExistingSupplier}
            onExistingSupplierChange={setIsExistingSupplier}
            onDrop={handleDrop}
            onPick={handlePick}
            onRemoveFile={removeFile}
            onClearAll={clearFiles}
            onStart={startAnalysis}
          />
        )}

        {step === 2 && result && (
          <ReviewStep
            result={result}
            catalogPrefill={catalogPrefill}
            onApprove={approve}
          />
        )}

        {step === 3 && result && approvedPayload && (
          <DownloadStep
            payload={approvedPayload}
            meta={result.meta}
            onReset={reset}
          />
        )}
      </div>
    </section>

    <div className="text-center mt-4 space-y-1">
      <p className="text-[11px] text-muted-foreground/60">Version 1.0.0 - Mayo 18</p>
      <a
        href="https://forms.gle/GANUbdcuAS3P7szS8"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[11px] text-primary/70 hover:text-primary transition-colors"
      >
        ¿Encontraste un bug? Repórtalo
      </a>
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
  progress,
  matchingPhase,
  fileInputRef,
  comments,
  onCommentsChange,
  isExistingSupplier,
  onExistingSupplierChange,
  onDrop,
  onPick,
  onRemoveFile,
  onClearAll,
  onStart,
}: {
  files: File[];
  uploadError: string | null;
  serverError: string | null;
  analyzing: boolean;
  progress: number;
  matchingPhase: "local" | "ai" | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  comments: string;
  onCommentsChange: (value: string) => void;
  isExistingSupplier: boolean | null;
  onExistingSupplierChange: (value: boolean) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onPick: (e: ChangeEvent<HTMLInputElement>) => void;
  onRemoveFile: (index: number) => void;
  onClearAll: () => void;
  onStart: () => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const COMMENTS_MAX = 5000;
  const totalBytes = useMemo(
    () => files.reduce((acc, f) => acc + f.size, 0),
    [files],
  );
  const hasFiles = files.length > 0;
  const slotsLeft = MAX_FILES_PER_REQUEST - files.length;
  const canAddMore = slotsLeft > 0 && !analyzing;
  const canSubmit = hasFiles && !analyzing && isExistingSupplier !== null;

  return (
    <div className="px-5 sm:px-8 py-7 space-y-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (canAddMore) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          setDragActive(false);
          if (!canAddMore) {
            e.preventDefault();
            return;
          }
          onDrop(e);
        }}
        onClick={() => {
          if (canAddMore) fileInputRef.current?.click();
        }}
        role="button"
        tabIndex={0}
        aria-disabled={!canAddMore}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && canAddMore) {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={`group rounded-2xl border-2 border-dashed p-8 sm:p-10 text-center transition-all ${
          !canAddMore
            ? "cursor-not-allowed opacity-60 border-border bg-secondary/20"
            : dragActive
              ? "cursor-pointer border-primary bg-primary/10 shadow-[0_0_30px_0_hsl(var(--primary)/0.25)]"
              : "cursor-pointer border-border bg-secondary/20 hover:border-primary/50 hover:bg-primary/5"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          onChange={onPick}
          className="hidden"
        />
        <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center animate-pulse-glow">
          <CloudUpload className="w-6 h-6 text-primary" />
        </div>
        <p className="mt-4 text-[15px] font-semibold text-foreground">
          {hasFiles
            ? "Arrastra documentos adicionales aquí"
            : "Arrastra tus contratos aquí"}
        </p>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          o{" "}
          <span className="text-primary font-medium">
            haz click para buscar
          </span>
          {hasFiles ? " más archivos" : ""} en tu equipo
        </p>
        <div className="mt-4 inline-flex items-center gap-2 text-[11px] text-muted-foreground/80">
          <Badge label="PDF" />
          <Badge label="DOCX" />
          <Badge label="XLSX" />
          <span className="opacity-60">
            · hasta 20 MB c/u · máx {MAX_FILES_PER_REQUEST} archivos
          </span>
        </div>
      </div>

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

      {hasFiles && !analyzing && (
        <div className="rounded-xl border border-border bg-card/60">
          <header className="flex items-center justify-between px-4 py-3 border-b border-border/60">
            <p className="text-[12.5px] font-semibold text-foreground">
              {files.length === 1
                ? "Documento listo para analizar"
                : `${files.length} documentos listos para analizar`}
            </p>
            <div className="flex items-center gap-3">
              <p className="text-[11.5px] text-muted-foreground">
                {humanSize(totalBytes)} total
              </p>
              {files.length > 1 && (
                <button
                  type="button"
                  onClick={onClearAll}
                  className="text-[11px] text-muted-foreground hover:text-destructive transition-colors"
                >
                  Quitar todos
                </button>
              )}
            </div>
          </header>
          <ul className="divide-y divide-border/60">
            {files.map((f, idx) => {
              const fkind = inferKind(f.type, f.name);
              return (
                <li
                  key={`${f.name}|${f.size}|${idx}`}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <div className="w-8 h-8 rounded-lg bg-secondary/70 border border-border/60 flex items-center justify-center shrink-0">
                    {fkind ? (
                      fileIcon(fkind)
                    ) : (
                      <FileText className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] text-foreground truncate">
                      {idx === 0 && files.length > 1 ? (
                        <>
                          <span className="text-primary font-medium">
                            Principal:
                          </span>{" "}
                          {f.name}
                        </>
                      ) : (
                        f.name
                      )}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {humanSize(f.size)}
                      {fkind ? ` · ${fkind.toUpperCase()}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveFile(idx)}
                    aria-label={`Quitar ${f.name}`}
                    className="text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </li>
              );
            })}
          </ul>
          {canAddMore && (
            <div className="px-4 py-2.5 border-t border-border/60">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 text-[12px] text-primary hover:text-primary/80 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Agregar otro documento
                <span className="text-muted-foreground/80">
                  ({slotsLeft} {slotsLeft === 1 ? "disponible" : "disponibles"})
                </span>
              </button>
            </div>
          )}
        </div>
      )}

      {hasFiles && analyzing && (
        <AnalysisProgressCard
          files={files}
          totalBytes={totalBytes}
          progress={progress}
          matchingPhase={matchingPhase}
        />
      )}

      <ExistingSupplierToggle
        value={isExistingSupplier}
        onChange={onExistingSupplierChange}
        disabled={analyzing}
      />

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
              {matchingPhase === "ai"
                ? "Buscando proveedor con IA…"
                : "Analizando contrato…"}
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

function ExistingSupplierToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean | null;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  const untouched = value === null;
  return (
    <div
      className={`rounded-xl border bg-card/60 transition-colors ${
        untouched ? "border-amber-500/40" : "border-border"
      }`}
    >
      <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold text-foreground">
            ¿Es un proveedor existente?{" "}
            <span className="text-rose-300" aria-hidden>
              *
            </span>
          </p>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            Indica si el proveedor ya existe en el sistema o es uno nuevo.
            Campo requerido.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="¿Es un proveedor existente?"
          aria-required="true"
          className="inline-flex shrink-0 self-start rounded-lg border border-border bg-secondary/40 p-0.5 sm:self-auto"
        >
          <ToggleButton
            icon={UserCheck}
            label="Sí, existente"
            active={value === true}
            disabled={disabled}
            onClick={() => onChange(true)}
          />
          <ToggleButton
            icon={UserPlus}
            label="No, es nuevo"
            active={value === false}
            disabled={disabled}
            onClick={() => onChange(false)}
          />
        </div>
      </div>
    </div>
  );
}

function ToggleButton({
  icon: Icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? "bg-primary text-primary-foreground shadow-[0_0_10px_0_hsl(var(--primary)/0.35)]"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary/70"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
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
          A veces el correo trae datos que no están en los documentos
          (cuenta bancaria, referencia, instrucciones). Pégalos aquí y la IA
          los usará como contexto adicional.
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

function analysisPhase(progress: number): string {
  if (progress < 25) return "Preparando el documento…";
  if (progress < 75) return "Extrayendo campos con IA…";
  if (progress < 100) return "Validando datos extraídos…";
  return "Listo";
}

function AnalysisProgressCard({
  files,
  totalBytes,
  progress,
  matchingPhase,
}: {
  files: File[];
  totalBytes: number;
  progress: number;
  matchingPhase: "local" | "ai" | null;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  const phase =
    matchingPhase === "ai"
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
          {matchingPhase === "ai"
            ? "Pidiéndole a Claude que elija el proveedor del catálogo. Opus 4.6 puede tardar 30-60s para contratos con muchas combinaciones."
            : files.length > 1
              ? `Opus 4.6 está consolidando ${files.length} documentos. Puede tardar varios minutos — mantén esta pestaña abierta.`
              : "Opus 4.6 puede tardar entre 30 y 90 segundos para contratos con muchas filas (ej. 21 combinaciones)."}
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
 * Formatea una fecha ISO (`yyyy-mm-dd`) al formato US `mm/dd/yyyy` que el
 * negocio prefiere ver en la grilla. Si el valor no calza con ISO (por
 * ejemplo porque la IA extrajo "31/12/2026" tal cual), lo devolvemos sin
 * tocar — preferimos mostrar algo legible a "Invalid Date".
 */
function formatDateDisplay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : value;
}

/**
 * Devuelve el valor formateado para mostrar en la celda read-only:
 *   - Fechas ISO → mm/dd/yyyy
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
  { excelCol: "N",  key: "codigo_servicio",   label: "Cod. Servicio",      scope: { kind: "shared", source: "catalog" }, minWidth: 130, placeholder: "Ej: PARADOR-HO" },
  { excelCol: "O",  key: "product_name",      label: "Product Name",       scope: { kind: "row" },                       minWidth: 170, placeholder: "Garden, Suites…" },
  { excelCol: "P",  key: "tipo_unidad",       label: "Tipo Unidad",        scope: { kind: "shared", source: "ai" },      minWidth: 130, options: () => TIPO_UNIDAD_OPTIONS },
  { excelCol: "Q",  key: "tipo_servicio",     label: "Tipo Servicio",      scope: { kind: "shared", source: "ai" },      minWidth: 140, options: () => TIPOS_SERVICIO },
  { excelCol: "R",  key: "categoria",         label: "Categoría",          scope: { kind: "row" },                       minWidth: 140, options: ({ tipoServicio }) => tipoServicio ? (CATEGORIAS_BY_TIPO_SERVICIO[tipoServicio] ?? []) : [] },
  { excelCol: "S",  key: "ocupacion",         label: "Ocupación",          scope: { kind: "row" },                       minWidth: 100, placeholder: "DBL, SGL…" },
  { excelCol: "T",  key: "season_name",       label: "Season Name",        scope: { kind: "row" },                       minWidth: 120, placeholder: "ALTA, BAJA…" },
  { excelCol: "U",  key: "season_starts",     label: "Season Starts",      scope: { kind: "row" },                       minWidth: 140, inputType: "date" },
  { excelCol: "V",  key: "season_ends",       label: "Season Ends",        scope: { kind: "row" },                       minWidth: 140, inputType: "date" },
  { excelCol: "W",  key: "meals_included",    label: "Meals Included",     scope: { kind: "row" },                       minWidth: 140, placeholder: "BREAKFAST…" },
  { excelCol: "X",  key: "tipo_tarifa_neta",  label: "Tipo Tarifa Neta",   scope: { kind: "shared", source: "manual" },  minWidth: 140, placeholder: "Ej: Por persona" },
  { excelCol: "Y",  key: "precios_neto_iva",  label: "Precios Neto c/IVA", scope: { kind: "row" },                       minWidth: 110, placeholder: "295", currency: true },
  { excelCol: "Z",  key: "precio_rack_iva",   label: "Precio Rack c/IVA",  scope: { kind: "row" },                       minWidth: 110, placeholder: "295", currency: true },
  { excelCol: "AA", key: "tipo_tarifa_mayorista",     label: "Tipo Tarifa Mayorista",     scope: { kind: "shared", source: "manual" }, minWidth: 150, placeholder: "Ej: Wholesale" },
  { excelCol: "AB", key: "porcentaje_comision",       label: "% Comisión",                scope: { kind: "row" },                      minWidth: 90,  placeholder: "0 / 25" },
  { excelCol: "AC", key: "tipo_tarifa_fds",           label: "Tipo Tarifa Fin Semana",    scope: { kind: "shared", source: "manual" }, minWidth: 150, placeholder: "Ej: Weekend" },
  { excelCol: "AD", key: "t_tar_neta_fds",            label: "T.Tar Neta Fin Semana",     scope: { kind: "shared", source: "manual" }, minWidth: 150 },
  { excelCol: "AE", key: "precios_neto_iva_fds",      label: "Precios Neto FdS",          scope: { kind: "row" },                      minWidth: 110, placeholder: "295", currency: true },
  { excelCol: "AF", key: "precio_rack_iva_fds",       label: "Precio Rack FdS",           scope: { kind: "row" },                      minWidth: 110, placeholder: "295", currency: true },
  { excelCol: "AG", key: "tipo_tarifa_mayorista_fds", label: "Tipo Tarifa Mayor. FdS",    scope: { kind: "shared", source: "manual" }, minWidth: 150 },
  { excelCol: "AH", key: "porcentaje_comision_fds",   label: "% Comisión FdS",            scope: { kind: "row" },                      minWidth: 100, placeholder: "0 / 25" },
  { excelCol: "AI", key: "cancellation_policy",       label: "Cancelation Policy",        scope: { kind: "row" },                      minWidth: 280, multiline: true },
  { excelCol: "AJ", key: "range_payment_policy",      label: "Range Payment Policy",      scope: { kind: "row" },                      minWidth: 220, multiline: true },
  { excelCol: "AK", key: "others_payment_cancel",     label: "Others in Payment / Cancel",scope: { kind: "shared", source: "manual" }, minWidth: 180, multiline: true },
  { excelCol: "AL", key: "kids_policy",               label: "Kids Policy",               scope: { kind: "row" },                      minWidth: 220, multiline: true },
  { excelCol: "AM", key: "other_included",            label: "Other Included",            scope: { kind: "row" },                      minWidth: 200, multiline: true },
  { excelCol: "AN", key: "feeds_adicionales",         label: "Fees Adicionales",          scope: { kind: "row" },                      minWidth: 180, multiline: true },
  { excelCol: "AO", key: "reservations_email",        label: "Reservations Email",        scope: { kind: "shared", source: "ai" },     minWidth: 200, inputType: "email" },
  { excelCol: "AP", key: "cond_credito",              label: "Condiciones Crédito",       scope: { kind: "shared", source: "manual" }, minWidth: 150, placeholder: "30 días neto" },
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
];

/** Keys del backend ExtractedSharedFields que tienen columna en el xlsx
 *  (telefono se extrae para validación pero NO tiene columna). */
const AI_SHARED_KEYS: ExtractedSharedFieldKey[] = [
  "fecha", "proveedor", "nombre_comercial", "cedula", "direccion",
  "pais", "state_province", "type_of_business",
  "contract_starts", "contract_ends", "reservations_email",
  "tipo_unidad", "tipo_servicio", "tipo_moneda", "numero_cuenta", "banco",
];

const CATALOG_KEYS = [
  "tipo_actividad", "zona_turismo", "proveedor_codigo", "codigo_servicio",
] as const;
type CatalogKey = (typeof CATALOG_KEYS)[number];

const MANUAL_KEYS = [
  "tipo_tarifa_neta", "tipo_tarifa_mayorista", "tipo_tarifa_fds",
  "t_tar_neta_fds", "tipo_tarifa_mayorista_fds", "others_payment_cancel",
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
  // codigo_servicio se rellena con el matcher local + fallback IA
  // (findServiceForSupplierWithAI). Igual que los otros 3 campos del
  // catálogo, siempre puede estar incorrecto si el proveedor tiene varios
  // servicios — el warning sign le recuerda al usuario que verifique.
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
): Record<SharedKey, string | null> {
  const out: Record<string, string | null> = {};
  // 16 AI keys con columna
  for (const k of AI_SHARED_KEYS) {
    out[k] = data.shared_fields[k];
  }
  // 4 catalog keys
  out.tipo_actividad = prefill?.tipo_actividad ?? null;
  out.zona_turismo = prefill?.zona_turismo ?? null;
  out.proveedor_codigo = prefill?.proveedor_codigo ?? null;
  out.codigo_servicio = prefill?.codigo_servicio ?? null;
  // 14 manual keys → null
  for (const k of MANUAL_KEYS) {
    out[k] = null;
  }
  return out as Record<SharedKey, string | null>;
}

function ReviewStep({
  result,
  catalogPrefill,
  onApprove,
}: {
  result: ExtractContractResponse;
  catalogPrefill: CatalogPrefill | null;
  onApprove: (payload: ApprovedPayload) => void;
}) {
  const { data, validation, meta } = result;
  const conf = CONFIANZA_STYLES[data.confianza];

  // Shared state (34 keys)
  const [sharedValues, setSharedValues] = useState<
    Record<SharedKey, string | null>
  >(() => buildInitialSharedValues(data, catalogPrefill));
  const setSharedField = (key: SharedKey, value: string | null) => {
    setSharedValues((prev) => ({ ...prev, [key]: value }));
  };

  // Per-row state (one ContractRow per combinación)
  const [rows, setRows] = useState<ExtractedContractRow[]>(() => data.rows);
  const setRowField = (
    rowIdx: number,
    key: ExtractedRowFieldKey,
    value: string | null,
  ) => {
    setRows((prev) =>
      prev.map((r, i) => (i === rowIdx ? { ...r, [key]: value } : r)),
    );
  };

  const addRow = () => {
    setRows((prev) => {
      const last = prev[prev.length - 1];
      const blank: ExtractedContractRow = {
        product_name: last?.product_name ?? null,
        categoria: last?.categoria ?? null,
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
  };

  const removeRow = (rowIdx: number) => {
    setRows((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== rowIdx);
    });
  };

  const handleApprove = () => {
    // AI shared fields (incluye telefono que extraemos pero no editamos)
    const sharedFields: ExtractedSharedFields = {
      fecha: sharedValues.fecha,
      proveedor: sharedValues.proveedor,
      nombre_comercial: sharedValues.nombre_comercial,
      cedula: sharedValues.cedula,
      direccion: sharedValues.direccion,
      telefono: data.shared_fields.telefono, // not in table, passed through
      pais: sharedValues.pais,
      state_province: sharedValues.state_province,
      type_of_business: sharedValues.type_of_business,
      contract_starts: sharedValues.contract_starts,
      contract_ends: sharedValues.contract_ends,
      reservations_email: sharedValues.reservations_email,
      tipo_unidad:
        sharedValues.tipo_unidad === "N" || sharedValues.tipo_unidad === "S"
          ? sharedValues.tipo_unidad
          : null,
      tipo_servicio: sharedValues.tipo_servicio,
      tipo_moneda: sharedValues.tipo_moneda,
      numero_cuenta: sharedValues.numero_cuenta,
      banco: sharedValues.banco,
    };

    // Catalog prefill — null si todos los 4 son null/empty
    const hasAnyCatalog = CATALOG_KEYS.some((k) => {
      const v = sharedValues[k];
      return typeof v === "string" && v.trim() !== "";
    });
    const finalCatalogPrefill: GenerateXlsxCatalogPrefill | null = hasAnyCatalog
      ? {
          tipo_actividad: sharedValues.tipo_actividad,
          zona_turismo: sharedValues.zona_turismo,
          proveedor_codigo: sharedValues.proveedor_codigo,
          codigo_servicio: sharedValues.codigo_servicio,
        }
      : null;

    // Manual fields — null si todos los 14 son null/empty
    const hasAnyManual = MANUAL_KEYS.some((k) => {
      const v = sharedValues[k];
      return typeof v === "string" && v.trim() !== "";
    });
    const finalManualFields: GenerateXlsxManualFields | null = hasAnyManual
      ? {
          tipo_tarifa_neta: sharedValues.tipo_tarifa_neta,
          tipo_tarifa_mayorista: sharedValues.tipo_tarifa_mayorista,
          tipo_tarifa_fds: sharedValues.tipo_tarifa_fds,
          t_tar_neta_fds: sharedValues.t_tar_neta_fds,
          tipo_tarifa_mayorista_fds: sharedValues.tipo_tarifa_mayorista_fds,
          others_payment_cancel: sharedValues.others_payment_cancel,
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

    onApprove({
      sharedFields,
      rows,
      catalogPrefill: finalCatalogPrefill,
      manualFields: finalManualFields,
    });
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

  return (
    <div className="px-5 sm:px-8 py-7 space-y-5">
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
        paginasOrigenRows={data.paginas_origen_rows}
        camposFaltantes={data.campos_faltantes}
        filename={meta.filename}
        onSharedChange={setSharedField}
        onRowChange={setRowField}
        onAddRow={addRow}
        onRemoveRow={removeRow}
      />

      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={handleApprove}
          className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
        >
          <Download className="w-4 h-4" />
          Generar y descargar xlsx
        </button>
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
  const tipoServicio = sharedValues.tipo_servicio;

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
              · 52 columnas
            </p>
            <p className="text-[11.5px] text-muted-foreground">
              Clic en una celda para editarla. Las columnas con fondo sutil son{" "}
              <em className="italic">compartidas</em>: editar una propaga a todas
              las filas.
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

      <div className="overflow-x-auto">
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

                  const opts = col.options
                    ? col.options({ tipoServicio })
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
 * Editor de celda. Click → modo edit (input/textarea/select). Enter / blur
 * commit. Escape cancel. Source-page se muestra como tooltip al hover.
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
  const isSelect = !!options;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

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
    setDraft("");
  };
  const cancel = () => {
    setEditing(false);
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
        onChange={(e) => onSave(e.target.value === "" ? null : e.target.value)}
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
  // Aplicamos formato solo cuando hay valor: las fechas ISO se reformatean
  // a mm/dd/yyyy y las columnas con `currency` muestran el código de moneda
  // del contrato (ej. "USD 295", "CRC 150000"). El aria-label usa el valor
  // formateado para que un lector de pantalla dicte la misma cifra que ve
  // el usuario.
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
  onReset,
}: {
  payload: ApprovedPayload;
  meta: ExtractContractResponse["meta"];
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
  }, [payload, meta]);

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
