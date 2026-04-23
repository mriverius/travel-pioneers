"use client";

import {
  AlertTriangle,
  Banknote,
  BookMarked,
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  CloudUpload,
  CreditCard,
  FileSpreadsheet,
  FileText,
  Hash,
  Landmark,
  Loader2,
  MapPin,
  Phone,
  RotateCcw,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
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
  type ExtractionConfianza,
} from "@/lib/api";

/**
 * Two-step supplier-contract workflow wired to the backend agent at
 * `POST /api/supplier-intelligence/extract`.
 *
 *   1. Upload   — drag & drop / pick a single .pdf / .docx / .doc / .xlsx /
 *                 .xls (max 20 MB — matches backend limit).
 *   2. Review   — show the 9 extracted fields, confidence, warnings, and the
 *                 per-field source pages returned by Claude. A "Procesar
 *                 otro contrato" button resets the flow.
 *
 * Step 3 (approve → push to Utopía) is intentionally out of scope right now;
 * the stepper is 2 steps to match the current backend surface area.
 */

type Step = 1 | 2;

type FileKind = "pdf" | "docx" | "xlsx";

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB — must match backend cap.

/**
 * Accept attribute for the native file picker. We list both MIME and
 * extension so browsers that don't recognize one fall back to the other.
 * Matches the backend's `detectDocKind()` whitelist exactly.
 */
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
  { id: 2, label: "Revisar información", hint: "Datos extraídos por IA" },
];

function inferKind(mime: string, name: string): FileKind | null {
  const lower = name.toLowerCase();
  if (mime === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword" ||
    lower.endsWith(".docx") ||
    lower.endsWith(".doc")
  ) {
    return "docx";
  }
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls")
  ) {
    return "xlsx";
  }
  return null;
}

function humanSize(bytes: number): string {
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

export function SupplierWorkflow() {
  const [step, setStep] = useState<Step>(1);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<ExtractContractResponse | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  // Simulated progress while the backend is thinking. We don't get streaming
  // progress from the Anthropic call, so we ease toward 90% and snap to 100%
  // when the response lands — a white lie that keeps the UI feeling alive.
  const [progress, setProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Ease toward 90% while analyzing. Slower as we approach the ceiling so it
  // feels like work is happening even on long extractions.
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

  const acceptFile = (incoming: File) => {
    setUploadError(null);
    setServerError(null);

    const kind = inferKind(incoming.type, incoming.name);
    if (!kind) {
      setUploadError(
        `${incoming.name}: formato no admitido. Usa PDF, Word (.docx, .doc) o Excel (.xlsx, .xls).`,
      );
      return;
    }
    if (incoming.size > MAX_FILE_BYTES) {
      setUploadError(
        `${incoming.name}: excede el tamaño máximo de 20 MB (tamaño: ${humanSize(incoming.size)}).`,
      );
      return;
    }

    setSelectedFile(incoming);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    acceptFile(f);
  };

  const handlePick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    // Reset so picking the same file again fires change.
    e.target.value = "";
    if (!f) return;
    acceptFile(f);
  };

  const clearFile = () => {
    setSelectedFile(null);
    setUploadError(null);
    setServerError(null);
  };

  const startAnalysis = async () => {
    if (!selectedFile || analyzing) return;
    setAnalyzing(true);
    setServerError(null);
    setProgress(4); // kick off visibly above zero
    try {
      const response = await api.supplierIntelligence.extract(selectedFile);
      // Snap to 100% and let the filled bar linger briefly before we
      // transition to the review step — feels more finished than a hard cut.
      setProgress(100);
      await new Promise((r) => setTimeout(r, 450));
      setResult(response);
      setStep(2);
    } catch (err) {
      // Surface the server's message verbatim — the backend's error copy is
      // already user-facing (Spanish, specific, e.g. "El archivo excede …").
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
    }
  };

  const reset = () => {
    setStep(1);
    setSelectedFile(null);
    setResult(null);
    setUploadError(null);
    setServerError(null);
    setProgress(0);
  };

  return (
    <section className="relative overflow-hidden rounded-2xl border border-border bg-card/80 shadow-[0_1px_0_0_hsl(var(--primary)/0.08)_inset]">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-20 left-1/2 h-56 w-[70%] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
      />

      {/* Stepper */}
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
                    {state === "complete" ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      s.id
                    )}
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

      {/* Body — keyed on step so the page-enter animation replays */}
      <div key={step} className="animate-page-enter">
        {step === 1 && (
          <UploadStep
            file={selectedFile}
            uploadError={uploadError}
            serverError={serverError}
            analyzing={analyzing}
            progress={progress}
            fileInputRef={fileInputRef}
            onDrop={handleDrop}
            onPick={handlePick}
            onClear={clearFile}
            onStart={startAnalysis}
          />
        )}

        {step === 2 && result && (
          <ReviewStep result={result} onReset={reset} />
        )}
      </div>
    </section>
  );
}

/* ---------------------------------- STEP 1 -------------------------------- */

