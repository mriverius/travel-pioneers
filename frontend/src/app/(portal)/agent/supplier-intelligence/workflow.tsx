"use client";

import {
  Check,
  CheckCircle2,
  CloudUpload,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";

/**
 * Three-step supplier-contract workflow.
 *
 *   1. Upload   — drag & drop / pick .pdf / .docx / .xlsx files.
 *   2. Review   — show the fields the AI extracted; approve or reject.
 *   3. Confirm  — success screen with a "procesar otro" reset.
 *
 * Everything here is mock: there's no network call. The "AI analysis" in
 * step 2 is a canned payload surfaced after a short fake delay so the UI
 * can demonstrate the loading state. Replace `runMockAnalysis` and the
 * approve handler with real API calls when the backend is ready.
 */

type Step = 1 | 2 | 3;

type UploadFile = {
  id: string;
  name: string;
  size: number;
  type: FileKind;
};

type FileKind = "pdf" | "docx" | "xlsx";

type ExtractedRate = {
  category: string;
  season: string;
  regimen: string;
  netPrice: string;
  withTax: string;
};

type ExtractedPayload = {
  supplier: string;
  country: string;
  currency: string;
  validity: string;
  taxes: string;
  cancellation: string;
  rates: ExtractedRate[];
  warnings: string[];
};

const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".xlsx"] as const;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file — mock cap.

const STEPS: { id: Step; label: string; hint: string }[] = [
  { id: 1, label: "Cargar documentos", hint: "PDF, Word o Excel" },
  { id: 2, label: "Revisar información", hint: "Aprueba o rechaza" },
  { id: 3, label: "Confirmación", hint: "Carga a Utopía" },
];

/** Canned "AI output" — looks different enough per run that the demo feels alive. */
function runMockAnalysis(files: UploadFile[]): ExtractedPayload {
  const seed = files.reduce((acc, f) => acc + f.name.length, 0) % 2;
  if (seed === 0) {
    return {
      supplier: "Hotel Pacífico Resort & Spa",
      country: "Costa Rica",
      currency: "USD",
      validity: "01/04/2026 → 31/03/2027",
      taxes: "13% IVA incluido · 3% cargo de servicio",
      cancellation: "Gratis hasta 48 h antes del check-in · 1 noche después",
      rates: [
        {
          category: "Standard Ocean View",
          season: "Temporada Baja",
          regimen: "Desayuno",
          netPrice: "$168",
          withTax: "$189.84",
        },
        {
          category: "Standard Ocean View",
          season: "Temporada Alta",
          regimen: "Desayuno",
          netPrice: "$212",
          withTax: "$239.56",
        },
        {
          category: "Suite Deluxe",
          season: "Temporada Alta",
          regimen: "Media Pensión",
          netPrice: "$298",
          withTax: "$336.74",
        },
        {
          category: "Villa Privada",
          season: "Todo el año",
          regimen: "Plan Europeo",
          netPrice: "$410",
          withTax: "$463.30",
        },
      ],
      warnings: [
        "No se detectaron tarifas de niños — se asumirá política estándar.",
      ],
    };
  }
  return {
    supplier: "DMC Aventura Guatemala",
    country: "Guatemala",
    currency: "USD",
    validity: "15/05/2026 → 14/05/2027",
    taxes: "12% IVA + 10% INGUAT",
    cancellation: "Gratis hasta 72 h antes · 100% dentro de 24 h",
    rates: [
      {
        category: "Tour Antigua Ciudad Colonial",
        season: "Todo el año",
        regimen: "Día completo",
        netPrice: "$85",
        withTax: "$103.70",
      },
      {
        category: "Tour Lago Atitlán",
        season: "Todo el año",
        regimen: "Día completo",
        netPrice: "$120",
        withTax: "$146.40",
      },
      {
        category: "Tour Tikal 2D/1N",
        season: "Temporada Alta",
        regimen: "Paquete completo",
        netPrice: "$480",
        withTax: "$585.60",
      },
    ],
    warnings: [],
  };
}

function inferKind(name: string): FileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".xlsx")) return "xlsx";
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
  return <FileArchive className="w-4 h-4 text-amber-300" />;
}

