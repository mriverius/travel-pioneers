"use client";

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  FileSpreadsheet,
  FileText,
  ImageIcon,
  Loader2,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ALL_COLUMNS,
  COLS_NEEDING_REVIEW,
  formatCellDisplay,
  type ColumnDef,
  type FileKind,
} from "./workflow";
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
 * One processed-contract record. Holds the raw structured payload from the
 * backend (sharedFields + catalog + manual + rows) plus a couple of derived
 * convenience fields used by the table row and search. The detail modal
 * walks the same `ALL_COLUMNS` schema as Step 2 and reads values directly
 * out of these buckets — no flattening, so multi-row contracts render with
 * one table row per `rows[i]` exactly like the editable Step 2 table.
 */
export interface HistoryEntry {
  id: string;
  filename: string;
  fileKind: FileKind;
  /** ISO timestamp of when the contract finished processing. */
  processedAt: string;

  // Derived display/search-friendly fields (computed once at fetch time).
  /** Razón social — `sharedFields.proveedor`. */
  supplierName: string | null;
  /** Nombre comercial — typically the brand the customer recognizes. */
  commercialName: string | null;
  /** Código de proveedor del maestro — `catalogPrefill.proveedor_codigo`. */
  supplierCode: string | null;

  // Raw payload — the modal renders the 52-col table directly off these.
  sharedFields: ExtractedSharedFields;
  catalogPrefill: GenerateXlsxCatalogPrefill | null;
  manualFields: GenerateXlsxManualFields | null;
  rows: ExtractedContractRow[];

