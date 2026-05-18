"use client";

import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Eye,
  FileSpreadsheet,
  FileText,
  Loader2,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  ALL_FIELDS,
  SECTIONS,
  type DisplayFieldKey,
  type SectionDef,
} from "./historyTypes";
import { type FileKind } from "./workflow";
import {
  api,
  ApiError,
  type ContractRun,
  type ContractFileKind,
  type ExtractedContractRow,
  type ExtractedSharedFields,
  type GenerateXlsxCatalogPrefill,
  type GenerateXlsxManualFields,
} from "@/lib/api";

/* ---------------------------------- Types --------------------------------- */

/**
 * One processed-contract record. `values` carries the same display-field
 * schema as Step 2 so the detail modal can render exactly the same field
 * structure without conversion.
 *
 * Fed by `GET /api/supplier-intelligence/contracts` via `useContractRuns`
 * (see below). The flattening from `{shared_fields, rows, catalog, manual}`
 * into a single `Partial<Record<DisplayFieldKey, string>>` happens here so
 * the detail modal stays identical to Step 2's read-only sections.
 */
export interface HistoryEntry {
  id: string;
  filename: string;
  fileKind: FileKind;
  /** ISO timestamp of when the contract finished processing. */
  processedAt: string;
  /**
   * Sparse value map keyed by display field. Anything missing is treated as
   * `null` ("vacío") in the detail modal — same convention as Step 2.
   */
  values: Partial<Record<DisplayFieldKey, string>>;
}

/* ---------------------------------- Data ---------------------------------- */

/**
 * Convierte un `ContractRun` del backend al schema plano que usa el modal
 * de detalle (heredado de Step 2). Los campos por-fila vienen del primer
 * row — un contrato típico tiene N filas (product × season) y la UI actual
 * solo muestra la primera como representativa. Si más adelante añadimos un
 * selector de fila en el modal, aquí mapearíamos una fila distinta.
 *
 * Convención de nombres: `proveedor` en `DisplayFieldKey` representa el
 * **código del catálogo** (ej. "TORTUGA-001"), no la razón social. La
 * razón social vive en `razon_social` (que mapea a `sharedFields.proveedor`,
 * el nombre que la IA extrae). Esta asimetría existe porque el xlsx maestro
 * separa "código de proveedor" (col C) de "razón social" (col D).
 */
function flattenContractRun(
  run: ContractRun,
): Partial<Record<DisplayFieldKey, string>> {
  const s: ExtractedSharedFields = run.sharedFields;
  const m: GenerateXlsxManualFields | null = run.manualFields;
  const c: GenerateXlsxCatalogPrefill | null = run.catalogPrefill;
  const r: ExtractedContractRow | undefined = run.rows[0];

  const out: Partial<Record<DisplayFieldKey, string>> = {};
  const set = (key: DisplayFieldKey, v: string | null | undefined) => {
    if (typeof v === "string" && v.trim() !== "") out[key] = v;
  };

  // Catalog (lista-proveedores) — columnas A, B, C, N del xlsx.
  set("tipo_actividad", c?.tipo_actividad);
  set("zona_turismo", c?.zona_turismo);
  set("proveedor", c?.proveedor_codigo);
  set("codigo_servicio", c?.codigo_servicio);

  // Shared (extraídos por la IA del contrato).
  set("razon_social", s.proveedor);
  set("cedula_juridica", s.cedula);
  set("contract_date", s.fecha);
  set("nombre_comercial", s.nombre_comercial);
  set("pais", s.pais);
  set("state_province", s.state_province);
  set("location", s.direccion);
  set("type_of_business", s.type_of_business);
  set("contract_starts", s.contract_starts);
  set("contract_ends", s.contract_ends);
  set("tipo_unidad", s.tipo_unidad);
  set("tipo_servicio", s.tipo_servicio);
  set("reservations_email", s.reservations_email);
  set("cuenta_bancaria_1", s.numero_cuenta);
  set("banco_1", s.banco);
  set("moneda_1", s.tipo_moneda);

  // Row (primera combinación product × season).
  if (r) {
    set("product_name", r.product_name);
    set("categoria", r.categoria);
    set("ocupacion", r.ocupacion);
    set("season_name", r.season_name);
    set("season_starts", r.season_starts);
    set("season_ends", r.season_ends);
    set("meals_included", r.meals_included);
    set("precios_neto_iva", r.precios_neto_iva);
    set("precio_rack_iva", r.precio_rack_iva);
    set("porcentaje_comision", r.porcentaje_comision);
    set("precios_neto_iva_fds", r.precios_neto_iva_fds);
    set("precio_rack_iva_fds", r.precio_rack_iva_fds);
    set("porcentaje_comision_fds", r.porcentaje_comision_fds);
    set("cancellation_policy", r.cancellation_policy);
    set("range_payment_policy", r.range_payment_policy);
    set("kids_policy", r.kids_policy);
    set("other_included", r.other_included);
    set("feeds_adicionales", r.feeds_adicionales);
  }

  // Manual (lo que el usuario llenó en step 2 que no extrae la IA).
  if (m) {
    set("tipo_tarifa_neta", m.tipo_tarifa_neta);
    set("tipo_tarifa_mayorista", m.tipo_tarifa_mayorista);
    set("tipo_tarifa_fds", m.tipo_tarifa_fds);
    set("t_tar_neta_fds", m.t_tar_neta_fds);
    set("tipo_tarifa_mayorista_fds", m.tipo_tarifa_mayorista_fds);
    set("others_payment_cancel", m.others_payment_cancel);
    set("cond_credito", m.cond_credito);
    set("plazo", m.plazo);
    set("cuenta_bancaria_2", m.cuenta_bancaria_2);
    set("banco_2", m.banco_2);
    set("moneda_2", m.moneda_2);
    set("cuenta_bancaria_3", m.cuenta_bancaria_3);
    set("banco_3", m.banco_3);
    set("moneda_3", m.moneda_3);
  }

  return out;
}

