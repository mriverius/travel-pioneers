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
  Clock,
  Cloud,
  CloudUpload,
  Compass,
  CreditCard,
  DollarSign,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Globe,
  Hash,
  Landmark,
  Loader2,
  Mail,
  Map as MapIcon,
  MapPin,
  MessageSquareText,
  Package,
  Pencil,
  Percent,
  PlusCircle,
  Receipt,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Tag,
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
  type ExtractionConfianza,
} from "@/lib/api";

/**
 * Full set of business fields surfaced in step 2. Most of these aren't
 * extracted by the AI today (the backend only fills a 9-field subset) — we
 * still render them so the user can fill them in manually before pushing the
 * record downstream.
 *
 * Keys are deliberately snake_case + Spanish/English mirror of the labels so
 * they're stable to wire to a future API payload.
 */
export type DisplayFieldKey =
  // Identidad / ubicación / contrato
  | "tipo_actividad"
  | "zona_turismo"
  | "proveedor"
  | "razon_social"
  | "cedula_juridica"
  | "contract_date"
  | "nombre_comercial"
  | "pais"
  | "state_province"
  | "location"
  | "type_of_business"
  | "contract_starts"
  | "contract_ends"
  // Servicio
  | "codigo_servicio"
  | "product_name"
  | "tipo_unidad"
  | "tipo_servicio"
  | "categoria"
  | "ocupacion"
  // Temporada
  | "season_name"
  | "season_starts"
  | "season_ends"
  | "meals_included"
  // Tarifas estándar
  | "tipo_tarifa_neta"
  | "precios_neto_iva"
  | "precio_rack_iva"
  | "tipo_tarifa_mayorista"
  | "porcentaje_comision"
  // Tarifas fin de semana
  | "tipo_tarifa_fds"
  | "t_tar_neta_fds"
  | "precios_neto_iva_fds"
  | "precio_rack_iva_fds"
  | "tipo_tarifa_mayorista_fds"
  | "porcentaje_comision_fds"
  // Políticas
  | "cancellation_policy"
  | "range_payment_policy"
  | "others_payment_cancel"
  | "kids_policy"
  | "other_included"
  | "feeds_adicionales"
  // Reservas y crédito
  | "reservations_email"
  | "cond_credito"
  | "plazo"
  // Cuentas bancarias (3 slots)
  | "cuenta_bancaria_1"
  | "banco_1"
  | "moneda_1"
  | "cuenta_bancaria_2"
  | "banco_2"
  | "moneda_2"
  | "cuenta_bancaria_3"
  | "banco_3"
  | "moneda_3";

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

type Step = 1 | 2 | 3;