  /**
   * Telemetría del run (Anthropic usage + costo estimado en USD).
   * Null en runs anteriores a la feature de tracking de tokens.
   */
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

/* ---------------------------------- Data ---------------------------------- */

function toHistoryEntry(run: ContractRun): HistoryEntry {
  // `fileKind` viene del backend como ContractFileKind
  // ("pdf"|"docx"|"xlsx"|"image"), que coincide 1:1 con FileKind en este
  // módulo. Cast explícito para que TypeScript no infiera `string` aunque
  // sean estructuralmente iguales.
  const kind: FileKind = run.fileKind as ContractFileKind;
  return {
    id: run.id,
    filename: run.filename,
    fileKind: kind,
    processedAt: run.processedAt,
    supplierName: run.sharedFields.proveedor ?? null,
    commercialName: run.sharedFields.nombre_comercial ?? null,
    supplierCode: run.catalogPrefill?.proveedor_codigo ?? null,
    sharedFields: run.sharedFields,
    catalogPrefill: run.catalogPrefill,
    manualFields: run.manualFields,
    rows: run.rows,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costUsd: run.costUsd,
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

/**
 * Compactá un conteo de tokens para mostrar en chips/badges:
 *   123       → "123"
 *   3_456     → "3.5K"
 *   42_318    → "42.3K"
 *   1_234_567 → "1.2M"
 * Anthropic devuelve usage como enteros; mantenemos 1 decimal en K/M para
 * que cifras intermedias (típicas en nuestro flujo, 1K-100K) sigan
 * legibles sin agrandar el chip.
 */
function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Costo en USD con 2-4 decimales según magnitud:
 *   < $0.01 → 4 decimales (ej. "$0.0042")
 *   ≥ $0.01 → 2 decimales (ej. "$1.23")
 * Por debajo del centavo no es señal: queremos ver si fue $0.001 o $0.008
 * para no confundir "casi gratis" con "0".
 */
function formatCostUsd(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
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
  image: ImageIcon,
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
  image: {
    bg: "bg-violet-500/10",
    border: "border-violet-500/30",
    text: "text-violet-300",
    label: "IMG",
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
  { id: "image", label: "IMG" },
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
            e.supplierName ?? "",
            e.commercialName ?? "",
            e.supplierCode ?? "",
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
    entry.supplierName ?? entry.commercialName ?? "Proveedor sin nombre";
  // El subtítulo prefiere "nombre comercial" cuando ya tenemos razón social
  // arriba; en su defecto usa el código del maestro para que la fila siga
  // teniendo dos líneas de identidad.
  const subtitle =
    entry.supplierName && entry.commercialName
      ? entry.commercialName
      : entry.supplierCode;
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
 * Lee el valor read-only para una columna `col` en la fila `rowIdx` del
 * contrato. Centraliza la dispatch por scope (shared/row + ai/catalog/manual)
 * para que el render de celdas sea un look-up trivial.
 *
 * - shared+ai     → `sharedFields[col.key]`
 * - shared+catalog→ `catalogPrefill[col.key]` (puede ser null si no hubo match)
 * - shared+manual → `manualFields[col.key]` (puede ser null si el usuario no llenó nada)
 * - row           → `rows[rowIdx][col.key]`
 *
 * Devolvemos `null` cuando el campo no existe / está vacío para que la celda
 * pinte un "—" mudo (placeholder consistente con celdas no-completadas).
 */
function readCellValue(
  col: ColumnDef,
  rowIdx: number,
  entry: HistoryEntry,
): string | null {
  if (col.scope.kind === "row") {
    const row = entry.rows[rowIdx];
    if (!row) return null;
    const raw = (row as unknown as Record<string, string | null>)[col.key];
    return typeof raw === "string" && raw.trim() !== "" ? raw : null;
  }
  // shared
  let bag: Record<string, string | null> | null = null;
  if (col.scope.source === "ai") {
    bag = entry.sharedFields as unknown as Record<string, string | null>;
  } else if (col.scope.source === "catalog") {
    bag = entry.catalogPrefill
      ? (entry.catalogPrefill as unknown as Record<string, string | null>)
      : null;
  } else if (col.scope.source === "manual") {
    bag = entry.manualFields
      ? (entry.manualFields as unknown as Record<string, string | null>)
      : null;
  }
  const raw = bag ? bag[col.key] : null;
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

/**
 * Read-only modal showing the contract's data using **the same flat 52-col
 * table as Step 2**. Renders N table rows (one per `entry.rows[i]`) so
 * multi-product · multi-season contracts show every combination, not just
 * the first one.
 *
 * The cell display reuses `formatCellDisplay` from `workflow.tsx`, so dates
 * appear as mm/dd/yyyy and `currency` columns get the dynamic currency code
 * (`sharedFields.tipo_moneda`) — identical formatting to Step 2.
 *
 * Closes on Esc, backdrop click, or the X button.
 */
function HistoryDetailModal({
  entry,
  onClose,
}: {
  entry: HistoryEntry;
  onClose: () => void;
}) {
  // El modal se renderiza vía portal a document.body para escapar el
  // contenedor `.animate-page-enter` del PortalLayout — esa clase tiene
  // `will-change: transform`, que en CSS crea un containing block para
  // posiciones `fixed`. Sin el portal, `fixed inset-0` cubría solo el área
  // principal a la derecha del sidebar en lugar del viewport completo, y
  // el modal se veía descentrado / cortado.
  //
  // `mounted` evita un mismatch de hydration: en SSR `document` no existe,
  // así que en el primer render devolvemos null y solo creamos el portal
  // después del mount del cliente.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

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

  if (!mounted) return null;

  const supplier =
    entry.supplierName ?? entry.commercialName ?? "Proveedor sin nombre";
  const processedDate = new Date(entry.processedAt);
  const tone = FILE_KIND_TONES[entry.fileKind];
  const tipoMoneda = entry.sharedFields.tipo_moneda ?? null;
  // Garantizamos al menos una fila para que la tabla nunca quede vacía
  // (sería raro pero defensivo): un contrato persistido siempre tiene ≥1.
  const rowCount = Math.max(entry.rows.length, 1);

  // Telemetría: input/output por separado + costo. Runs persistidos
  // antes de la feature de tracking traen null en estos campos — los
  // ocultamos en ese caso para no mostrar "0 tokens · $0" engañoso.
  // Mostramos input y output como números independientes (no totalizamos)
  // porque tienen tarifas distintas con Anthropic ($5/M input vs $25/M
  // output) y separarlos hace visible dónde se va el costo.
  const hasUsage =
    entry.inputTokens !== null &&
    entry.outputTokens !== null &&
    entry.costUsd !== null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-detail-title"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // El ancho ahora va a 96vw para que la tabla de 52 columnas tenga
        // espacio real; el overflow horizontal interno se encarga del scroll.
        className="relative w-full max-w-[96vw] max-h-[92vh] flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
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
                {rowCount} {rowCount === 1 ? "fila" : "filas"} · 52 columnas
              </span>
              {hasUsage && (
                <>
                  {/*
                    Tres chips chicos, uno por dimensión — input, output y
                    costo. Más compacto que párrafos pero deja en claro
                    cuántos tokens se gastaron en cada lado y qué costó.
                    El tooltip muestra el conteo exacto (sin abreviación
                    K/M) por si alguien quiere copiarlo a un dashboard.
                  */}
                  <span
                    title={`Input: ${entry.inputTokens!.toLocaleString("es-CR")} tokens`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-[10.5px] font-semibold uppercase tracking-wider text-indigo-300"
                  >
                    <span className="text-indigo-400/70">Input</span>
                    <span className="tabular-nums">
                      {formatTokenCount(entry.inputTokens!)}
                    </span>
                  </span>
                  <span
                    title={`Output: ${entry.outputTokens!.toLocaleString("es-CR")} tokens`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-[10.5px] font-semibold uppercase tracking-wider text-indigo-300"
                  >
                    <span className="text-indigo-400/70">Output</span>
                    <span className="tabular-nums">
                      {formatTokenCount(entry.outputTokens!)}
                    </span>
                  </span>
                  <span
                    title={`Costo aproximado (Opus 4.6: $5/M input + $25/M output)`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-[10.5px] font-semibold uppercase tracking-wider text-amber-300"
                  >
                    <span className="text-amber-400/70">Costo</span>
                    <span className="tabular-nums">
                      {formatCostUsd(entry.costUsd!)}
                    </span>
                  </span>
                </>
              )}
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

        {/* Read-only flat table — mirrors workflow.tsx FullTable structure. */}
        <div className="flex-1 overflow-auto">
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
                            title="Campo del catálogo lista-proveedores — revisar."
                            className="text-amber-300 shrink-0"
                          >
                            <AlertTriangle className="w-3 h-3" />
                          </span>
                        )}
                      </div>
                    </th>
                  );
                })}
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
              {Array.from({ length: rowCount }, (_, rowIdx) => (
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
                    const raw = readCellValue(col, rowIdx, entry);
                    const display = raw
                      ? formatCellDisplay(col, raw, tipoMoneda)
                      : null;
                    return (
                      <td
                        key={col.excelCol}
                        className={`px-2 py-1.5 align-top border-r border-border/30 ${
                          isShared ? "bg-secondary/15" : ""
                        }`}
                        style={{ minWidth: col.minWidth }}
                      >
                        {display ? (
                          <span
                            className={`text-[12px] text-foreground ${
                              col.multiline
                                ? "whitespace-pre-wrap break-words"
                                : "whitespace-nowrap"
                            }`}
                          >
                            {display}
                          </span>
                        ) : (
                          <span
                            className="text-[12px] text-muted-foreground/50"
                            aria-label="Vacío"
                          >
                            —
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
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
    </div>,
    document.body,
  );
}
