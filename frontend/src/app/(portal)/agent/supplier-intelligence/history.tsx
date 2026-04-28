"use client";

import {
  Check,
  CheckCircle2,
  Clock,
  Eye,
  FileSpreadsheet,
  FileText,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  ALL_FIELDS,
  SECTIONS,
  type DisplayFieldKey,
  type FileKind,
  type SectionDef,
} from "./workflow";

/* ---------------------------------- Types --------------------------------- */

/**
 * One processed-contract record. `values` carries the same display-field
 * schema as Step 2 so the detail modal can render exactly the same field
 * structure without conversion.
 *
 * Today this is fed by a mock generator below — the real source will be a
 * `GET /api/supplier-intelligence/history` endpoint when it lands.
 */
export interface HistoryEntry {
  id: string;
  filename: string;
  fileKind: FileKind;
  /** ISO timestamp of when the contract finished processing. */
  processedAt: string;
  /** Whether the user already approved the entry into the cloud xlsx. */
  syncedToMaestro: boolean;
  /**
   * Sparse value map keyed by display field. Anything missing is treated as
   * `null` ("vacío") in the detail modal — same convention as Step 2.
   */
  values: Partial<Record<DisplayFieldKey, string>>;
}

/* ---------------------------------- Data ---------------------------------- */

/**
 * Fake history seed. `processedAt` is computed at mount time as an offset
 * from `Date.now()` (see `useFakeHistory`) so the relative-time labels stay
 * correct regardless of when the page is opened.
 */
