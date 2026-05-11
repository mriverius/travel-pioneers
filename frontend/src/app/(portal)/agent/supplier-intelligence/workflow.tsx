"use client";

import {
  AlertTriangle,
  ArrowRight,
  Baby,
  Banknote,
  BedDouble,
  BookMarked,
  Briefcase,
  Building2,
  Calendar,
  CalendarCheck2,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronDown,
  Cloud,
  CloudUpload,
  Compass,
  CreditCard,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Globe,
  Hash,
  Info,
  Landmark,
  Loader2,
  Mail,
  Map as MapIcon,
  MapPin,
  MessageSquareText,
  Pencil,
  Percent,
  Phone,
  Plus,
  Receipt,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Star,
  Sun,
  Tag,
  Trash2,
  Users,
  UserCheck,
  UserPlus,
  Utensils,
  Wallet,
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
} from "@/lib/api";
import {
  findSupplierByNameWithAI,
  findServiceForSupplier,
  type SupplierMatch,
} from "@/lib/supplierLookup";
import { CATEGORIAS_BY_TIPO_SERVICIO, TIPOS_SERVICIO } from "@/lib/serviceTypesCatalog";

/**
 * Two-step supplier-contract workflow wired to the backend agent at
 * `POST /api/supplier-intelligence/extract`.
 *
 *   1. Upload   — drag & drop / pick a single .pdf / .docx / .doc / .xlsx /
 *                 .xls (max 20 MB — matches backend limit).
 *   2. Review   — Header card con los campos compartidos + tabla con las N
 *                 filas (combinaciones product × season). Edición inline,
 *                 source-page como tooltip al hover.
 *   3. Download — POST /generate-xlsx con los datos aprobados y descarga el
 *                 xlsx final (clonado de plantilla-agente-utopia.xlsx).
 */

type Step = 1 | 2 | 3;

export type FileKind = "pdf" | "docx" | "xlsx";

/* -------------------------------------------------------------------------- */
/*                       Catalog prefill from master                          */
/* -------------------------------------------------------------------------- */

/**
 * Subconjunto de campos shared que vienen pre-llenados desde el catálogo
 * lista-proveedores cuando el usuario marca "Sí, existente" en step 1.
 *
 * Mantenemos esto explícito (no `Partial<...>`) para que el contrato entre
 * lookup → ReviewStep sea visible: si en el futuro agregamos otra columna
 * del maestro, hay que añadirla aquí.
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

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB — must match backend cap.

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
  { id: 3, label: "Descargar xlsx", hint: "Genera el archivo con N filas" },
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

/* -------------------------------------------------------------------------- */
/*                            Excel column utility                            */
/* -------------------------------------------------------------------------- */

/**
 * Convierte un índice 1-based en su letra de columna estilo Excel:
 *   1 → A, 26 → Z, 27 → AA, 52 → AZ, 53 → BA, etc.
 */