function toHistoryEntry(run: ContractRun): HistoryEntry {
  // `fileKind` viene del backend como ContractFileKind ("pdf"|"docx"|"xlsx"),
  // que coincide 1:1 con FileKind en este módulo. Cast explícito para que
  // TypeScript no infiera `string` aunque sean estructuralmente iguales.
  const kind: FileKind = run.fileKind as ContractFileKind;
  return {
    id: run.id,
    filename: run.filename,
    fileKind: kind,
    processedAt: run.processedAt,
    values: flattenContractRun(run),
  };
}

/**
 * Fetch + cache de los runs persistidos. Carga al montar y refresca cuando
 * la pestaña vuelve a foreground (escenario común: el usuario procesa un
 * contrato en otra ruta y luego vuelve a Historial). Estados:
 *   - loading inicial: `entries === null`, `error === null`
 *   - error:           `entries === null`, `error !== null`
 *   - listo:           `entries === HistoryEntry[]`, `error === null`
 */
function useContractRuns(): {
  entries: HistoryEntry[] | null;
  error: string | null;
  reload: () => void;
} {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { runs } = await api.supplierIntelligence.listRuns();
        if (cancelled) return;
        setEntries(runs.map(toHistoryEntry));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? err.message
            : "No pudimos cargar el historial. Intenta de nuevo en un momento.",
        );
      }
    })();

    const onVis = () => {
      if (document.visibilityState === "visible") {
        setReloadToken((t) => t + 1);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reloadToken]);

  return { entries, error, reload: () => setReloadToken((t) => t + 1) };
}

/* ----------------------------- Format helpers ----------------------------- */

function formatTimeOfDay(d: Date): string {
  return d.toLocaleTimeString("es-CR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatCalendarShort(d: Date): string {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return "Hoy";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Ayer";
  return d.toLocaleDateString("es-CR", { day: "numeric", month: "short" });
}

function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "Hace un momento";
  if (diffMin < 60) return `Hace ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `Hace ${diffHours} h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `Hace ${diffDays} día${diffDays === 1 ? "" : "s"}`;
  return d.toLocaleDateString("es-CR", { day: "numeric", month: "short" });
}

const HISTORY_FILE_ICONS: Record<FileKind, LucideIcon> = {
  pdf: FileText,
  docx: FileText,
  xlsx: FileSpreadsheet,
};

const FILE_KIND_TONES: Record<
  FileKind,
  { bg: string; border: string; text: string; label: string }
> = {
  pdf: {
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    text: "text-amber-300",
    label: "PDF",
  },
  docx: {
    bg: "bg-sky-500/10",
    border: "border-sky-500/30",
    text: "text-sky-300",
    label: "DOCX",
  },
  xlsx: {
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
    text: "text-emerald-300",
    label: "XLSX",
  },
};

/* --------------------------------- Filters -------------------------------- */