const FAKE_HISTORY_SEED: (Omit<HistoryEntry, "processedAt"> & {
  /** Minutes ago, used to compute `processedAt` against `Date.now()`. */
  minutesAgo: number;
})[] = [
  {
    id: "h-001",
    filename: "contrato_tortuga_lodge_2026.pdf",
    fileKind: "pdf",
    minutesAgo: 23,
    syncedToMaestro: true,
    values: {
      tipo_actividad: "Hospedaje",
      zona_turismo: "Caribe Norte",
      proveedor: "TORTUGA-001",
      razon_social: "Hotel Tortuga Lodge S.A.",
      cedula_juridica: "3-101-022456",
      contract_date: "2026-01-15",
      nombre_comercial: "Tortuga Lodge & Gardens",
      pais: "Costa Rica",
      state_province: "Limón",
      location: "Tortuguero, sector Pacuare, frente al canal principal",
      type_of_business: "Eco Lodge · Hotel boutique",
      contract_starts: "2026-02-01",
      contract_ends: "2027-01-31",
      codigo_servicio: "TORT-HAB-STD",
      product_name: "Habitación Standard Vista Canal",
      tipo_unidad: "Habitación · 2 personas",
      tipo_servicio: "Alojamiento con desayuno",
      categoria: "4 estrellas",
      ocupacion: "Doble · 2 adultos",
      season_name: "Alta",
      season_starts: "2026-12-15",
      season_ends: "2027-04-30",
      meals_included: "Desayuno tipo buffet",
      tipo_tarifa_neta: "Por habitación / por noche",
      precios_neto_iva: "USD 165.00",
      precio_rack_iva: "USD 245.00",
      tipo_tarifa_mayorista: "Wholesale FIT",
      porcentaje_comision: "20%",
      tipo_tarifa_fds: "Weekend rate",
      t_tar_neta_fds: "Por habitación / por noche",
      precios_neto_iva_fds: "USD 195.00",
      precio_rack_iva_fds: "USD 285.00",
      tipo_tarifa_mayorista_fds: "Wholesale FIT FdS",
      porcentaje_comision_fds: "18%",
      cancellation_policy:
        "Cancelación gratuita hasta 30 días antes. Después: 50% del valor total.",
      range_payment_policy: "50% al confirmar, 50% 15 días antes del check-in",
      kids_policy: "Niños 0-5 gratis. 6-11 al 50%. 12+ tarifa adulto.",
      other_included: "WiFi, parking, traslados desde el muelle",
      reservations_email: "reservas@tortugalodge.cr",
      cond_credito: "30 días neto",
      plazo: "30 días",
      cuenta_bancaria_1: "CR05 0152 0001 0260 1234 56",
      banco_1: "BAC Credomatic",
      moneda_1: "USD",
      cuenta_bancaria_2: "CR21 0152 0001 0260 7890 12",
      banco_2: "BAC Credomatic",
      moneda_2: "CRC",
    },
  },
  {
    id: "h-002",
    filename: "tarifario_aguas_bravas_q2.xlsx",
    fileKind: "xlsx",
    minutesAgo: 165, // ~2.75h
    syncedToMaestro: true,
    values: {
      tipo_actividad: "Tour de aventura",
      zona_turismo: "Pacífico Central",
      proveedor: "AGUASBR-014",
      razon_social: "Aguas Bravas Rafting S.A.",
      cedula_juridica: "3-101-447781",
      contract_date: "2026-03-04",
      nombre_comercial: "Aguas Bravas",
      pais: "Costa Rica",
      state_province: "Alajuela",
      location: "La Virgen de Sarapiquí, costado este de la plaza",
      type_of_business: "Operador de tours",
      contract_starts: "2026-04-01",
      contract_ends: "2027-03-31",
      codigo_servicio: "AB-RAFT-CL3",
      product_name: "Rafting Río Sarapiquí · Clase III",
      tipo_unidad: "Tour por persona",
      tipo_servicio: "Aventura · Rafting",
      categoria: "Estándar",
      ocupacion: "Mínimo 4 personas",
      season_name: "Toda temporada",
      meals_included: "Almuerzo típico tras el tour",
      tipo_tarifa_neta: "Por persona",
      precios_neto_iva: "USD 79.00",
      precio_rack_iva: "USD 105.00",
      tipo_tarifa_mayorista: "Net rate",
      porcentaje_comision: "15%",
      cancellation_policy:
        "Cancelación 48h antes sin costo. Menos de 48h: 100%.",
      range_payment_policy: "Pago 7 días antes del tour",
      kids_policy: "Edad mínima 12 años por seguridad",
      other_included: "Equipo de seguridad, guía bilingüe, transporte local",
      reservations_email: "reservas@aguasbravascr.com",
      cond_credito: "Contado",
      plazo: "Inmediato",
      cuenta_bancaria_1: "CR81 0151 0010 0245 6678 90",
      banco_1: "Banco Nacional",
      moneda_1: "USD",
    },
  },
  {
    id: "h-003",
    filename: "contrato_arenal_volcano_hotel.docx",
    fileKind: "docx",
    minutesAgo: 60 * 26, // hace 26h (= ayer)
    syncedToMaestro: true,
    values: {
      tipo_actividad: "Hospedaje",
      zona_turismo: "Volcán Arenal",
      proveedor: "ARENAL-007",
      razon_social: "Arenal Volcano Resort S.A.",
      cedula_juridica: "3-101-098765",
      contract_date: "2026-02-22",
      nombre_comercial: "Arenal Volcano Hotel & Spa",
      pais: "Costa Rica",
      state_province: "Alajuela",
      location: "La Fortuna, ruta 142 km 8",
      type_of_business: "Hotel resort · Spa",
      contract_starts: "2026-03-01",
      contract_ends: "2027-02-28",
      codigo_servicio: "AVH-JR-SUITE",
      product_name: "Junior Suite con vista al volcán",
      tipo_unidad: "Habitación · 2 adultos",
      tipo_servicio: "Alojamiento + spa",
      categoria: "4 estrellas",
      ocupacion: "Doble · 2 adultos",
      season_name: "Alta",
      season_starts: "2026-12-20",
      season_ends: "2027-04-15",
      meals_included: "Desayuno · Cena tipo buffet",
      tipo_tarifa_neta: "Por habitación / por noche",
      precios_neto_iva: "USD 220.00",
      precio_rack_iva: "USD 330.00",
      tipo_tarifa_mayorista: "Wholesale FIT",
      porcentaje_comision: "22%",
      tipo_tarifa_fds: "Weekend premium",
      t_tar_neta_fds: "Por habitación / por noche",
      precios_neto_iva_fds: "USD 260.00",
      precio_rack_iva_fds: "USD 390.00",
      porcentaje_comision_fds: "20%",
      cancellation_policy:
        "Cancelación gratuita hasta 21 días antes. Luego: 1ra noche.",
      range_payment_policy: "30% al confirmar, saldo 14 días antes",
      kids_policy: "Niños 0-3 gratis. 4-11 al 40%. 12+ tarifa adulto.",
      other_included: "Acceso a aguas termales, WiFi, gimnasio",
      feeds_adicionales: "Tour spa con cargo extra",
      reservations_email: "reservas@arenalvolcano.cr",
      cond_credito: "30 días neto",
      plazo: "30 días",
      cuenta_bancaria_1: "CR67 0152 0001 0260 4455 66",
      banco_1: "BAC Credomatic",
      moneda_1: "USD",
      cuenta_bancaria_2: "CR43 0151 0010 0245 1122 33",
      banco_2: "Banco Nacional",
      moneda_2: "CRC",
    },
  },
  {
    id: "h-004",
    filename: "pacific_surf_tarifas_2026.pdf",
    fileKind: "pdf",
    minutesAgo: 60 * 24 * 4 + 35, // ~4 días
    syncedToMaestro: false,
    values: {
      tipo_actividad: "Tour · Surf",
      zona_turismo: "Pacífico Norte",
      proveedor: "PACSURF-022",
      razon_social: "Pacific Coast Surf Inc.",
      contract_date: "2026-04-10",
      nombre_comercial: "Pacific Surf School",
      pais: "Costa Rica",
      state_province: "Guanacaste",
      location: "Tamarindo, frente a la entrada principal de la playa",
      type_of_business: "Escuela de surf",
      contract_starts: "2026-05-01",
      contract_ends: "2027-04-30",
      codigo_servicio: "PS-LECC-GROUP",
      product_name: "Lección grupal de surf · 2 horas",
      tipo_unidad: "Tour por persona",
      tipo_servicio: "Aventura · Surf",
      ocupacion: "Mínimo 2 personas",
      season_name: "Toda temporada",
      tipo_tarifa_neta: "Por persona",
      precios_neto_iva: "USD 55.00",
      precio_rack_iva: "USD 75.00",
      porcentaje_comision: "15%",
      cancellation_policy: "24h antes sin costo, después 100%",
      reservations_email: "info@pacificsurfcr.com",
      cond_credito: "Contado",
      plazo: "Inmediato",
      cuenta_bancaria_1: "CR12 0151 0010 0245 7788 99",
      banco_1: "Banco Nacional",
      moneda_1: "USD",
    },
  },
  {
    id: "h-005",
    filename: "contrato_punta_islita_2026.xlsx",
    fileKind: "xlsx",
    minutesAgo: 60 * 24 * 12 + 200, // ~12 días
    syncedToMaestro: false,
    values: {
      tipo_actividad: "Hospedaje",
      zona_turismo: "Pacífico Norte",
      proveedor: "ISLITA-018",
      razon_social: "Hotel Punta Islita S.A.",
      cedula_juridica: "3-101-339977",
      contract_date: "2026-03-30",
      nombre_comercial: "Hotel Punta Islita",
      pais: "Costa Rica",
      state_province: "Guanacaste",
      location: "Punta Islita, Nandayure",
      type_of_business: "Boutique resort",
      contract_starts: "2026-05-01",
      contract_ends: "2027-04-30",
      codigo_servicio: "ISL-CASITA-OF",
      product_name: "Casita Ocean Front",
      tipo_unidad: "Casita · 2 adultos",
      categoria: "5 estrellas",
      season_name: "Alta",
      tipo_tarifa_neta: "Por habitación / por noche",
      precios_neto_iva: "USD 380.00",
      precio_rack_iva: "USD 540.00",
      porcentaje_comision: "20%",
      cancellation_policy: "Cancelación 14 días antes sin costo",
      reservations_email: "reservas@hotelpuntaislita.com",
      cond_credito: "Contado",
      cuenta_bancaria_1: "CR45 0152 0001 0260 8899 00",
      banco_1: "BAC Credomatic",
      moneda_1: "USD",
    },
  },
  {
    id: "h-006",
    filename: "costa_rica_sun_tours_2026.docx",
    fileKind: "docx",
    minutesAgo: 60 * 24 * 21 + 480, // ~21 días
    syncedToMaestro: true,
    values: {
      tipo_actividad: "Tour · City",
      zona_turismo: "Valle Central",
      proveedor: "CRSUN-009",
      razon_social: "Costa Rica Sun Tours S.A.",
      cedula_juridica: "3-101-552233",
      contract_date: "2026-03-12",
      nombre_comercial: "Costa Rica Sun Tours",
      pais: "Costa Rica",
      state_province: "San José",
      location: "Sabana Norte, edificio Plaza Roble, oficina 304",
      type_of_business: "Operador receptivo",
      contract_starts: "2026-04-01",
      contract_ends: "2027-03-31",
      codigo_servicio: "CRS-SJO-CITY",
      product_name: "Tour San José histórico · medio día",
      tipo_unidad: "Tour por persona",
      tipo_servicio: "Cultural · City tour",
      ocupacion: "Mínimo 3 personas",
      season_name: "Toda temporada",
      tipo_tarifa_neta: "Por persona",
      precios_neto_iva: "USD 45.00",
      precio_rack_iva: "USD 65.00",
      tipo_tarifa_mayorista: "Net rate",
      porcentaje_comision: "18%",
      cancellation_policy: "24h antes sin costo",
      range_payment_policy: "Pago al final del tour",
      reservations_email: "ops@crsuntours.cr",
      cond_credito: "30 días neto",
      plazo: "30 días",
      cuenta_bancaria_1: "CR98 0151 0010 0245 4400 11",
      banco_1: "Banco Nacional",
      moneda_1: "USD",
    },
  },
  {
    id: "h-007",
    filename: "manuel_antonio_resort_v3.pdf",
    fileKind: "pdf",
    minutesAgo: 60 * 24 * 36 + 90, // ~36 días (mes anterior)
    syncedToMaestro: true,
    values: {
      tipo_actividad: "Hospedaje",
      zona_turismo: "Pacífico Central",
      proveedor: "MANTONIO-003",
      razon_social: "Manuel Antonio Resort S.A.",
      cedula_juridica: "3-101-771122",
      contract_date: "2026-01-20",
      nombre_comercial: "Manuel Antonio Resort & Spa",
      pais: "Costa Rica",
      state_province: "Puntarenas",
      location: "Quepos, ruta del Parque Nacional Manuel Antonio",
      type_of_business: "Resort · Spa",
      contract_starts: "2026-02-15",
      contract_ends: "2027-02-14",
      codigo_servicio: "MA-DELUXE-OV",
      product_name: "Deluxe Ocean View Suite",
      tipo_unidad: "Suite · 2 adultos",
      categoria: "4 estrellas",
      season_name: "Alta",
      tipo_tarifa_neta: "Por habitación / por noche",
      precios_neto_iva: "USD 198.00",
      precio_rack_iva: "USD 280.00",
      porcentaje_comision: "20%",
      cancellation_policy: "Cancelación 21 días antes sin costo",
      reservations_email: "reservas@manuelantonioresort.com",
      cond_credito: "30 días neto",
      cuenta_bancaria_1: "CR33 0152 0001 0260 6677 88",
      banco_1: "BAC Credomatic",
      moneda_1: "USD",
    },
  },
];