export function SupplierWorkflow() {
  const [step, setStep] = useState<Step>(1);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [extracted, setExtracted] = useState<ExtractedPayload | null>(null);
  const [rejected, setRejected] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalSize = useMemo(
    () => files.reduce((acc, f) => acc + f.size, 0),
    [files],
  );

  const addFiles = (incoming: FileList | File[]) => {
    setUploadError(null);
    const next: UploadFile[] = [];
    const errors: string[] = [];
    for (const f of Array.from(incoming)) {
      const kind = inferKind(f.name);
      if (!kind) {
        errors.push(`${f.name}: formato no admitido (usa PDF, DOCX o XLSX).`);
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        errors.push(`${f.name}: excede el tamaño máximo de 25 MB.`);
        continue;
      }
      next.push({
        id: `${f.name}-${f.size}-${f.lastModified}`,
        name: f.name,
        size: f.size,
        type: kind,
      });
    }
    if (errors.length > 0) setUploadError(errors.join(" "));
    if (next.length === 0) return;
    setFiles((prev) => {
      // De-dupe by id so re-selecting the same file is a no-op.
      const ids = new Set(prev.map((p) => p.id));
      return [...prev, ...next.filter((n) => !ids.has(n.id))];
    });
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!e.dataTransfer.files) return;
    addFiles(e.dataTransfer.files);
  };

  const handlePick = (e: ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    addFiles(e.target.files);
    // Reset so selecting the same file again triggers change.
    e.target.value = "";
  };

  const startAnalysis = () => {
    if (files.length === 0) return;
    setAnalyzing(true);
    setRejected(false);
    // Fake "AI processing" — enough to show the loading state.
    window.setTimeout(() => {
      setExtracted(runMockAnalysis(files));
      setAnalyzing(false);
      setStep(2);
    }, 1400);
  };

  const approve = () => {
    setStep(3);
  };

  const reject = () => {
    setRejected(true);
    setExtracted(null);
    setStep(1);
  };

  const reset = () => {
    setStep(1);
    setFiles([]);
    setExtracted(null);
    setUploadError(null);
    setRejected(false);
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
            files={files}
            totalSize={totalSize}
            uploadError={uploadError}
            rejected={rejected}
            analyzing={analyzing}
            fileInputRef={fileInputRef}
            onDrop={handleDrop}
            onPick={handlePick}
            onRemove={removeFile}
            onStart={startAnalysis}
          />
        )}

        {step === 2 && extracted && (
          <ReviewStep
            data={extracted}
            fileCount={files.length}
            onApprove={approve}
            onReject={reject}
          />
        )}

        {step === 3 && (
          <ConfirmStep
            fileCount={files.length}
            supplier={extracted?.supplier ?? "el proveedor"}
            onReset={reset}
          />
        )}
      </div>
    </section>
  );
}

/* ---------------------------------- STEP 1 -------------------------------- */