export function excelColumnLetter(n: number): string {
  if (!Number.isFinite(n) || n < 1) return "";
  let s = "";
  let x = Math.floor(n);
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/* ============================================================================
   SUPPLIER WORKFLOW (orchestrator)
   ========================================================================== */

/**
 * Aprobación de step 2 → step 3. Recibe los datos finales editados que el
 * usuario aprobó: shared_fields editado, rows editados, y el catalog_prefill
 * (también potencialmente editado).
 */
export interface ApprovedPayload {
  sharedFields: ExtractedSharedFields;
  rows: ExtractedContractRow[];
  catalogPrefill: GenerateXlsxCatalogPrefill | null;
}

export function SupplierWorkflow() {
  const [step, setStep] = useState<Step>(1);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
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

  /** Datos aprobados que se envían al endpoint de generación. */
  const [approvedPayload, setApprovedPayload] = useState<ApprovedPayload | null>(
    null,
  );

  // Ease toward 90% while analyzing.
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
    if (!selectedFile || analyzing || isExistingSupplier === null) return;
    setAnalyzing(true);
    setServerError(null);
    setProgress(4);
    try {
      const response = await api.supplierIntelligence.extract(selectedFile, {
        comments,
        isExistingSupplier,
      });
      setProgress(100);

      // Lookup contra el maestro lista-proveedores usando el nombre comercial
      // (o razón social como fallback) extraído por la IA.
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
            const serviceHint =
              comments?.trim() || selectedFile.name || "";
            const service = findServiceForSupplier(match.supplier, serviceHint);
            prefill = {
              tipo_actividad: match.supplier.actividad,
              zona_turismo: match.supplier.zona,
              proveedor_codigo: match.supplier.codigo,
              codigo_servicio: service?.codigo ?? null,
            };
            matchInfo = {
              status: "matched",
              supplierName: match.supplier.nombre ?? match.supplier.codigo,
              supplierCode: match.supplier.codigo,
              matchedBy: match.matchedBy,
              serviceMatched: service !== null,
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
    setSelectedFile(null);
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
            file={selectedFile}
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
            onClear={clearFile}
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
  );
}

/* ============================================================================
   STEP 1 — Upload
   ========================================================================== */

function UploadStep({
  file,
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
  onClear,
  onStart,
}: {
  file: File | null;
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
  onClear: () => void;
  onStart: () => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const kind = file ? inferKind(file.type, file.name) : null;
  const COMMENTS_MAX = 5000;
  const canSubmit = !!file && !analyzing && isExistingSupplier !== null;

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
              <p className="text-[13px] text-foreground truncate">{file.name}</p>
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
  fileName,
  fileSize,
  kind,
  progress,
  matchingPhase,
}: {
  fileName: string;
  fileSize: number;
  kind: FileKind;
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
            : "Opus 4.6 puede tardar entre 30 y 90 segundos para contratos con muchas filas (ej. 21 combinaciones)."}
        </p>
      </div>
    </div>
  );
}

/* ============================================================================
   FIELD DEFINITIONS (shared + row)
   ========================================================================== */

/**
 * Una opción de un dropdown. Renderizamos como `codigo · descripcion` en el UI
 * y guardamos sólo `codigo` como valor del campo.
 */
export interface SelectOption {
  codigo: string;
  descripcion: string;
}

/**
 * Campos del header card (shared). El key puede ser:
 *   - una clave de ExtractedSharedFields (la IA llena el valor inicial), o
 *   - una clave del catalog prefill ("tipo_actividad", "zona_turismo",
 *     "proveedor_codigo", "codigo_servicio") — sin AI, viene del maestro.
 */
type SharedDisplayKey =
  | ExtractedSharedFieldKey
  | "tipo_actividad"
  | "zona_turismo"
  | "proveedor_codigo"
  | "codigo_servicio";

interface SharedFieldDef {
  key: SharedDisplayKey;
  label: string;
  icon: LucideIcon;
  excelCol: string;
  placeholder?: string;
  inputType?: "text" | "date" | "email";
  multiline?: boolean;
  /** Si true, viene del catálogo lista-proveedores en lugar de la IA. */
  fromCatalog?: boolean;
  /**
   * Si está presente, el campo se renderiza como dropdown. Las opciones se
   * recalculan en cada render por si dependen de otros campos.
   */
  options?: (
    values: Record<SharedDisplayKey, string | null>,
  ) => ReadonlyArray<SelectOption>;
}

interface SharedSectionDef {
  id: string;
  title: string;
  icon: LucideIcon;
  fields: SharedFieldDef[];
}

const TIPO_UNIDAD_OPTIONS: ReadonlyArray<SelectOption> = [
  { codigo: "N", descripcion: "Por noche" },
  { codigo: "S", descripcion: "Por servicio" },
];

const SHARED_SECTIONS: SharedSectionDef[] = [
  {
    id: "catalog",
    title: "Catálogo de proveedores",
    icon: BookMarked,
    fields: [
      {
        key: "tipo_actividad",
        label: "Tipo Actividad",
        icon: Compass,
        excelCol: "A",
        placeholder: "Ej: Hospedaje, Tour, Transporte…",
        fromCatalog: true,
      },
      {
        key: "zona_turismo",
        label: "Zona Turismo",
        icon: MapIcon,
        excelCol: "B",
        placeholder: "Ej: Pacífico Central",
        fromCatalog: true,
      },
      {
        key: "proveedor_codigo",
        label: "Proveedor (código del maestro)",
        icon: Building2,
        excelCol: "C",
        placeholder: "Identificador corto del proveedor",
        fromCatalog: true,
      },
      {
        key: "codigo_servicio",
        label: "Código Servicio",
        icon: Hash,
        excelCol: "N",
        placeholder: "Ej: SVC-1024",
        fromCatalog: true,
      },
    ],
  },
  {
    id: "identidad",
    title: "Identidad del proveedor",
    icon: Building2,
    fields: [
      {
        key: "proveedor",
        label: "Razón Social",
        icon: Building2,
        excelCol: "D",
        placeholder: "Ej: ACME Servicios S.A.",
      },
      {
        key: "nombre_comercial",
        label: "Nombre Comercial",
        icon: BookMarked,
        excelCol: "G",
        placeholder: "Ej: ACME",
      },
      {
        key: "cedula",
        label: "Cédula Jurídica",
        icon: Hash,
        excelCol: "E",
        placeholder: "Ej: 3-101-123456",
      },
      {
        key: "fecha",
        label: "Contract Date",
        icon: Calendar,
        excelCol: "F",
        placeholder: "YYYY-MM-DD",
        inputType: "date",
      },
      {
        key: "telefono",
        label: "Teléfono",
        icon: Phone,
        excelCol: "—",
        placeholder: "Ej: (506) 2777-1414",
      },
    ],
  },
  {
    id: "ubicacion",
    title: "Ubicación",
    icon: MapPin,
    fields: [
      {
        key: "pais",
        label: "País",
        icon: Globe,
        excelCol: "H",
        placeholder: "Ej: Costa Rica",
      },
      {
        key: "state_province",
        label: "State / Province",
        icon: MapPin,
        excelCol: "I",
        placeholder: "Ej: Puntarenas",
      },
      {
        key: "direccion",
        label: "Dirección (Location)",
        icon: MapPin,
        excelCol: "J",
        placeholder: "Calle, número, ciudad…",
        multiline: true,
      },
      {
        key: "type_of_business",
        label: "Type of Business",
        icon: Briefcase,
        excelCol: "K",
        placeholder: "Ej: Hotel, Tour Operator…",
      },
    ],
  },
  {
    id: "contrato",
    title: "Vigencia y contacto operativo",
    icon: CalendarRange,
    fields: [
      {
        key: "contract_starts",
        label: "Contract Starts",
        icon: CalendarCheck2,
        excelCol: "L",
        placeholder: "YYYY-MM-DD",
        inputType: "date",
      },
      {
        key: "contract_ends",
        label: "Contract Ends",
        icon: CalendarRange,
        excelCol: "M",
        placeholder: "YYYY-MM-DD",
        inputType: "date",
      },
      {
        key: "reservations_email",
        label: "Reservations Email",
        icon: Mail,
        excelCol: "AO",
        placeholder: "reservas@proveedor.com",
        inputType: "email",
      },
    ],
  },
  {
    id: "clasificacion",
    title: "Clasificación catálogo Utopía",
    icon: Tag,
    fields: [
      {
        key: "tipo_unidad",
        label: "Tipo Unidad",
        icon: BedDouble,
        excelCol: "P",
        placeholder: "N o S",
        options: () => TIPO_UNIDAD_OPTIONS,
      },
      {
        key: "tipo_servicio",
        label: "Tipo Servicio",
        icon: Tag,
        excelCol: "Q",
        placeholder: "Ej: HO, TO, TR…",
        options: () => TIPOS_SERVICIO,
      },
    ],
  },
  {
    id: "banco",
    title: "Datos bancarios",
    icon: Landmark,
    fields: [
      {
        key: "numero_cuenta",
        label: "Cuenta Bancaria",
        icon: CreditCard,
        excelCol: "AR",
        placeholder: "IBAN preferido",
      },
      {
        key: "banco",
        label: "Banco",
        icon: Landmark,
        excelCol: "AS",
        placeholder: "Ej: BAC Credomatic",
      },
      {
        key: "tipo_moneda",
        label: "Moneda",
        icon: Banknote,
        excelCol: "AT",
        placeholder: "USD, EUR, CRC…",
      },
    ],
  },
];

/**
 * Campos pre-llenados desde el catálogo (cuando hay match). El UI muestra el
 * badge "Revisar — puede ser incorrecto" sobre estos para que el humano
 * confirme antes de aprobar.
 */
const SHARED_FIELDS_NEEDING_REVIEW: ReadonlySet<SharedDisplayKey> = new Set([
  "tipo_actividad",
  "zona_turismo",
  "proveedor_codigo",
]);

/**
 * Columnas de la tabla de filas. El orden es el orden visual de la tabla.
 */
interface RowFieldDef {
  key: ExtractedRowFieldKey;
  label: string;
  shortLabel?: string;
  excelCol: string;
  icon?: LucideIcon;
  inputType?: "text" | "date" | "number";
  multiline?: boolean;
  /** Ancho mínimo de la columna en píxeles. */
  minWidth: number;
  placeholder?: string;
  /** Dropdown con opciones dinámicas. Recibe el shared.tipo_servicio elegido. */
  options?: (tipoServicio: string | null) => ReadonlyArray<SelectOption>;
}

const ROW_FIELDS: RowFieldDef[] = [
  {
    key: "product_name",
    label: "Product Name",
    shortLabel: "Producto",
    excelCol: "O",
    icon: Tag,
    minWidth: 180,
    placeholder: "Ej: Garden, Vista Suites",
  },
  {
    key: "categoria",
    label: "Categoría",
    excelCol: "R",
    icon: Star,
    minWidth: 150,
    placeholder: "Ej: STD, MAS, PNT",
    options: (tipoServicio) => {
      if (!tipoServicio) return [];
      return CATEGORIAS_BY_TIPO_SERVICIO[tipoServicio] ?? [];
    },
  },
  {
    key: "ocupacion",
    label: "Ocupación",
    shortLabel: "Ocup.",
    excelCol: "S",
    icon: Users,
    minWidth: 100,
    placeholder: "DBL, SGL, TPL…",
  },
  {
    key: "season_name",
    label: "Season",
    shortLabel: "Temporada",
    excelCol: "T",
    icon: Sun,
    minWidth: 130,
    placeholder: "PEAK, ALTA, BAJA…",
  },
  {
    key: "season_starts",
    label: "Season Starts",
    shortLabel: "Inicio",
    excelCol: "U",
    icon: Calendar,
    inputType: "date",
    minWidth: 140,
  },
  {
    key: "season_ends",
    label: "Season Ends",
    shortLabel: "Fin",
    excelCol: "V",
    icon: Calendar,
    inputType: "date",
    minWidth: 140,
  },
  {
    key: "meals_included",
    label: "Meals Included",
    shortLabel: "Meals",
    excelCol: "W",
    icon: Utensils,
    minWidth: 140,
    placeholder: "BREAKFAST, MAP…",
  },
  {
    key: "precios_neto_iva",
    label: "Neto c/IVA",
    excelCol: "Y",
    icon: Banknote,
    minWidth: 110,
    placeholder: "Ej: 295",
  },
  {
    key: "precio_rack_iva",
    label: "Rack c/IVA",
    excelCol: "Z",
    icon: Banknote,
    minWidth: 110,
    placeholder: "Ej: 295",
  },
  {
    key: "porcentaje_comision",
    label: "% Comisión",
    shortLabel: "%Com",
    excelCol: "AB",
    icon: Percent,
    minWidth: 90,
    placeholder: "Ej: 25 o 0",
  },
  {
    key: "precios_neto_iva_fds",
    label: "Neto FdS",
    excelCol: "AE",
    icon: Banknote,
    minWidth: 110,
    placeholder: "Ej: 295",
  },
  {
    key: "precio_rack_iva_fds",
    label: "Rack FdS",
    excelCol: "AF",
    icon: Banknote,
    minWidth: 110,
    placeholder: "Ej: 295",
  },
  {
    key: "porcentaje_comision_fds",
    label: "% Com. FdS",
    shortLabel: "%Com FdS",
    excelCol: "AH",
    icon: Percent,
    minWidth: 100,
    placeholder: "Ej: 25 o 0",
  },
  {
    key: "cancellation_policy",
    label: "Política de cancelación",
    shortLabel: "Cancelación",
    excelCol: "AI",
    icon: ShieldAlert,
    multiline: true,
    minWidth: 280,
    placeholder: "Resumen 1-2 oraciones",
  },
  {
    key: "range_payment_policy",
    label: "Política de pago",
    shortLabel: "Pago",
    excelCol: "AJ",
    icon: Wallet,
    multiline: true,
    minWidth: 220,
    placeholder: "Plazo de pago",
  },
  {
    key: "kids_policy",
    label: "Política de niños",
    shortLabel: "Niños",
    excelCol: "AL",
    icon: Baby,
    multiline: true,
    minWidth: 240,
    placeholder: "Reglas para menores",
  },
  {
    key: "other_included",
    label: "Otros incluidos",
    shortLabel: "Other incl.",
    excelCol: "AM",
    icon: Plus,
    multiline: true,
    minWidth: 200,
    placeholder: "Wi-Fi, fitness, etc.",
  },
  {
    key: "feeds_adicionales",
    label: "Fees adicionales",
    shortLabel: "Fees",
    excelCol: "AN",
    icon: Receipt,
    multiline: true,
    minWidth: 180,
    placeholder: "Resort fee, etc.",
  },
];

/* ============================================================================
   STEP 2 — Review (header card + table)
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
 * Construye el state inicial del header card a partir de la respuesta IA y
 * el catalog prefill. Las claves son SharedDisplayKey.
 */
function buildInitialShared(
  data: ExtractedContract,
  prefill: CatalogPrefill | null,
): Record<SharedDisplayKey, string | null> {
  const out: Record<SharedDisplayKey, string | null> = {
    // AI-extracted fields
    fecha: data.shared_fields.fecha,
    proveedor: data.shared_fields.proveedor,
    nombre_comercial: data.shared_fields.nombre_comercial,
    cedula: data.shared_fields.cedula,
    direccion: data.shared_fields.direccion,
    telefono: data.shared_fields.telefono,
    pais: data.shared_fields.pais,
    state_province: data.shared_fields.state_province,
    type_of_business: data.shared_fields.type_of_business,
    contract_starts: data.shared_fields.contract_starts,
    contract_ends: data.shared_fields.contract_ends,
    reservations_email: data.shared_fields.reservations_email,
    tipo_unidad: data.shared_fields.tipo_unidad,
    tipo_servicio: data.shared_fields.tipo_servicio,
    tipo_moneda: data.shared_fields.tipo_moneda,
    numero_cuenta: data.shared_fields.numero_cuenta,
    banco: data.shared_fields.banco,
    // Catalog prefill fields
    tipo_actividad: prefill?.tipo_actividad ?? null,
    zona_turismo: prefill?.zona_turismo ?? null,
    proveedor_codigo: prefill?.proveedor_codigo ?? null,
    codigo_servicio: prefill?.codigo_servicio ?? null,
  };
  return out;
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

  // ---- Shared state ----
  // ReviewStep solo se monta cuando el parent transiciona a step 2; cuando
  // el usuario hace "Procesar otro contrato" el parent llama reset() que
  // desmonta esto. Por eso usamos useState con inicializador (lazy) y NO
  // un useEffect para re-seed — la prop `result` no cambia dentro del
  // ciclo de vida del componente.
  const [sharedValues, setSharedValues] = useState<
    Record<SharedDisplayKey, string | null>
  >(() => buildInitialShared(data, catalogPrefill));

  const setSharedField = (key: SharedDisplayKey, value: string | null) => {
    setSharedValues((prev) => ({ ...prev, [key]: value }));
  };

  // ---- Rows state ----
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
      // Clone the last row's structure but with prices/season cleared, so
      // shared row context (product_name, ocupacion) is preserved as a hint.
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
      if (prev.length <= 1) return prev; // mantén al menos 1
      return prev.filter((_, i) => i !== rowIdx);
    });
  };

  // ---- Approval ----
  const handleApprove = () => {
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
      tipo_unidad:
        sharedValues.tipo_unidad === "N" || sharedValues.tipo_unidad === "S"
          ? sharedValues.tipo_unidad
          : null,
      tipo_servicio: sharedValues.tipo_servicio,
      tipo_moneda: sharedValues.tipo_moneda,
      numero_cuenta: sharedValues.numero_cuenta,
      banco: sharedValues.banco,
    };
    const finalCatalogPrefill: GenerateXlsxCatalogPrefill | null =
      sharedValues.tipo_actividad ||
      sharedValues.zona_turismo ||
      sharedValues.proveedor_codigo ||
      sharedValues.codigo_servicio
        ? {
            tipo_actividad: sharedValues.tipo_actividad,
            zona_turismo: sharedValues.zona_turismo,
            proveedor_codigo: sharedValues.proveedor_codigo,
            codigo_servicio: sharedValues.codigo_servicio,
          }
        : null;
    onApprove({
      sharedFields,
      rows,
      catalogPrefill: finalCatalogPrefill,
    });
  };

  // ---- Stats ----
  const rowCount = rows.length;
  const filledRowCellsCount = rows.reduce((sum, r) => {
    return (
      sum +
      ROW_FIELDS.filter((f) => {
        const v = r[f.key];
        return typeof v === "string" && v.trim() !== "";
      }).length
    );
  }, 0);
  const totalRowCells = rowCount * ROW_FIELDS.length;
  const completionPct =
    totalRowCells === 0
      ? 0
      : Math.round((filledRowCellsCount / totalRowCells) * 100);

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
                {rowCount} {rowCount === 1 ? "fila" : "filas"} extraída
                {rowCount === 1 ? "" : "s"}
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
            {completionPct}% de las celdas de la tabla con valor
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

      <SharedFieldsCard
        values={sharedValues}
        onChange={setSharedField}
        paginasOrigen={data.paginas_origen_shared}
        filename={meta.filename}
        camposFaltantes={data.campos_faltantes}
        hasCatalogPrefill={catalogPrefill !== null}
      />

      <RowsTable
        rows={rows}
        tipoServicio={sharedValues.tipo_servicio}
        paginasOrigenRows={data.paginas_origen_rows}
        filename={meta.filename}
        onChange={setRowField}
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
          <ArrowRight className="w-4 h-4 opacity-80" />
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
   Shared Fields Card (header)
   ========================================================================== */