/**
 * Returns the seed list with `processedAt` materialized against the current
 * clock. We use `useState`'s lazy initializer (which is permitted to be
 * impure — it runs once on mount) rather than `useMemo` (which the
 * react-hooks/purity rule expects to be pure). Effect: timestamps are
 * stamped once at first mount and stay stable while the page is open, then
 * re-stamped fresh next time the user navigates back.
 */
export function useFakeHistory(): HistoryEntry[] {
  const [entries] = useState<HistoryEntry[]>(() => {
    const now = Date.now();
    return FAKE_HISTORY_SEED.map(({ minutesAgo, ...rest }) => ({
      ...rest,
      processedAt: new Date(now - minutesAgo * 60_000).toISOString(),
    }));
  });
  return entries;
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

type StatusFilter = "all" | "synced" | "pending";
type FileFilter = "all" | FileKind;
type DateFilter = "all" | "today" | "week" | "month";

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "synced", label: "Sincronizados" },
  { id: "pending", label: "Pendientes" },
];

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
  const entries = useFakeHistory();
  const [active, setActive] = useState<HistoryEntry | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [fileFilter, setFileFilter] = useState<FileFilter>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");

  const normSearch = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    return entries
      .filter((e) => {
        if (statusFilter === "synced" && !e.syncedToMaestro) return false;
        if (statusFilter === "pending" && e.syncedToMaestro) return false;
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
  }, [entries, normSearch, statusFilter, fileFilter, dateFilter]);

  const filtersActive =
    statusFilter !== "all" ||
    fileFilter !== "all" ||
    dateFilter !== "all" ||
    normSearch !== "";

  const clearFilters = () => {
    setStatusFilter("all");
    setFileFilter("all");
    setDateFilter("all");
    setSearch("");
  };

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
              label="Estado"
              options={STATUS_FILTERS}
              value={statusFilter}
              onChange={setStatusFilter}
            />
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
            {filtered.length === entries.length
              ? `${entries.length} contrato${entries.length === 1 ? "" : "s"}`
              : `${filtered.length} de ${entries.length} contratos`}
          </p>
          <p className="text-[11.5px] text-muted-foreground/80">
            Ordenado por más reciente
          </p>
        </div>

        {/* Table */}
        {filtered.length === 0 ? (
          <div className="px-5 sm:px-8 py-14 text-center">
            <p className="text-[14px] text-muted-foreground">
              Ningún contrato coincide con los filtros actuales.
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
                  <Th className="w-[140px]">Estado</Th>
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
      <td className="px-4 sm:px-5 py-3">
        {entry.syncedToMaestro ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-[11px] font-semibold uppercase tracking-wider text-emerald-300 whitespace-nowrap">
            <Check className="w-3 h-3" />
            Sincronizado
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-[11px] font-semibold uppercase tracking-wider text-amber-300 whitespace-nowrap">
            <Clock className="w-3 h-3" />
            Pendiente
          </span>
        )}
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
              {entry.syncedToMaestro ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-[10.5px] font-semibold uppercase tracking-wider text-emerald-300">
                  <Check className="w-3 h-3" />
                  Sincronizado al maestro
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-[10.5px] font-semibold uppercase tracking-wider text-amber-300">
                  <Clock className="w-3 h-3" />
                  Pendiente de sincronizar
                </span>
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