function UploadStep({
  file,
  uploadError,
  serverError,
  analyzing,
  progress,
  fileInputRef,
  onDrop,
  onPick,
  onClear,
  onStart,
}: {
  file: File | null;
  uploadError: string | null;
  serverError: string | null;
  analyzing: boolean;
  progress: number;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onPick: (e: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  onStart: () => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const kind = file ? inferKind(file.type, file.name) : null;

  return (
    <div className="px-5 sm:px-8 py-7 space-y-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          setDragActive(false);
          onDrop(e);
        }}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={`group cursor-pointer rounded-2xl border-2 border-dashed p-8 sm:p-10 text-center transition-all ${
          dragActive
            ? "border-primary bg-primary/10 shadow-[0_0_30px_0_hsl(var(--primary)/0.25)]"
            : "border-border bg-secondary/20 hover:border-primary/50 hover:bg-primary/5"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          onChange={onPick}
          className="hidden"
        />
        <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center animate-pulse-glow">
          <CloudUpload className="w-6 h-6 text-primary" />
        </div>
        <p className="mt-4 text-[15px] font-semibold text-foreground">
          Arrastra tu contrato aquí
        </p>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          o{" "}
          <span className="text-primary font-medium">
            haz click para buscarlo
          </span>{" "}
          en tu equipo
        </p>
        <div className="mt-4 inline-flex items-center gap-2 text-[11px] text-muted-foreground/80">
          <Badge label="PDF" />
          <Badge label="DOCX" />
          <Badge label="XLSX" />
          <span className="opacity-60">· hasta 20 MB</span>
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

      {file && kind && !analyzing && (
        <div className="rounded-xl border border-border bg-card/60">
          <header className="flex items-center justify-between px-4 py-3 border-b border-border/60">
            <p className="text-[12.5px] font-semibold text-foreground">
              Documento listo para analizar
            </p>
            <p className="text-[11.5px] text-muted-foreground">
              {humanSize(file.size)}
            </p>
          </header>
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="w-8 h-8 rounded-lg bg-secondary/70 border border-border/60 flex items-center justify-center shrink-0">
              {fileIcon(kind)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] text-foreground truncate">
                {file.name}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {humanSize(file.size)} · {kind.toUpperCase()}
              </p>
            </div>
            <button
              type="button"
              onClick={onClear}
              disabled={analyzing}
              aria-label={`Quitar ${file.name}`}
              className="text-muted-foreground hover:text-destructive disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {file && kind && analyzing && (
        <AnalysisProgressCard
          fileName={file.name}
          fileSize={file.size}
          kind={kind}
          progress={progress}
        />
      )}

      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
        <button
          type="button"
          onClick={onStart}
          disabled={!file || analyzing}
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

function Badge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-border bg-secondary/40 text-[10.5px] font-semibold tracking-wider">
      {label}
    </span>
  );
}

/**
 * Phase copy mapped to the simulated progress range. Claude's `messages.create`
 * is a single round-trip so we can't surface real sub-step progress — the
 * bands below just match what the backend is conceptually doing.
 */
function analysisPhase(progress: number): string {
  if (progress < 25) return "Preparando el documento…";
  if (progress < 75) return "Extrayendo campos con IA…";
  if (progress < 100) return "Validando datos extraídos…";
  return "Listo";
}

function AnalysisProgressCard({
  fileName,
  fileSize,
  kind,
  progress,
}: {
  fileName: string;
  fileSize: number;
  kind: FileKind;
  progress: number;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  const phase = analysisPhase(progress);
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50">
        <div className="w-8 h-8 rounded-lg bg-secondary/70 border border-border/60 flex items-center justify-center shrink-0">
          {fileIcon(kind)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] text-foreground truncate">{fileName}</p>
          <p className="text-[11px] text-muted-foreground">
            {humanSize(fileSize)} · {kind.toUpperCase()}
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
            {pct}%
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
            className="h-full rounded-full bg-primary shadow-[0_0_12px_0_hsl(var(--primary)/0.5)] transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Esto suele tomar entre 5 y 20 segundos.
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------- STEP 2 -------------------------------- */

/**
 * Field-display rows grouped into three cards: Identity, Contact, Financial.
 * Each field shows its source page (or "inferido" / "multiple") as a small
 * trailing chip so users can audit where the value came from.
 */
const IDENTITY_FIELDS: {
  key: keyof ExtractedContract;
  label: string;
  icon: LucideIcon;
}[] = [
  { key: "proveedor", label: "Proveedor (razón social)", icon: Building2 },
  { key: "nombre_comercial", label: "Nombre comercial", icon: BookMarked },
  { key: "cedula", label: "Cédula / RFC / NIT", icon: Hash },
  { key: "fecha", label: "Fecha de firma", icon: Calendar },
];

const CONTACT_FIELDS: {
  key: keyof ExtractedContract;
  label: string;
  icon: LucideIcon;
}[] = [
  { key: "direccion", label: "Dirección", icon: MapPin },
  { key: "telefono", label: "Teléfono", icon: Phone },
];

const FINANCIAL_FIELDS: {
  key: keyof ExtractedContract;
  label: string;
  icon: LucideIcon;
}[] = [
  { key: "banco", label: "Banco", icon: Landmark },
  { key: "numero_cuenta", label: "Cuenta bancaria", icon: CreditCard },
  { key: "tipo_moneda", label: "Moneda", icon: Banknote },
];

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

function ReviewStep({
  result,
  onReset,
}: {
  result: ExtractContractResponse;
  onReset: () => void;
}) {
  const { data, validation, meta } = result;
  const conf = CONFIANZA_STYLES[data.confianza];

  return (
    <div className="px-5 sm:px-8 py-7 space-y-5">
      {/* Summary banner */}
      <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/8 px-3.5 py-3">
        <div className="w-9 h-9 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
          <CheckCircle2 className="w-4.5 h-4.5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center flex-wrap gap-2">
            <p className="text-[14px] font-semibold text-foreground">
              Análisis completado
            </p>
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10.5px] font-semibold uppercase tracking-wider ${conf.bg} ${conf.border} ${conf.text}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${conf.dot}`} />
              {conf.label}
            </span>
          </div>
          <p className="text-[12.5px] text-muted-foreground mt-1 truncate">
            {meta.filename} · {humanSize(meta.size_bytes)} · modelo {meta.model}
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

      <FieldGroup
        title="Identidad del proveedor"
        fields={IDENTITY_FIELDS}
        data={data}
        filename={meta.filename}
      />
      <FieldGroup
        title="Contacto"
        fields={CONTACT_FIELDS}
        data={data}
        filename={meta.filename}
      />
      <FieldGroup
        title="Información bancaria"
        fields={FINANCIAL_FIELDS}
        data={data}
        filename={meta.filename}
      />

      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onReset}
          className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
        >
          <RotateCcw className="w-4 h-4" />
          Procesar otro contrato
        </button>
      </div>
    </div>
  );
}