type FileFilter = "all" | FileKind;
type DateFilter = "all" | "today" | "week" | "month";

const FILE_FILTERS: { id: FileFilter; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "pdf", label: "PDF" },
  { id: "docx", label: "DOCX" },
  { id: "xlsx", label: "XLSX" },
];

const DATE_FILTERS: { id: DateFilter; label: string }[] = [
  { id: "all", label: "Todo" },
  { id: "today", label: "Hoy" },
  { id: "week", label: "7 días" },
  { id: "month", label: "30 días" },
];

function dateMatches(entry: HistoryEntry, filter: DateFilter): boolean {
  if (filter === "all") return true;
  const processed = new Date(entry.processedAt);
  const now = new Date();
  if (filter === "today") {
    return processed.toDateString() === now.toDateString();
  }
  const days = filter === "week" ? 7 : 30;
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return processed.getTime() >= cutoff;
}

/* -------------------------------- Components ------------------------------ */

/**
 * Tabular history view with search + status / file kind / date filters.
 * Default sort: most recent first. Clicking the row's "Ver detalles" button
 * opens the read-only 52-field modal.
 */
export function HistoryTable() {
  const { entries, error: loadError } = useContractRuns();
  const [active, setActive] = useState<HistoryEntry | null>(null);

  const [search, setSearch] = useState("");
  const [fileFilter, setFileFilter] = useState<FileFilter>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");

  const normSearch = search.trim().toLowerCase();
  // Trabajamos con `entries ?? []` para que el filtrado/sort no estalle
  // mientras estamos en estado loading. La UI de loading se renderiza
  // más abajo en el cuerpo de la tabla.
  const safeEntries = entries ?? [];
  const filtered = useMemo(() => {
    return safeEntries
      .filter((e) => {
        if (fileFilter !== "all" && e.fileKind !== fileFilter) return false;
        if (!dateMatches(e, dateFilter)) return false;
        if (normSearch) {
          const haystack = [
            e.values.razon_social ?? "",
            e.values.nombre_comercial ?? "",
            e.values.proveedor ?? "",
            e.filename,
          ]
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(normSearch)) return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          new Date(b.processedAt).getTime() -
          new Date(a.processedAt).getTime(),
      );
  }, [safeEntries, normSearch, fileFilter, dateFilter]);

  const filtersActive =
    fileFilter !== "all" || dateFilter !== "all" || normSearch !== "";

  const clearFilters = () => {
    setFileFilter("all");
    setDateFilter("all");
    setSearch("");
  };

  const isLoading = entries === null && loadError === null;

  return (
    <>
      <section className="relative overflow-hidden rounded-2xl border border-border bg-card/80 shadow-[0_1px_0_0_hsl(var(--primary)/0.08)_inset]">
        {/* Toolbar */}
        <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-border space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por proveedor o nombre de archivo…"
                aria-label="Buscar contrato"
                className="w-full h-10 pl-9 pr-3 rounded-md border border-border bg-secondary/40 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-primary/60 focus:bg-secondary/60 transition-colors"
              />
            </div>
            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center justify-center gap-1.5 h-10 px-3.5 rounded-md border border-border bg-secondary/40 text-[12.5px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
              >
                <X className="w-3.5 h-3.5" />
                Limpiar filtros
              </button>
            )}
          </div>

          <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:gap-4">
            <FilterGroup
              label="Tipo"
              options={FILE_FILTERS}
              value={fileFilter}
              onChange={setFileFilter}
            />
            <FilterGroup
              label="Fecha"
              options={DATE_FILTERS}
              value={dateFilter}
              onChange={setDateFilter}
            />
          </div>
        </div>

        {/* Results meta */}
        <div className="px-5 sm:px-6 py-2.5 border-b border-border/60 bg-secondary/10 flex items-center justify-between">
          <p className="text-[12px] text-muted-foreground">
            {isLoading
              ? "Cargando…"
              : loadError
                ? "Error al cargar"
                : filtered.length === safeEntries.length
                  ? `${safeEntries.length} contrato${safeEntries.length === 1 ? "" : "s"}`
                  : `${filtered.length} de ${safeEntries.length} contratos`}
          </p>
          <p className="text-[11.5px] text-muted-foreground/80">
            Ordenado por más reciente
          </p>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="px-5 sm:px-8 py-14 text-center">
            <Loader2
              className="mx-auto h-6 w-6 text-muted-foreground/70 animate-spin"
              aria-hidden
            />
            <p className="mt-3 text-[13px] text-muted-foreground">
              Cargando historial…
            </p>
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className="px-5 sm:px-8 py-14 text-center"
          >
            <AlertCircle
              className="mx-auto h-6 w-6 text-rose-300"
              aria-hidden
            />
            <p className="mt-3 text-[13.5px] text-foreground">{loadError}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 sm:px-8 py-14 text-center">
            <p className="text-[14px] text-muted-foreground">
              {safeEntries.length === 0
                ? "Aún no hay contratos procesados. Procesa uno desde el agente para verlo aquí."
                : "Ningún contrato coincide con los filtros actuales."}
            </p>
            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="mt-3 inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-md border border-border bg-secondary/40 text-[12.5px] font-medium text-foreground hover:bg-secondary transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                Limpiar filtros
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border/60 bg-secondary/20">
                  <Th>Proveedor</Th>
                  <Th className="hidden md:table-cell">Archivo</Th>
                  <Th className="w-[180px]">Procesado</Th>
                  <Th className="w-[140px] text-right">Acciones</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {filtered.map((entry) => (
                  <HistoryTableRow
                    key={entry.id}
                    entry={entry}
                    onOpen={() => setActive(entry)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {active && (
        <HistoryDetailModal entry={active} onClose={() => setActive(null)} />
      )}
    </>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-4 sm:px-5 py-2.5 text-[11px] uppercase tracking-wider font-semibold text-muted-foreground ${className}`}
    >
      {children}
    </th>
  );
}

function FilterGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground/80 shrink-0">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map((opt) => {
          const active = value === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onChange(opt.id)}
              aria-pressed={active}
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-[12px] font-medium border transition-colors ${
                active
                  ? "bg-primary text-primary-foreground border-primary shadow-[0_0_10px_0_hsl(var(--primary)/0.35)]"
                  : "bg-secondary/40 text-muted-foreground border-border hover:text-foreground hover:bg-secondary/70"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function HistoryTableRow({
  entry,
  onOpen,
}: {
  entry: HistoryEntry;
  onOpen: () => void;
}) {
  const FileKindIcon = HISTORY_FILE_ICONS[entry.fileKind];
  const tone = FILE_KIND_TONES[entry.fileKind];
  const supplier =
    entry.values.razon_social ??
    entry.values.nombre_comercial ??
    "Proveedor sin nombre";
  const subtitle = entry.values.nombre_comercial ?? entry.values.proveedor;
  const processedDate = new Date(entry.processedAt);

  return (
    <tr className="hover:bg-secondary/20 transition-colors">
      <td className="px-4 sm:px-5 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`w-9 h-9 rounded-lg ${tone.bg} ${tone.border} ${tone.text} border flex items-center justify-center shrink-0`}
          >
            <FileKindIcon className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-foreground truncate">
              {supplier}
            </p>
            {subtitle && subtitle !== supplier && (
              <p className="text-[11.5px] text-muted-foreground truncate">
                {subtitle}
              </p>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 sm:px-5 py-3 hidden md:table-cell">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded border ${tone.bg} ${tone.border} ${tone.text} text-[10.5px] font-semibold tracking-wider shrink-0`}
          >
            {tone.label}
          </span>
          <span className="text-[12.5px] text-muted-foreground truncate">
            {entry.filename}
          </span>
        </div>
      </td>
      <td className="px-4 sm:px-5 py-3 text-[12.5px] text-muted-foreground">
        <div className="flex flex-col">
          <span className="text-foreground/90 tabular-nums">
            {formatCalendarShort(processedDate)}{" "}
            {formatTimeOfDay(processedDate)}
          </span>
          <span className="text-[11px] text-muted-foreground/80">
            {formatRelative(processedDate)}
          </span>
        </div>
      </td>
      <td className="px-4 sm:px-5 py-3 text-right">
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border border-border bg-secondary/40 text-[12px] font-medium text-foreground hover:border-primary/40 hover:bg-primary/10 hover:text-primary transition-colors"
        >
          <Eye className="w-3.5 h-3.5" />
          Ver detalles
        </button>
      </td>
    </tr>
  );
}

/**
 * Read-only modal showing all 52 fields of a processed contract. The body
 * walks the same `SECTIONS` schema used by Step 2 so the layout is familiar.
 * Fields without a value render as muted "vacío" placeholders.
 *
 * Closes on Esc, click on the backdrop, or the X button. We `e.stopPropagation`
 * on the modal card so clicking inside doesn't bubble to the backdrop close.
 */
function HistoryDetailModal({
  entry,
  onClose,
}: {
  entry: HistoryEntry;
  onClose: () => void;
}) {
  // Esc-to-close + body scroll lock while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const supplier =
    entry.values.razon_social ??
    entry.values.nombre_comercial ??
    "Proveedor sin nombre";
  const processedDate = new Date(entry.processedAt);
  const filledCount = ALL_FIELDS.filter((f) => {
    const v = entry.values[f.key];
    return typeof v === "string" && v.trim() !== "";
  }).length;
  const tone = FILE_KIND_TONES[entry.fileKind];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-detail-title"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-sm animate-page-enter"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        {/* Sticky header */}
        <header className="flex items-start gap-3 px-5 sm:px-7 py-4 border-b border-border bg-card/95 backdrop-blur-sm">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center shrink-0">
            <FileText className="w-4.5 h-4.5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h3
              id="history-detail-title"
              className="text-[16px] font-semibold text-foreground truncate"
            >
              {supplier}
            </h3>
            <div className="mt-1 flex items-center flex-wrap gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded border ${tone.bg} ${tone.border} ${tone.text} text-[10px] font-semibold tracking-wider`}
              >
                {tone.label}
              </span>
              <span className="truncate max-w-[260px]">{entry.filename}</span>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatCalendarShort(processedDate)}{" "}
                {formatTimeOfDay(processedDate)}
              </span>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <span>{formatRelative(processedDate)}</span>
            </div>
            <div className="mt-2 flex items-center flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-[10.5px] font-semibold uppercase tracking-wider text-emerald-300">
                <CheckCircle2 className="w-3 h-3" />
                {filledCount}/{ALL_FIELDS.length} con valor
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar detalles"
            className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-border bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Scrollable body — read-only sections in single column */}
        <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-5 space-y-3">
          {SECTIONS.map((section) => (
            <ReadOnlySectionCard
              key={section.id}
              section={section}
              values={entry.values}
            />
          ))}
        </div>

        <footer className="px-5 sm:px-7 py-3 border-t border-border bg-card/95 backdrop-blur-sm flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-md border border-border bg-secondary/40 text-[12.5px] font-medium text-foreground hover:bg-secondary transition-colors"
          >
            Cerrar
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Read-only mirror of `SectionCard` from workflow.tsx, used inside the
 * history detail modal. Same accent colors / completion pill, but the body
 * is a plain stack of label/value rows without any pencils.
 */
function ReadOnlySectionCard({
  section,
  values,
}: {
  section: SectionDef;
  values: Partial<Record<DisplayFieldKey, string>>;
}) {
  const accent = section.accent;
  const SectionIcon = section.icon;
  const filled = section.fields.filter((f) => {
    const v = values[f.key];
    return typeof v === "string" && v.trim() !== "";
  }).length;
  const total = section.fields.length;

  return (
    <section
      className={`rounded-xl border bg-card/60 overflow-hidden ${accent.ring}`}
    >
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border/60">
        <div
          className={`w-9 h-9 rounded-lg ${accent.iconBg} ${accent.ring} border flex items-center justify-center shrink-0`}
        >
          <SectionIcon className={`w-4 h-4 ${accent.iconText}`} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-semibold text-foreground truncate">
            {section.title}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold tabular-nums shrink-0 ${accent.pillBg} ${accent.pillBorder} ${accent.pillText}`}
        >
          {filled}/{total}
        </span>
      </header>
      <ul className="divide-y divide-border/50">
        {section.fields.map((f) => {
          const raw = values[f.key];
          const v = typeof raw === "string" ? raw : null;
          const empty = v === null || v === "";
          const FieldIcon = f.icon;
          return (
            <li key={f.key} className="px-4 py-3">
              <div className="flex items-center gap-2 text-muted-foreground min-w-0">
                <FieldIcon className="w-3.5 h-3.5 shrink-0" />
                <p className="text-[11.5px] uppercase tracking-wider font-semibold truncate">
                  {f.label}
                </p>
              </div>
              <p
                className={`mt-1 text-[14.5px] leading-relaxed break-words ${
                  empty ? "text-muted-foreground/60 italic" : "text-foreground"
                }`}
              >
                {empty ? "Vacío" : v}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