function UploadStep({
  files,
  totalSize,
  uploadError,
  rejected,
  analyzing,
  fileInputRef,
  onDrop,
  onPick,
  onRemove,
  onStart,
}: {
  files: UploadFile[];
  totalSize: number;
  uploadError: string | null;
  rejected: boolean;
  analyzing: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onPick: (e: ChangeEvent<HTMLInputElement>) => void;
  onRemove: (id: string) => void;
  onStart: () => void;
}) {
  const [dragActive, setDragActive] = useState(false);

  return (
    <div className="px-5 sm:px-8 py-7 space-y-5">
      {rejected && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[13px] text-amber-200"
        >
          <Sparkles className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Descartamos el análisis anterior. Carga nuevos documentos o ajústalos
            para volver a intentar.
          </span>
        </div>
      )}

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
          multiple
          accept={ACCEPTED_EXTENSIONS.join(",")}
          onChange={onPick}
          className="hidden"
        />
        <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center animate-pulse-glow">
          <CloudUpload className="w-6 h-6 text-primary" />
        </div>
        <p className="mt-4 text-[15px] font-semibold text-foreground">
          Arrastra tus contratos aquí
        </p>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          o{" "}
          <span className="text-primary font-medium">
            haz click para buscarlos
          </span>{" "}
          en tu equipo
        </p>
        <div className="mt-4 inline-flex items-center gap-2 text-[11px] text-muted-foreground/80">
          <Badge label="PDF" />
          <Badge label="DOCX" />
          <Badge label="XLSX" />
          <span className="opacity-60">· hasta 25 MB c/u</span>
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

      {files.length > 0 && (
        <div className="rounded-xl border border-border bg-card/60">
          <header className="flex items-center justify-between px-4 py-3 border-b border-border/60">
            <p className="text-[12.5px] font-semibold text-foreground">
              {files.length} documento{files.length === 1 ? "" : "s"} listo
              {files.length === 1 ? "" : "s"} para procesar
            </p>
            <p className="text-[11.5px] text-muted-foreground">
              Total: {humanSize(totalSize)}
            </p>
          </header>
          <ul className="divide-y divide-border/50">
            {files.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/30 transition-colors"
              >
                <div className="w-8 h-8 rounded-lg bg-secondary/70 border border-border/60 flex items-center justify-center shrink-0">
                  {fileIcon(f.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-foreground truncate">
                    {f.name}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {humanSize(f.size)} · {f.type.toUpperCase()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(f.id)}
                  aria-label={`Quitar ${f.name}`}
                  className="text-muted-foreground hover:text-destructive transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
        <button
          type="button"
          onClick={onStart}
          disabled={files.length === 0 || analyzing}
          className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
        >
          {analyzing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Analizando documento{files.length === 1 ? "" : "s"}…
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

/* ---------------------------------- STEP 2 -------------------------------- */

function ReviewStep({
  data,
  fileCount,
  onApprove,
  onReject,
}: {
  data: ExtractedPayload;
  fileCount: number;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="px-5 sm:px-8 py-7 space-y-5">
      <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/8 px-3.5 py-2.5">
        <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 text-[13px] text-foreground/90">
          <p className="font-semibold text-foreground">Análisis completado</p>
          <p className="text-muted-foreground mt-0.5">
            Revisé {fileCount} documento{fileCount === 1 ? "" : "s"} y esto es
            lo que subiré a <span className="text-primary">Utopía</span>.
            Aprueba para cargarlo o rechaza para descartar.
          </p>
        </div>
      </div>

      {/* Supplier summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FieldRow label="Proveedor" value={data.supplier} />
        <FieldRow label="País" value={data.country} />
        <FieldRow label="Moneda" value={data.currency} />
        <FieldRow label="Vigencia" value={data.validity} />
        <FieldRow label="Impuestos" value={data.taxes} />
        <FieldRow
          label="Política de cancelación"
          value={data.cancellation}
          className="sm:col-span-2"
        />
      </div>

      {/* Rates table */}
      <div className="rounded-xl border border-border bg-card/60 overflow-hidden">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
          <FileSpreadsheet className="w-4 h-4 text-primary" />
          <h3 className="text-[13px] font-semibold text-foreground">
            Tarifas detectadas{" "}
            <span className="text-muted-foreground font-normal">
              ({data.rates.length})
            </span>
          </h3>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 text-[11.5px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left font-semibold px-4 py-2.5">
                  Categoría
                </th>
                <th className="text-left font-semibold px-4 py-2.5">
                  Temporada
                </th>
                <th className="text-left font-semibold px-4 py-2.5">Régimen</th>
                <th className="text-right font-semibold px-4 py-2.5">Neto</th>
                <th className="text-right font-semibold px-4 py-2.5 pr-4">
                  Neto + Imp.
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rates.map((r, i) => (
                <tr
                  key={`${r.category}-${r.season}-${i}`}
                  className="border-t border-border/50 hover:bg-secondary/20 transition-colors"
                >
                  <td className="px-4 py-2.5 text-[13px] text-foreground">
                    {r.category}
                  </td>
                  <td className="px-4 py-2.5 text-[12.5px] text-muted-foreground">
                    {r.season}
                  </td>
                  <td className="px-4 py-2.5 text-[12.5px] text-muted-foreground">
                    {r.regimen}
                  </td>
                  <td className="px-4 py-2.5 text-right text-[13px] font-medium text-foreground/90">
                    {r.netPrice}
                  </td>
                  <td className="px-4 py-2.5 pr-4 text-right text-[13px] font-semibold text-primary">
                    {r.withTax}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {data.warnings.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12.5px] text-amber-200">
          <Sparkles className="w-4 h-4 mt-0.5 shrink-0" />
          <ul className="space-y-1">
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onReject}
          className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-destructive/40 text-destructive text-[13.5px] font-medium hover:bg-destructive/10 transition-colors"
        >
          <X className="w-4 h-4" />
          Rechazar
        </button>
        <button
          type="button"
          onClick={onApprove}
          className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
        >
          <Check className="w-4 h-4" />
          Aprobar y cargar a Utopía
        </button>
      </div>
    </div>
  );
}

function FieldRow({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-border bg-secondary/30 px-3.5 py-2.5 ${className}`}
    >
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </p>
      <p className="text-[13.5px] text-foreground mt-1">{value}</p>
    </div>
  );
}

/* ---------------------------------- STEP 3 -------------------------------- */

function ConfirmStep({
  fileCount,
  supplier,
  onReset,
}: {
  fileCount: number;
  supplier: string;
  onReset: () => void;
}) {
  return (
    <div className="px-5 sm:px-8 py-12 text-center">
      <div className="mx-auto w-16 h-16 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center animate-pulse-glow">
        <CheckCircle2 className="w-8 h-8 text-primary" />
      </div>
      <h2 className="text-[22px] font-semibold tracking-tight mt-5">
        ¡Información cargada correctamente!
      </h2>
      <p className="text-[14px] text-muted-foreground mt-2 max-w-[480px] mx-auto">
        Los datos extraídos de{" "}
        <span className="text-foreground font-medium">{supplier}</span> se
        subieron a <span className="text-primary font-medium">Utopía</span> y
        están listos para usarse. Procesamos {fileCount} documento
        {fileCount === 1 ? "" : "s"}.
      </p>

      <div className="mt-8 grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-[520px] mx-auto">
        <ConfirmCell label="Proveedor" value="Creado" />
        <ConfirmCell label="Tarifas" value="Cargadas" />
        <ConfirmCell label="Estado" value="Activo" />
      </div>

      <button
        type="button"
        onClick={onReset}
        className="btn-premium mt-9 inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px] mx-auto"
      >
        <RotateCcw className="w-4 h-4" />
        Procesar otro contrato
      </button>
    </div>
  );
}

function ConfirmCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
      <p className="text-[10.5px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </p>
      <p className="text-[13px] text-primary font-semibold mt-0.5 flex items-center justify-center gap-1">
        <Check className="w-3.5 h-3.5" />
        {value}
      </p>
    </div>
  );
}