export type FileKind = "pdf" | "docx" | "xlsx";

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
  { id: 3, label: "Subir al maestro", hint: "Sincronización con xlsx en la nube" },
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

  /**
   * Optional free-form context the user pastes from the email body. Forwarded
   * to the backend so Claude can use it as supplementary extraction context.
   */
  const [comments, setComments] = useState("");
  /**
   * Required toggle in step 1. `null` means "not chosen yet" — we keep the
   * 'Analizar con IA' button disabled in that state. The backend rejects the
   * request with a 400 if it ever arrives missing.
   */
  const [isExistingSupplier, setIsExistingSupplier] = useState<boolean | null>(
    null,
  );

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
    // Guard: file required, supplier flag must be chosen, no double-fire.
    if (!selectedFile || analyzing || isExistingSupplier === null) return;
    setAnalyzing(true);
    setServerError(null);
    setProgress(4); // kick off visibly above zero
    try {
      const response = await api.supplierIntelligence.extract(selectedFile, {
        comments,
        isExistingSupplier,
      });
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
    setComments("");
    setIsExistingSupplier(null);
  };

  /**
   * Triggered from step 2 when the reviewer presses "Aprobar datos". For now
   * this is a UI-only transition into the mock step 3 — no real network call.
   * When the backend learns to push to the cloud xlsx maestro, replace the
   * fake progress in `ApprovalStep` with a real upload call.
   */
  const approve = () => {
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
          <ReviewStep result={result} onApprove={approve} />
        )}

        {step === 3 && result && (
          <ApprovalStep result={result} onReset={reset} />
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
  // Cap matches backend validation in `controller.ts` (MAX_COMMENTS_LENGTH).
  const COMMENTS_MAX = 5000;
  // Button is enabled only when we have a file, the supplier flag is set, and
  // we're not already analyzing. The flag check matters: the backend will
  // 400 on submit without it.
  const canSubmit =
    !!file && !analyzing && isExistingSupplier !== null;

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

/**
 * Required Sí / No segmented toggle. We render it as two buttons rather than
 * a single checkbox because "existing supplier" is a binary state we always
 * need a deliberate answer for — leaving it implicit would let users submit
 * with an unintended default. While `value` is null we add a subtle ring on
 * the whole control so it's clear something still needs attention.
 */
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

/**
 * Optional free-form comments textarea. The label is explicit about why this
 * exists (email-body context) so users understand it's worth filling in when
 * they have it. We surface a live character counter once they're past 80% of
 * the limit — silent until then to avoid noise.
 */
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
 * Schema for a single editable field rendered in step 2. The optional
 * `fromExtracted` mapping tells us which AI-extracted field (if any) seeds
 * the initial value — and therefore where source-page chips come from.
 *
 * `wide: true` makes the field span both columns of its section grid (handy
 * for free-text fields like address or policy text).
 */
export interface FieldDef {
  key: DisplayFieldKey;
  label: string;
  icon: LucideIcon;
  placeholder?: string;
  inputType?: "text" | "date" | "email";
  /** Pull initial value + source chip from this AI-extracted field. */
  fromExtracted?:
    | "fecha"
    | "proveedor"
    | "nombre_comercial"
    | "cedula"
    | "direccion"
    | "telefono"
    | "tipo_moneda"
    | "numero_cuenta"
    | "banco";
  multiline?: boolean;
  wide?: boolean;
}

/**
 * Tailwind color tokens used by section accent. Keep these as full class
 * strings (not interpolated) so Tailwind's JIT can pick them up.
 */
export interface SectionAccent {
  iconBg: string;
  iconText: string;
  ring: string;
  pillBg: string;
  pillText: string;
  pillBorder: string;
}

export const ACCENTS = {
  primary: {
    iconBg: "bg-primary/15",
    iconText: "text-primary",
    ring: "border-primary/30",
    pillBg: "bg-primary/10",
    pillText: "text-primary",
    pillBorder: "border-primary/30",
  },
  sky: {
    iconBg: "bg-sky-500/15",
    iconText: "text-sky-300",
    ring: "border-sky-500/30",
    pillBg: "bg-sky-500/10",
    pillText: "text-sky-300",
    pillBorder: "border-sky-500/30",
  },
  emerald: {
    iconBg: "bg-emerald-500/15",
    iconText: "text-emerald-300",
    ring: "border-emerald-500/30",
    pillBg: "bg-emerald-500/10",
    pillText: "text-emerald-300",
    pillBorder: "border-emerald-500/30",
  },
  amber: {
    iconBg: "bg-amber-500/15",
    iconText: "text-amber-300",
    ring: "border-amber-500/30",
    pillBg: "bg-amber-500/10",
    pillText: "text-amber-300",
    pillBorder: "border-amber-500/30",
  },
  violet: {
    iconBg: "bg-violet-500/15",
    iconText: "text-violet-300",
    ring: "border-violet-500/30",
    pillBg: "bg-violet-500/10",
    pillText: "text-violet-300",
    pillBorder: "border-violet-500/30",
  },
  rose: {
    iconBg: "bg-rose-500/15",
    iconText: "text-rose-300",
    ring: "border-rose-500/30",
    pillBg: "bg-rose-500/10",
    pillText: "text-rose-300",
    pillBorder: "border-rose-500/30",
  },
} satisfies Record<string, SectionAccent>;

export interface SectionDef {
  id: string;
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  accent: SectionAccent;
  fields: FieldDef[];
}

export const SECTIONS: SectionDef[] = [
  {
    id: "identidad",
    title: "Información del proveedor",
    subtitle: "Identidad legal, ubicación y vigencia del contrato.",
    icon: Building2,
    accent: ACCENTS.primary,
    fields: [
      { key: "tipo_actividad", label: "Tipo Actividad", icon: Compass, placeholder: "Ej: Hospedaje, tour, transporte…" },
      { key: "zona_turismo", label: "Zona Turismo", icon: MapIcon, placeholder: "Ej: Pacífico Central" },
      { key: "proveedor", label: "Proveedor", icon: Building2, placeholder: "Identificador del proveedor" },
      { key: "razon_social", label: "Razón Social", icon: Building2, placeholder: "Ej: ACME Servicios S.A.", fromExtracted: "proveedor" },
      { key: "cedula_juridica", label: "Cédula Jurídica", icon: Hash, placeholder: "Ej: 3-101-123456", fromExtracted: "cedula" },
      { key: "contract_date", label: "Contract Date", icon: Calendar, placeholder: "YYYY-MM-DD", inputType: "date", fromExtracted: "fecha" },
      { key: "nombre_comercial", label: "Nombre Comercial", icon: BookMarked, placeholder: "Ej: ACME", fromExtracted: "nombre_comercial" },
      { key: "pais", label: "País", icon: Globe, placeholder: "Ej: Costa Rica" },
      { key: "state_province", label: "State / Province", icon: MapPin, placeholder: "Ej: San José" },
      { key: "location", label: "Location", icon: MapPin, placeholder: "Calle, número, ciudad…", fromExtracted: "direccion", wide: true, multiline: true },
      { key: "type_of_business", label: "Type of Business", icon: Briefcase, placeholder: "Ej: Hotel, agencia, operador…" },
      { key: "contract_starts", label: "Contract Starts", icon: CalendarCheck2, placeholder: "YYYY-MM-DD", inputType: "date" },
      { key: "contract_ends", label: "Contract Ends", icon: CalendarRange, placeholder: "YYYY-MM-DD", inputType: "date" },
    ],
  },
  {
    id: "servicio",
    title: "Servicio",
    subtitle: "Producto contratado y unidad comercializada.",
    icon: Package,
    accent: ACCENTS.sky,
    fields: [
      { key: "codigo_servicio", label: "Código Servicio", icon: Hash, placeholder: "Ej: SVC-1024" },
      { key: "product_name", label: "Product Name", icon: Tag, placeholder: "Ej: Habitación Standard" },
      { key: "tipo_unidad", label: "Tipo Unidad", icon: BedDouble, placeholder: "Ej: Habitación / Tour / Vehículo" },
      { key: "tipo_servicio", label: "Tipo Servicio", icon: Tag, placeholder: "Ej: Alojamiento" },
      { key: "categoria", label: "Categoría", icon: Star, placeholder: "Ej: 4 estrellas" },
      { key: "ocupacion", label: "Ocupación", icon: Users, placeholder: "Ej: Doble · 2 adultos" },
    ],
  },
  {
    id: "temporada",
    title: "Temporada",
    subtitle: "Vigencia comercial del producto.",
    icon: Sun,
    accent: ACCENTS.amber,
    fields: [
      { key: "season_name", label: "Season Name", icon: Sparkles, placeholder: "Ej: Alta, Baja, Verde…" },
      { key: "season_starts", label: "Season Starts", icon: Calendar, placeholder: "YYYY-MM-DD", inputType: "date" },
      { key: "season_ends", label: "Season Ends", icon: Calendar, placeholder: "YYYY-MM-DD", inputType: "date" },
      { key: "meals_included", label: "Meals Included", icon: Utensils, placeholder: "Ej: Desayuno · Cena" },
    ],
  },
  {
    id: "tarifas",
    title: "Tarifas estándar",
    subtitle: "Precios de lunes a jueves (o tarifa base).",
    icon: DollarSign,
    accent: ACCENTS.emerald,
    fields: [
      { key: "tipo_tarifa_neta", label: "Tipo Tarifa Neta", icon: DollarSign, placeholder: "Ej: Por persona / por unidad" },
      { key: "precios_neto_iva", label: "Precios Neto con IVA Incluido", icon: Banknote, placeholder: "Ej: 120.00 USD" },
      { key: "precio_rack_iva", label: "Precio Rack con IVA Incluido", icon: Banknote, placeholder: "Ej: 180.00 USD" },
      { key: "tipo_tarifa_mayorista", label: "Tipo Tarifa Mayorista", icon: Receipt, placeholder: "Ej: Wholesale" },
      { key: "porcentaje_comision", label: "Porcentaje de Comisión", icon: Percent, placeholder: "Ej: 18%" },
    ],
  },
  {
    id: "tarifas_fds",
    title: "Tarifas fin de semana",
    subtitle: "Precios aplicables sábados, domingos y feriados.",
    icon: DollarSign,
    accent: ACCENTS.violet,
    fields: [
      { key: "tipo_tarifa_fds", label: "Tipo Tarifa Fin de Semana", icon: DollarSign, placeholder: "Ej: Weekend rate" },
      { key: "t_tar_neta_fds", label: "T.Tar Neta Fin de Semana", icon: DollarSign, placeholder: "Tipo de tarifa neta FdS" },
      { key: "precios_neto_iva_fds", label: "Precios Neto con IVA Incluido Fin de Semana", icon: Banknote, placeholder: "Ej: 140.00 USD" },
      { key: "precio_rack_iva_fds", label: "Precio Rack con IVA Incluido Fin de Semana", icon: Banknote, placeholder: "Ej: 200.00 USD" },
      { key: "tipo_tarifa_mayorista_fds", label: "Tipo Tarifa Mayorista Fin de Semana", icon: Receipt, placeholder: "Ej: Wholesale FdS" },
      { key: "porcentaje_comision_fds", label: "Porcentaje de Comisión Fin de Semana", icon: Percent, placeholder: "Ej: 18%" },
    ],
  },
  {
    id: "politicas",
    title: "Políticas",
    subtitle: "Cancelación, pago, niños y otros incluidos.",
    icon: ShieldAlert,
    accent: ACCENTS.rose,
    fields: [
      { key: "cancellation_policy", label: "Cancellation Policy", icon: ShieldAlert, placeholder: "Resumen de la política de cancelación", wide: true, multiline: true },
      { key: "range_payment_policy", label: "Range Payment Policy", icon: Wallet, placeholder: "Ventana de pago aplicable", wide: true, multiline: true },
      { key: "others_payment_cancel", label: "Others in Payment or Cancellation", icon: FileText, placeholder: "Cláusulas adicionales", wide: true, multiline: true },
      { key: "kids_policy", label: "Kids Policy", icon: Baby, placeholder: "Reglas para menores", wide: true, multiline: true },
      { key: "other_included", label: "Other Included", icon: PlusCircle, placeholder: "Otros servicios incluidos" },
      { key: "feeds_adicionales", label: "Feeds Adicionales", icon: Receipt, placeholder: "Cargos extras" },
    ],
  },
  {
    id: "credito",
    title: "Reservas y crédito",
    subtitle: "Contacto operativo y términos de pago.",
    icon: Mail,
    accent: ACCENTS.sky,
    fields: [
      { key: "reservations_email", label: "Reservations Email", icon: Mail, placeholder: "reservas@proveedor.com", inputType: "email" },
      { key: "cond_credito", label: "Cond. Crédito", icon: CreditCard, placeholder: "Ej: 30 días neto" },
      { key: "plazo", label: "Plazo", icon: Clock, placeholder: "Ej: 30 días" },
    ],
  },
  {
    id: "bancos",
    title: "Información bancaria",
    subtitle: "Hasta 3 cuentas bancarias del proveedor.",
    icon: Landmark,
    accent: ACCENTS.emerald,
    fields: [
      { key: "cuenta_bancaria_1", label: "Cuenta Bancaria 1", icon: CreditCard, placeholder: "IBAN preferido", fromExtracted: "numero_cuenta" },
      { key: "banco_1", label: "Banco 1", icon: Landmark, placeholder: "Ej: BAC Credomatic", fromExtracted: "banco" },
      { key: "moneda_1", label: "Moneda 1", icon: Banknote, placeholder: "USD, EUR, CRC…", fromExtracted: "tipo_moneda" },
      { key: "cuenta_bancaria_2", label: "Cuenta Bancaria 2", icon: CreditCard, placeholder: "IBAN preferido" },
      { key: "banco_2", label: "Banco 2", icon: Landmark, placeholder: "Ej: BAC Credomatic" },
      { key: "moneda_2", label: "Moneda 2", icon: Banknote, placeholder: "USD, EUR, CRC…" },
      { key: "cuenta_bancaria_3", label: "Cuenta Bancaria 3", icon: CreditCard, placeholder: "IBAN preferido" },
      { key: "banco_3", label: "Banco 3", icon: Landmark, placeholder: "Ej: BAC Credomatic" },
      { key: "moneda_3", label: "Moneda 3", icon: Banknote, placeholder: "USD, EUR, CRC…" },
    ],
  },
];

/**
 * Flatten the section schema into a single array — used by the search filter
 * and "edit count" math without re-walking the section tree each render.
 */
export const ALL_FIELDS: FieldDef[] = SECTIONS.flatMap((s) => s.fields);

/** Build a `{ displayKey -> initial value }` map from the AI extraction. */
function buildInitialValues(
  extracted: ExtractedContract,
): Record<DisplayFieldKey, string | null> {
  const out: Partial<Record<DisplayFieldKey, string | null>> = {};
  for (const field of ALL_FIELDS) {
    out[field.key] = field.fromExtracted
      ? (extracted[field.fromExtracted] ?? null)
      : null;
  }
  return out as Record<DisplayFieldKey, string | null>;
}

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

type RowFilter = "all" | "filled" | "empty";

const ROW_FILTERS: { id: RowFilter; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "filled", label: "Con valor" },
  { id: "empty", label: "Vacíos" },
];

function ReviewStep({
  result,
  onApprove,
}: {
  result: ExtractContractResponse;
  onApprove: () => void;
}) {
  const { data, validation, meta } = result;
  const conf = CONFIANZA_STYLES[data.confianza];

  // Initial values seeded from the AI extraction. Keys are display-field
  // names; values come from the mapped `fromExtracted` entry (or null).
  const initialValues = useMemo(() => buildInitialValues(data), [data]);

  /**
   * User overrides keyed by display field name. A key is present here only
   * after the user explicitly saved an edit — `null` means "user cleared the
   * field", a non-empty string means "user-supplied value". The initial
   * map stays unchanged.
   */
  const [edits, setEdits] = useState<
    Partial<Record<DisplayFieldKey, string | null>>
  >({});

  const setFieldEdit = (key: DisplayFieldKey, value: string | null) => {
    setEdits((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Effective per-key value to display: user edit (if any) over initial.
   * Recomputed when either side changes.
   */
  const displayValues = useMemo<Record<DisplayFieldKey, string | null>>(() => {
    if (Object.keys(edits).length === 0) return initialValues;
    return { ...initialValues, ...edits };
  }, [initialValues, edits]);

  // Toolbar state.
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<RowFilter>("all");
  // Per-section collapsed state. Default: all collapsed — the field set is
  // long, so the user opens only the section they want to inspect.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SECTIONS.map((s) => [s.id, true])),
  );
  const toggleSection = (id: string) =>
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  const setAllCollapsed = (next: boolean) => {
    setCollapsed(
      Object.fromEntries(SECTIONS.map((s) => [s.id, next])) as Record<
        string,
        boolean
      >,
    );
  };
  const allCollapsed = SECTIONS.every((s) => collapsed[s.id]);

  // Helper used by both the section header counters and the filter logic so
  // they always agree on what counts as "with value".
  const isFilled = (k: DisplayFieldKey) => {
    const v = displayValues[k];
    return typeof v === "string" && v.trim() !== "";
  };

  const totalFields = ALL_FIELDS.length;
  const filledCount = ALL_FIELDS.filter((f) => isFilled(f.key)).length;

  const normSearch = search.trim().toLowerCase();
  const matchesFilter = (f: FieldDef) => {
    if (normSearch && !f.label.toLowerCase().includes(normSearch)) return false;
    if (filter === "filled") return isFilled(f.key);
    if (filter === "empty") return !isFilled(f.key);
    return true;
  };

  // Visible fields per section after filtering. Sections with zero matches
  // are hidden entirely so the user isn't scrolling through empty cards.
  const visibleSections = useMemo(
    () =>
      SECTIONS.map((s) => ({
        section: s,
        fields: s.fields.filter(matchesFilter),
      })).filter((s) => s.fields.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [normSearch, filter, displayValues],
  );

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
                {filledCount}/{totalFields} con valor
              </span>
            </div>
            <p className="text-[12.5px] text-muted-foreground mt-1 truncate">
              {meta.filename} · {humanSize(meta.size_bytes)} · modelo{" "}
              {meta.model}
            </p>
          </div>
        </div>

        {/* Completion progress bar */}
        <div className="mt-3 space-y-1">
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-secondary/70 border border-border/50">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-emerald-400 shadow-[0_0_10px_0_hsl(var(--primary)/0.4)] transition-[width] duration-300 ease-out"
              style={{
                width: `${Math.round((filledCount / totalFields) * 100)}%`,
              }}
            />
          </div>
          <p className="text-[10.5px] text-muted-foreground tabular-nums">
            {Math.round((filledCount / totalFields) * 100)}% del registro
            completo
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

      {/* Toolbar — search + filter chips + expand/collapse */}
      <div className="rounded-xl border border-border bg-card/60 px-3.5 py-3 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar campo… (ej: cuenta, fecha, comisión)"
              aria-label="Buscar campo"
              className="w-full h-10 pl-9 pr-3 rounded-md border border-border bg-secondary/40 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-primary/60 focus:bg-secondary/60 transition-colors"
            />
          </div>
          <button
            type="button"
            onClick={() => setAllCollapsed(!allCollapsed)}
            className="inline-flex items-center justify-center gap-1.5 h-10 px-3.5 rounded-md border border-border bg-secondary/40 text-[13px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
          >
            <ChevronDown
              className={`w-4 h-4 transition-transform ${
                allCollapsed ? "" : "rotate-180"
              }`}
            />
            {allCollapsed ? "Expandir todo" : "Colapsar todo"}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ROW_FILTERS.map((f) => {
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                aria-pressed={active}
                className={`inline-flex items-center px-3 py-1.5 rounded-full text-[12.5px] font-medium border transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground border-primary shadow-[0_0_10px_0_hsl(var(--primary)/0.35)]"
                    : "bg-secondary/40 text-muted-foreground border-border hover:text-foreground hover:bg-secondary/70"
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Section cards */}
      {visibleSections.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-secondary/20 px-4 py-10 text-center">
          <p className="text-[14.5px] text-muted-foreground">
            Ningún campo coincide con la búsqueda o el filtro actual.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleSections.map(({ section, fields }) => (
            <SectionCard
              key={section.id}
              section={section}
              fields={fields}
              collapsed={!!collapsed[section.id]}
              onToggle={() => toggleSection(section.id)}
              displayValues={displayValues}
              extracted={data}
              filename={meta.filename}
              onSave={setFieldEdit}
              isFilled={isFilled}
            />
          ))}
        </div>
      )}

      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onApprove}
          className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
        >
          <ShieldCheck className="w-4 h-4" />
          Aprobar datos
          <ArrowRight className="w-4 h-4 opacity-80" />
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------- STEP 3 -------------------------------- */

/**
 * Mock cloud-upload phases. The real backend integration doesn't exist yet —
 * we simulate progress against these copy bands so the user gets a believable
 * "uploading to the cloud xlsx maestro" experience while the feature is
 * fictitious. Replace `useFakeUpload` with a real fetch when the endpoint
 * lands.
 */
const UPLOAD_PHASES: { from: number; to: number; label: string }[] = [
  { from: 0, to: 18, label: "Conectando con el servidor…" },
  { from: 18, to: 38, label: "Verificando duplicados en el maestro…" },
  { from: 38, to: 70, label: "Insertando nueva fila en el xlsx…" },
  { from: 70, to: 95, label: "Sincronizando con la nube…" },
  { from: 95, to: 100, label: "Confirmando cambios…" },
];

function uploadPhase(progress: number): string {
  const match = UPLOAD_PHASES.find(
    (p) => progress >= p.from && progress < p.to,
  );
  return match?.label ?? "Listo";
}

/**
 * Drives a simulated 0 → 100 progress bar. Easing: small random increments
 * with a faster ramp early on and a slow finish near 100. Calls `onDone` the
 * moment we cross 100 so the parent can swap to the success view — we
 * deliberately don't linger at 100% with a spinner; that's the visual the
 * user flagged as confusing.
 *
 * The hook is intentionally self-contained — no props, no dependencies — so
 * future replacement with a real `fetch` + `progress` listener is a one-line
 * swap inside ApprovalStep.
 */
function useFakeUpload(onDone: () => void) {
  const [progress, setProgress] = useState(0);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  // Keep the latest onDone reachable from the interval without re-creating
  // the timer on every render.
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(() => {
      if (cancelled) return;
      setProgress((p) => {
        if (p >= 100) return p;
        // Bigger jumps when far from the ceiling, smaller as we approach 100
        // — feels like work happening throughout instead of a linear march.
        const ceil = 100;
        const remaining = ceil - p;
        const jump = Math.max(0.6, remaining * (0.04 + Math.random() * 0.05));
        return Math.min(ceil, p + jump);
      });
    }, 240);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Fire `onDone` exactly once, the instant we hit 100%. Doing this in a
  // separate effect (rather than inside the setState updater) keeps the
  // updater pure and avoids a one-tick stall where the spinner was visible
  // alongside a full bar.
  useEffect(() => {
    if (progress >= 100 && !doneRef.current) {
      doneRef.current = true;
      onDoneRef.current();
    }
  }, [progress]);

  return progress;
}

/**
 * Step 3 — fictitious "subir al maestro" stage. Renders an animated upload
 * card while progress climbs to 100%, then a success card with a CTA to start
 * a new contract. No real network call yet.
 */
function ApprovalStep({
  result,
  onReset,
}: {
  result: ExtractContractResponse;
  onReset: () => void;
}) {
  const [done, setDone] = useState(false);
  const progress = useFakeUpload(() => setDone(true));
  const { meta } = result;

  if (done) {
    return <UploadSuccessCard meta={meta} onReset={onReset} />;
  }
  return <UploadInProgressCard progress={progress} meta={meta} />;
}

function UploadInProgressCard({
  progress,
  meta,
}: {
  progress: number;
  meta: ExtractContractResponse["meta"];
}) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  const phase = uploadPhase(progress);

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
          Subiendo al maestro
        </h3>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          Estamos agregando los datos aprobados al documento oficial xlsx en la
          nube. No cierres esta ventana.
        </p>
      </div>

      <div className="mx-auto max-w-xl rounded-xl border border-primary/30 bg-primary/5 px-4 py-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-secondary/70 border border-border flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-4 h-4 text-emerald-300" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">
              Maestro de proveedores · xlsx
            </p>
            <p className="text-[11.5px] text-muted-foreground truncate">
              Origen: {meta.filename}
            </p>
          </div>
          <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] text-foreground/90 truncate">{phase}</p>
          <p
            className="text-[13px] font-semibold text-primary tabular-nums"
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
          aria-label="Progreso de subida al maestro"
          className="relative h-1.5 w-full overflow-hidden rounded-full bg-secondary/70 border border-border/50"
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary to-emerald-400 shadow-[0_0_12px_0_hsl(var(--primary)/0.5)] transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Esto suele tardar unos pocos segundos.
        </p>
      </div>
    </div>
  );
}

function UploadSuccessCard({
  meta,
  onReset,
}: {
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
          ¡Datos sincronizados al maestro!
        </h3>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          Se agregó una nueva fila al xlsx oficial de proveedores con la
          información aprobada.
        </p>
      </div>

      <div className="mx-auto max-w-xl rounded-xl border border-border bg-card/60 divide-y divide-border/50">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-4 h-4 text-emerald-300" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">
              Maestro de proveedores · xlsx
            </p>
            <p className="text-[11.5px] text-muted-foreground truncate">
              1 fila agregada
            </p>
          </div>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
            <Check className="w-3 h-3" />
            Sincronizado
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
          Abrir el maestro xlsx
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

/**
 * One section card. Header is clickable to collapse / expand. Title row
 * carries: section icon (color-coded), title, subtitle, completion pill,
 * chevron indicator. Body is a 1- or 2-column grid of FieldRows.
 */
function SectionCard({
  section,
  fields,
  collapsed,
  onToggle,
  displayValues,
  extracted,
  filename,
  onSave,
  isFilled,
}: {
  section: SectionDef;
  fields: FieldDef[];
  collapsed: boolean;
  onToggle: () => void;
  displayValues: Record<DisplayFieldKey, string | null>;
  extracted: ExtractedContract;
  filename: string;
  onSave: (key: DisplayFieldKey, value: string | null) => void;
  isFilled: (k: DisplayFieldKey) => boolean;
}) {
  // Use the *full* section field list (not the filtered one) for the
  // completion counter — the pill should reflect the section as a whole, not
  // the currently-visible subset.
  const sectionFilled = section.fields.filter((f) => isFilled(f.key)).length;
  const sectionTotal = section.fields.length;
  const SectionIcon = section.icon;
  const accent = section.accent;

  return (
    <section
      className={`rounded-xl border bg-card/60 overflow-hidden transition-colors ${accent.ring}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-secondary/30 transition-colors"
      >
        <div
          className={`w-10 h-10 rounded-lg ${accent.iconBg} ${accent.ring} border flex items-center justify-center shrink-0`}
        >
          <SectionIcon className={`w-4.5 h-4.5 ${accent.iconText}`} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[14.5px] font-semibold text-foreground truncate">
            {section.title}
          </p>
          {section.subtitle && (
            <p className="text-[12.5px] text-muted-foreground truncate">
              {section.subtitle}
            </p>
          )}
        </div>
        <span
          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full border text-[11.5px] font-semibold tabular-nums shrink-0 ${accent.pillBg} ${accent.pillBorder} ${accent.pillText}`}
        >
          {sectionFilled}/{sectionTotal}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground transition-transform shrink-0 ${
            collapsed ? "" : "rotate-180"
          }`}
        />
      </button>
      {!collapsed && (
        <div className="border-t border-border/60 bg-card/40">
          {/* Single column — each field reads top-to-bottom like a spreadsheet
             row. The horizontal divider between rows acts as the column
             separator that the future Excel export mirrors. */}
          <div className="divide-y divide-border/50">
            {fields.map((f) => (
              <FieldRow
                key={f.key}
                field={f}
                value={displayValues[f.key]}
                source={
                  f.fromExtracted
                    ? extracted.paginas_origen[f.fromExtracted]
                    : undefined
                }
                isMarkedMissing={
                  !!f.fromExtracted &&
                  extracted.campos_faltantes.includes(f.fromExtracted)
                }
                filename={filename}
                onSave={(v) => onSave(f.key, v)}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Single read/edit row. Two visual modes:
 *
 *   - read:  shows the value (or a missing placeholder) plus the source-page
 *            chip and a pencil button next to each other on the right.
 *            Clicking the pencil flips into edit mode.
 *   - edit:  shows an `<input>` (or a `<textarea>` for multiline fields)
 *            with Save / Cancel actions. Save updates the parent edits map;
 *            Cancel discards the in-progress draft.
 */
function FieldRow({
  field,
  value,
  source,
  isMarkedMissing,
  filename,
  onSave,
}: {
  field: FieldDef;
  value: string | null;
  source: string | number | undefined;
  isMarkedMissing: boolean;
  filename: string;
  onSave: (next: string | null) => void;
}) {
  const { icon: Icon, label, placeholder, inputType, multiline } = field;
  const missing = value === null || value === "";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const startEdit = () => {
    setDraft(value ?? "");
    setEditing(true);
  };

  // Autofocus the input when entering edit mode for keyboard-friendliness.
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const cancel = () => {
    setEditing(false);
    setDraft("");
  };

  const commit = () => {
    const trimmed = draft.trim();
    onSave(trimmed === "" ? null : trimmed);
    setEditing(false);
    setDraft("");
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  const hasSource = source !== undefined && source !== null;

  return (
    <div className="group px-5 py-4 min-w-0 hover:bg-secondary/20 transition-colors">
      <div className="flex items-center gap-2 text-muted-foreground min-w-0">
        <Icon className="w-4 h-4 shrink-0" />
        <p className="text-[12px] uppercase tracking-wider font-semibold truncate">
          {label}
        </p>
      </div>

      {editing ? (
        <div className="mt-2 flex items-start gap-2">
          {multiline ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={3}
              className="flex-1 min-w-0 resize-y rounded-md border border-primary/40 bg-secondary/40 px-3 py-2 text-[15px] leading-relaxed text-foreground outline-none focus:border-primary focus:bg-secondary/60"
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type={inputType ?? "text"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="flex-1 min-w-0 rounded-md border border-primary/40 bg-secondary/40 px-3 py-2 text-[15px] text-foreground outline-none focus:border-primary focus:bg-secondary/60"
            />
          )}
          <button
            type="button"
            onClick={commit}
            aria-label={`Guardar ${label}`}
            className="inline-flex items-center justify-center h-9 w-9 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity shrink-0"
          >
            <Check className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={cancel}
            aria-label="Cancelar edición"
            className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-border bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="mt-1.5 flex items-start gap-3">
          <p
            className={`flex-1 min-w-0 text-[15px] leading-relaxed break-words ${
              missing ? "text-muted-foreground/60 italic" : "text-foreground"
            }`}
          >
            {missing
              ? isMarkedMissing
                ? "No encontrado en el documento"
                : "Vacío — clic en ✎ para agregar"
              : value}
          </p>
          {/* Page-source chip + pencil sit side-by-side on the right of the
             value, so the audit trail (where it came from) is visually paired
             with the action that lets you change it. */}
          <div className="flex items-center gap-2 shrink-0">
            {hasSource && <SourceChip source={source} filename={filename} />}
            <button
              type="button"
              onClick={startEdit}
              aria-label={missing ? `Agregar ${label}` : `Editar ${label}`}
              title={missing ? `Agregar ${label}` : `Editar ${label}`}
              className="inline-flex items-center justify-center h-8 w-8 rounded-md border border-transparent text-muted-foreground hover:text-primary hover:border-primary/30 hover:bg-primary/10 group-hover:text-primary/70 transition-colors"
            >
              <Pencil className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
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
      className="inline-flex max-w-[260px] items-center gap-1 px-2 py-0.5 rounded border border-border bg-secondary/40 text-[11px] font-medium text-muted-foreground whitespace-nowrap"
    >
      <span className="shrink-0">{base}</span>
      <span aria-hidden className="text-muted-foreground/50">
        ·
      </span>
      <span className="truncate text-muted-foreground/80">{filename}</span>
    </span>
  );
}