function SharedFieldsCard({
  values,
  onChange,
  paginasOrigen,
  filename,
  camposFaltantes,
  hasCatalogPrefill,
}: {
  values: Record<SharedDisplayKey, string | null>;
  onChange: (key: SharedDisplayKey, value: string | null) => void;
  paginasOrigen: Record<string, ExtractionSourcePage>;
  filename: string;
  camposFaltantes: string[];
  hasCatalogPrefill: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const visibleSections = SHARED_SECTIONS.filter(
    (s) => s.id !== "catalog" || hasCatalogPrefill,
  );

  const totalFields = visibleSections.reduce((sum, s) => sum + s.fields.length, 0);
  const filledCount = visibleSections.reduce(
    (sum, s) =>
      sum +
      s.fields.filter((f) => {
        const v = values[f.key];
        return typeof v === "string" && v.trim() !== "";
      }).length,
    0,
  );

  return (
    <section className="rounded-xl border border-primary/20 bg-card/60 overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-secondary/30 transition-colors"
      >
        <div className="w-10 h-10 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
          <Info className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[14.5px] font-semibold text-foreground">
            Información compartida del proveedor
          </p>
          <p className="text-[12.5px] text-muted-foreground">
            Estos datos se replican en cada fila del xlsx.
          </p>
        </div>
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full border text-[11.5px] font-semibold tabular-nums shrink-0 border-primary/30 bg-primary/10 text-primary">
          {filledCount}/{totalFields}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground transition-transform shrink-0 ${
            collapsed ? "" : "rotate-180"
          }`}
        />
      </button>
      {!collapsed && (
        <div className="border-t border-border/60 bg-card/40 divide-y divide-border/40">
          {visibleSections.map((section) => (
            <SharedSubsection
              key={section.id}
              section={section}
              values={values}
              onChange={onChange}
              paginasOrigen={paginasOrigen}
              filename={filename}
              camposFaltantes={camposFaltantes}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SharedSubsection({
  section,
  values,
  onChange,
  paginasOrigen,
  filename,
  camposFaltantes,
}: {
  section: SharedSectionDef;
  values: Record<SharedDisplayKey, string | null>;
  onChange: (key: SharedDisplayKey, value: string | null) => void;
  paginasOrigen: Record<string, ExtractionSourcePage>;
  filename: string;
  camposFaltantes: string[];
}) {
  const SectionIcon = section.icon;
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-2 mb-3">
        <SectionIcon className="w-4 h-4 text-muted-foreground" />
        <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
          {section.title}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-3">
        {section.fields.map((f) => (
          <SharedFieldRow
            key={f.key}
            field={f}
            value={values[f.key]}
            options={f.options ? f.options(values) : undefined}
            // Source page comes from paginas_origen_shared keyed by the AI
            // field name. Catalog fields don't have a source page.
            source={f.fromCatalog ? undefined : paginasOrigen[f.key]}
            isMarkedMissing={
              !f.fromCatalog && camposFaltantes.includes(f.key)
            }
            needsReview={SHARED_FIELDS_NEEDING_REVIEW.has(f.key)}
            filename={filename}
            onSave={(v) => onChange(f.key, v)}
          />
        ))}
      </div>
    </div>
  );
}

function SharedFieldRow({
  field,
  value,
  options,
  source,
  isMarkedMissing,
  needsReview,
  filename,
  onSave,
}: {
  field: SharedFieldDef;
  value: string | null;
  options?: ReadonlyArray<SelectOption>;
  source: ExtractionSourcePage | undefined;
  isMarkedMissing: boolean;
  needsReview: boolean;
  filename: string;
  onSave: (next: string | null) => void;
}) {
  const { icon: Icon, label, placeholder, inputType, multiline } = field;
  const isSelect = !!options && options.length > 0;
  const missing = value === null || value === "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const startEdit = () => {
    setDraft(value ?? "");
    setEditing(true);
  };

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

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
    if (e.key === "Enter" && !e.shiftKey && !multiline) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <div className={field.multiline ? "md:col-span-2" : undefined}>
      <div className="flex items-center gap-1.5 text-muted-foreground min-w-0 mb-1">
        <span
          className="inline-flex items-center justify-center min-w-[24px] h-4 px-1 rounded border border-border/70 bg-secondary/60 text-[10px] font-mono font-semibold text-muted-foreground/90 tabular-nums shrink-0"
          title={`Columna ${field.excelCol}`}
        >
          {field.excelCol}
        </span>
        <Icon className="w-3.5 h-3.5 shrink-0" />
        <p className="text-[11.5px] uppercase tracking-wider font-semibold truncate">
          {label}
        </p>
        {needsReview && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-[9.5px] font-semibold uppercase tracking-wider text-amber-300 shrink-0"
            title="La información puede ser incorrecta — revisa antes de aprobar."
          >
            <AlertTriangle className="w-2.5 h-2.5" />
            Revisar
          </span>
        )}
        {source !== undefined && (
          <SourceChip source={source} filename={filename} />
        )}
      </div>

      {isSelect ? (
        <div className="flex items-center gap-1.5">
          <select
            value={value ?? ""}
            onChange={(e) => onSave(e.target.value === "" ? null : e.target.value)}
            aria-label={label}
            className="flex-1 min-w-0 h-9 rounded-md border border-border bg-secondary/40 px-2.5 text-[13px] text-foreground outline-none focus:border-primary/60 focus:bg-secondary/60 cursor-pointer"
          >
            <option value="">— {placeholder ?? "Selecciona…"} —</option>
            {options!.map((opt) => (
              <option key={opt.codigo} value={opt.codigo}>
                {opt.codigo} · {opt.descripcion}
              </option>
            ))}
          </select>
          {value && (
            <button
              type="button"
              onClick={() => onSave(null)}
              aria-label={`Limpiar ${label}`}
              className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-border bg-secondary/60 text-muted-foreground hover:text-destructive transition-colors shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      ) : editing ? (
        <div className="flex items-start gap-1.5">
          {multiline ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={2}
              className="flex-1 min-w-0 resize-y rounded-md border border-primary/40 bg-secondary/40 px-2.5 py-1.5 text-[13px] leading-relaxed text-foreground outline-none focus:border-primary focus:bg-secondary/60"
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type={inputType ?? "text"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="flex-1 min-w-0 h-9 rounded-md border border-primary/40 bg-secondary/40 px-2.5 text-[13px] text-foreground outline-none focus:border-primary focus:bg-secondary/60"
            />
          )}
          <button
            type="button"
            onClick={commit}
            aria-label={`Guardar ${label}`}
            className="inline-flex items-center justify-center h-9 w-9 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity shrink-0"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={cancel}
            aria-label="Cancelar"
            className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-border bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <div className="group flex items-start gap-2">
          <p
            className={`flex-1 min-w-0 text-[13.5px] leading-relaxed break-words ${
              missing ? "text-muted-foreground/60 italic" : "text-foreground"
            }`}
          >
            {missing
              ? isMarkedMissing
                ? "No encontrado en el documento"
                : "Vacío — clic en ✎ para agregar"
              : value}
          </p>
          <button
            type="button"
            onClick={startEdit}
            aria-label={missing ? `Agregar ${label}` : `Editar ${label}`}
            className="inline-flex items-center justify-center h-7 w-7 rounded border border-transparent text-muted-foreground hover:text-primary hover:border-primary/30 hover:bg-primary/10 group-hover:text-primary/70 transition-colors shrink-0"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
   Rows Table — spreadsheet-style editable grid
   ========================================================================== */

function RowsTable({
  rows,
  tipoServicio,
  paginasOrigenRows,
  filename,
  onChange,
  onAddRow,
  onRemoveRow,
}: {
  rows: ExtractedContractRow[];
  tipoServicio: string | null;
  paginasOrigenRows: Record<string, ExtractionSourcePage>[];
  filename: string;
  onChange: (
    rowIdx: number,
    key: ExtractedRowFieldKey,
    value: string | null,
  ) => void;
  onAddRow: () => void;
  onRemoveRow: (rowIdx: number) => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card/60 overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-4.5 h-4.5 text-emerald-300" />
          </div>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-foreground">
              Filas del xlsx ({rows.length})
            </p>
            <p className="text-[11.5px] text-muted-foreground">
              Una fila por cada combinación product × season. Clic en una celda
              para editarla.
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
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="bg-secondary/40 border-b border-border/60 sticky top-0 z-10">
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-20 bg-secondary/80 backdrop-blur px-2 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/90 border-r border-border/60"
                style={{ minWidth: 48 }}
              >
                #
              </th>
              {ROW_FIELDS.map((f) => (
                <th
                  key={f.key}
                  scope="col"
                  className="px-2 py-2 text-left font-semibold border-r border-border/40 last:border-r-0 whitespace-nowrap"
                  style={{ minWidth: f.minWidth }}
                >
                  <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground/90">
                    <span
                      className="inline-flex items-center justify-center min-w-[22px] h-3.5 px-0.5 rounded border border-border/70 bg-secondary/60 text-[9px] font-mono font-semibold text-muted-foreground/90"
                      title={`Columna ${f.excelCol}`}
                    >
                      {f.excelCol}
                    </span>
                    {f.icon && <f.icon className="w-3 h-3" />}
                    <span className="text-foreground/90">
                      {f.shortLabel ?? f.label}
                    </span>
                  </div>
                </th>
              ))}
              <th
                scope="col"
                className="px-2 py-2 text-right text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/90"
                style={{ minWidth: 44 }}
              >
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className="border-b border-border/30 last:border-b-0 hover:bg-secondary/15 transition-colors"
              >
                <td
                  className="sticky left-0 z-10 bg-card/95 backdrop-blur px-2 py-1 text-[11px] font-mono tabular-nums text-muted-foreground border-r border-border/40"
                  style={{ minWidth: 48 }}
                >
                  {rowIdx + 1}
                </td>
                {ROW_FIELDS.map((f) => {
                  const opts = f.options ? f.options(tipoServicio) : undefined;
                  return (
                    <td
                      key={f.key}
                      className="px-1 py-0.5 align-top border-r border-border/30 last:border-r-0"
                      style={{ minWidth: f.minWidth }}
                    >
                      <TableCell
                        field={f}
                        value={row[f.key]}
                        options={opts}
                        source={paginasOrigenRows[rowIdx]?.[f.key]}
                        filename={filename}
                        onSave={(v) => onChange(rowIdx, f.key, v)}
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
 * Celda editable de la tabla. Click → modo edit (input/textarea/select).
 * Enter / blur commit. Escape cancel. El source page se muestra como
 * tooltip al hover sobre la celda completa.
 */
function TableCell({
  field,
  value,
  options,
  source,
  filename,
  onSave,
}: {
  field: RowFieldDef;
  value: string | null;
  options: ReadonlyArray<SelectOption> | undefined;
  source: ExtractionSourcePage | undefined;
  filename: string;
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
    if (e.key === "Enter" && !e.shiftKey && !field.multiline) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  // Tooltip combina la página de origen + filename (igual que en shared)
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
    return (
      <div className="relative" title={tooltip}>
        <select
          value={value ?? ""}
          onChange={(e) => onSave(e.target.value === "" ? null : e.target.value)}
          className="w-full h-8 rounded border border-transparent bg-transparent px-1.5 text-[12.5px] text-foreground outline-none hover:border-border focus:border-primary/60 focus:bg-secondary/40 cursor-pointer"
          aria-label={field.label}
        >
          <option value="">—</option>
          {options.map((opt) => (
            <option key={opt.codigo} value={opt.codigo}>
              {opt.codigo} · {opt.descripcion}
            </option>
          ))}
          {value && !options.some((o) => o.codigo === value) && (
            <option value={value} className="italic">
              {value} (fuera de catálogo)
            </option>
          )}
        </select>
      </div>
    );
  }

  if (editing) {
    return field.multiline ? (
      <textarea
        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commit}
        placeholder={field.placeholder}
        rows={3}
        className="w-full resize-y rounded border border-primary/60 bg-secondary/40 px-1.5 py-1 text-[12.5px] leading-relaxed text-foreground outline-none focus:border-primary"
      />
    ) : (
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type={field.inputType ?? "text"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commit}
        placeholder={field.placeholder}
        className="w-full h-8 rounded border border-primary/60 bg-secondary/40 px-1.5 text-[12.5px] text-foreground outline-none focus:border-primary"
      />
    );
  }

  const missing = value === null || value === "";
  return (
    <button
      type="button"
      onClick={startEdit}
      title={tooltip}
      aria-label={`${field.label} — ${missing ? "vacío" : value}. Clic para editar.`}
      className={`w-full min-h-[2rem] text-left rounded border border-transparent px-1.5 py-1 text-[12.5px] leading-snug transition-colors hover:border-border hover:bg-secondary/30 focus:outline-none focus:border-primary/60 focus:bg-secondary/40 ${
        missing
          ? "text-muted-foreground/50 italic"
          : "text-foreground"
      } ${field.multiline ? "whitespace-pre-wrap break-words" : "truncate"}`}
    >
      {missing ? "—" : value}
    </button>
  );
}

/* ============================================================================
   Source chip (used in shared header)
   ========================================================================== */

function SourceChip({
  source,
  filename,
}: {
  source: ExtractionSourcePage;
  filename: string;
}) {
  const base =
    typeof source === "number"
      ? `Pág ${source}`
      : source === "inferido"
        ? "Inferido"
        : source === "multiple"
          ? "Múltiples págs"
          : `Pág ${source}`;
  const tooltip = `${base} · ${filename}`;

  return (
    <span
      title={tooltip}
      className="inline-flex max-w-[140px] items-center gap-1 px-1.5 py-0 rounded border border-border bg-secondary/40 text-[9.5px] font-medium text-muted-foreground whitespace-nowrap shrink-0"
    >
      <span className="shrink-0">{base}</span>
    </span>
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
  const [phase, setPhase] = useState<"generating" | "done" | "error">("generating");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<{
    filename: string;
    sizeBytes: number;
  } | null>(null);
  // Track started state to avoid the StrictMode double-mount firing two
  // fetches in dev.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const { blob, filename } = await api.supplierIntelligence.generateXlsx({
          shared_fields: payload.sharedFields,
          rows: payload.rows,
          catalog_prefill: payload.catalogPrefill,
        });
        if (cancelled) return;

        // Trigger browser download via an in-memory anchor click.
        const url = URL.createObjectURL(blob);
        try {
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          // Append to body for Firefox compatibility, click, then remove.
          document.body.appendChild(a);
          a.click();
          a.remove();
        } finally {
          // Defer revoke so the click has a chance to dispatch first.
          setTimeout(() => URL.revokeObjectURL(url), 500);
        }

        setDownloaded({ filename, sizeBytes: blob.size });
        setPhase("done");
      } catch (err) {
        if (cancelled) return;
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

    return () => {
      cancelled = true;
    };
  }, [payload]);

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
    <DownloadSuccessCard
      filename={downloaded?.filename ?? "contrato.xlsx"}
      sizeBytes={downloaded?.sizeBytes ?? 0}
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
          Procesando — esto suele tardar 1-3 segundos.
        </p>
      </div>
    </div>
  );
}

function DownloadSuccessCard({
  filename,
  sizeBytes,
  rowCount,
  meta,
  onReset,
}: {
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
          ¡xlsx generado y descargado!
        </h3>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          El archivo está en tu carpeta de descargas. Si no se descargó
          automáticamente, revisa el bloqueador de pop-ups del navegador.
        </p>
      </div>

      <div className="mx-auto max-w-xl rounded-xl border border-border bg-card/60 divide-y divide-border/50">
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
              {rowCount === 1 ? "fila" : "filas"}
            </p>
          </div>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
            <Check className="w-3 h-3" />
            Descargado
          </span>
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

      <div className="mx-auto max-w-xl flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
        <button
          type="button"
          disabled
          title="Próximamente"
          className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-border bg-secondary/40 text-[13.5px] text-muted-foreground cursor-not-allowed opacity-70"
        >
          <ExternalLink className="w-4 h-4" />
          Subir al maestro
        </button>
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