function FieldGroup({
  title,
  fields,
  data,
  filename,
}: {
  title: string;
  fields: { key: keyof ExtractedContract; label: string; icon: LucideIcon }[];
  data: ExtractedContract;
  filename: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
        <h3 className="text-[12.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
      </header>
      <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-border/50">
        {fields.map((f) => (
          <FieldRow
            key={f.key as string}
            icon={f.icon}
            label={f.label}
            fieldKey={f.key as string}
            data={data}
            filename={filename}
          />
        ))}
      </div>
    </div>
  );
}

function FieldRow({
  icon: Icon,
  label,
  fieldKey,
  data,
  filename,
}: {
  icon: LucideIcon;
  label: string;
  fieldKey: string;
  data: ExtractedContract;
  filename: string;
}) {
  const rawValue = data[fieldKey as keyof ExtractedContract];
  // Only string | null reach this row (the other ExtractedContract props are
  // excluded by the field-group definitions above), but TS can't prove it
  // via the lookup, so narrow here.
  const value =
    typeof rawValue === "string" || rawValue === null ? rawValue : null;
  const missing = value === null || value === "";
  const isMarkedMissing = data.campos_faltantes.includes(fieldKey);
  const source = data.paginas_origen[fieldKey];

  return (
    <div className="px-4 py-3 min-w-0">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="w-3.5 h-3.5" />
        <p className="text-[11px] uppercase tracking-wider font-semibold">
          {label}
        </p>
        {source !== undefined && source !== null && (
          <SourceChip source={source} filename={filename} />
        )}
      </div>
      <p
        className={`mt-1 text-[13.5px] break-words ${
          missing ? "text-muted-foreground/70 italic" : "text-foreground"
        }`}
      >
        {missing
          ? isMarkedMissing
            ? "No encontrado en el documento"
            : "—"
          : value}
      </p>
    </div>
  );
}

/**
 * Renders provenance for a single extracted field. The chip reads as:
 *
 *   Página 6 · contrato_acme.pdf    (numeric page in a PDF/Excel)
 *   Inferido · contrato_acme.pdf    (Claude inferred — no single source page)
 *   Múltiples páginas · foo.pdf     (value appears across several pages)
 *
 * The filename is truncated at a reasonable width; the full label is surfaced
 * via the `title` attribute for hover tooltips.
 */
function SourceChip({
  source,
  filename,
}: {
  source: string | number;
  filename: string;
}) {
  const base =
    typeof source === "number"
      ? `Página ${source}`
      : source === "inferido"
        ? "Inferido"
        : source === "multiple"
          ? "Múltiples páginas"
          : `Página ${source}`;
  const tooltip = `${base} · ${filename}`;

  return (
    <span
      title={tooltip}
      className="ml-auto inline-flex max-w-[220px] items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-secondary/40 text-[10px] font-medium text-muted-foreground whitespace-nowrap"
    >
      <span className="shrink-0">{base}</span>
      <span aria-hidden className="text-muted-foreground/50">
        ·
      </span>
      <span className="truncate text-muted-foreground/80">{filename}</span>
    </span>
  );
}
