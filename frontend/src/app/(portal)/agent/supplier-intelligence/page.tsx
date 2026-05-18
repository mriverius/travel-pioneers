"use client";

import {
  CalendarRange,
  Clock3,
  FileCheck2,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/useAuth";
import {
  api,
  ApiError,
  type ContractStats,
  type ContractStatsBuckets,
} from "@/lib/api";
import { SupplierWorkflow } from "./workflow";

/**
 * Cuántos minutos de trabajo manual ahorra cada **fila** que el agente
 * genera en el xlsx (no por contrato). Un contrato con 20 product×season
 * = 20 filas → 100 minutos. Es mejor proxy del ROI real que un multiplicador
 * por contrato porque la carga manual escala con filas, no con contratos.
 *
 * Vive en el frontend para poder ajustarlo sin redeploy. Si más adelante
 * tenemos telemetría real (tiempo promedio manual vs IA por fila), lo
 * recalibramos aquí.
 */
const MINUTES_SAVED_PER_LINE = 5;

/**
 * Supplier Intelligence landing page.
 *
 * - Admin-only metrics widgets at the top with a time-range filter
 *   (hoy / semana / mes / trimestre / all-time). Values swap per range —
 *   mock numbers until the backend publishes real counters per window.
 * - Below, the three-step workflow (`<SupplierWorkflow />`) replaces the
 *   old chat UI. The document-history sub-page now lives as its own nav
 *   item in the sidebar (anidado bajo Supplier Intelligence) — el link
 *   debajo del workflow se removió porque duplicaba la navegación.
 */

type MetricTone = "primary" | "blue";

type Metric = {
  icon: LucideIcon;
  label: string;
  value: string;
  caption: string;
  tone: MetricTone;
};

type RangeKey = keyof ContractStatsBuckets;

const RANGES: { key: RangeKey; label: string; summary: string }[] = [
  { key: "today", label: "Hoy", summary: "hoy" },
  { key: "week", label: "Esta semana", summary: "últimos 7 días" },
  { key: "month", label: "Este mes", summary: "últimos 30 días" },
  { key: "quarter", label: "Trimestre", summary: "últimos 90 días" },
  { key: "all", label: "Todo el tiempo", summary: "desde el lanzamiento" },
];

/**
 * Construye los dos widgets de métricas a partir del rango activo y los
 * counters reales del backend. Mantenemos solamente "Contratos procesados"
 * y "Minutos ahorrados" — las métricas de plantillas y tasa de éxito que
 * existían antes (mock) se eliminaron porque no tenían una señal real.
 *
 * - Contratos = `stats.contracts[range]`
 * - Minutos   = `stats.lines[range] * MINUTES_SAVED_PER_LINE`
 *
 * Si `stats` es null (loading o error), devolvemos placeholders con `—`.
 */
function buildMetrics(
  range: RangeKey,
  stats: ContractStats | null,
): Metric[] {
  const contracts = stats?.contracts[range] ?? null;
  const lines = stats?.lines[range] ?? null;
  const minutes = lines !== null ? lines * MINUTES_SAVED_PER_LINE : null;
  const minutesCaption =
    minutes === null
      ? "Tiempo de trabajo manual ahorrado"
      : lines === 0
        ? "Sin filas procesadas en este rango"
        : minutes >= 60
          ? `${lines} fila${lines === 1 ? "" : "s"} · ≈ ${(minutes / 60).toFixed(1)} h de trabajo manual`
          : `${lines} fila${lines === 1 ? "" : "s"} · trabajo manual ahorrado`;
  const formatted = (n: number) =>
    n >= 1000 ? n.toLocaleString("es-CR") : String(n);
  return [
    {
      icon: FileCheck2,
      label: "Contratos procesados",
      value: contracts === null ? "—" : formatted(contracts),
      caption:
        contracts === null
          ? "Cargando…"
          : RANGES.find((r) => r.key === range)?.summary ?? "",
      tone: "primary",
    },
    {
      icon: Clock3,
      label: "Minutos ahorrados",
      value: minutes === null ? "—" : formatted(minutes),
      caption: minutesCaption,
      tone: "blue",
    },
  ];
}

const toneStyles: Record<
  MetricTone,
  { bg: string; border: string; icon: string; value: string }
> = {
  primary: {
    bg: "bg-primary/10",
    border: "border-primary/30",
    icon: "text-primary",
    value: "text-foreground",
  },
  blue: {
    bg: "bg-sky-500/10",
    border: "border-sky-500/30",
    icon: "text-sky-300",
    value: "text-foreground",
  },
};

export default function SupplierIntelligencePage() {
  const { session } = useAuth();
  const isAdmin = session?.user.role === "admin";

  return (
    <div className="space-y-6">
      {/* Header */}
      <header>
        <h1 className="text-[28px] font-bold tracking-tight text-foreground">
          AI Supplier Intelligence Agent
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5">
          Procesamiento inteligente de contratos de proveedores turísticos
        </p>
      </header>

      {/* Admin-only metrics */}
      {isAdmin && <AdminMetrics />}

      {/* Workflow */}
      <SupplierWorkflow />
    </div>
  );
}

function AdminMetrics() {
  const [range, setRange] = useState<RangeKey>("month");
  const active = RANGES.find((r) => r.key === range) ?? RANGES[2];
  const [stats, setStats] = useState<ContractStats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Refrescamos los counters al montar y cada vez que el componente vuelve
  // a foreground (el usuario procesa un contrato y vuelve aquí). Para el
  // refresh-on-visibility usamos `visibilitychange` que es ~gratis.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { stats: next } = await api.supplierIntelligence.stats();
        if (!cancelled) {
          setStats(next);
          setLoadError(null);
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError
            ? err.message
            : "No pudimos cargar las métricas.",
        );
      }
    };
    void load();
    const onVis = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const metrics = buildMetrics(range, stats);

  return (
    <section aria-label="Métricas del agente" className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-[10.5px] font-semibold uppercase tracking-wider">
            <TrendingUp className="w-3 h-3" />
            Solo admins
          </span>
          <p className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <CalendarRange className="w-3.5 h-3.5 text-muted-foreground/80" />
            Resumen del agente · {active.summary}
          </p>
        </div>

        <RangeFilter value={range} onChange={setRange} />
      </div>

      {loadError && (
        <p className="text-[12px] text-rose-300" role="alert">
          {loadError}
        </p>
      )}

      {/* Keyed on the range so values animate in when the filter changes */}
      <div
        key={range}
        className="grid grid-cols-1 sm:grid-cols-2 gap-3 animate-page-enter"
      >
        {metrics.map((m) => (
          <MetricCard key={m.label} metric={m} />
        ))}
      </div>
    </section>
  );
}

function RangeFilter({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Rango de tiempo"
      className="inline-flex items-center gap-1 p-1 rounded-lg border border-border bg-secondary/40 overflow-x-auto"
    >
      {RANGES.map((r) => {
        const active = value === r.key;
        return (
          <button
            key={r.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(r.key)}
            className={`relative inline-flex items-center h-8 px-3 rounded-md text-[12.5px] font-medium transition-all whitespace-nowrap ${
              active
                ? "bg-primary/15 text-foreground border border-primary/40 shadow-[0_0_14px_0_hsl(var(--primary)/0.2)]"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/80 border border-transparent"
            }`}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

function MetricCard({ metric }: { metric: Metric }) {
  const tone = toneStyles[metric.tone];
  const Icon = metric.icon;
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card/80 p-4 transition-colors hover:border-primary/30">
      <div
        aria-hidden
        className={`pointer-events-none absolute -top-10 -right-10 h-24 w-24 rounded-full ${tone.bg} blur-2xl`}
      />
      <div className="relative flex items-start justify-between">
        <div
          className={`w-9 h-9 rounded-lg border flex items-center justify-center ${tone.bg} ${tone.border}`}
        >
          <Icon className={`w-4 h-4 ${tone.icon}`} />
        </div>
      </div>
      <p
        className={`relative mt-3 text-[26px] font-bold leading-none ${tone.value}`}
      >
        {metric.value}
      </p>
      <p className="relative text-[13px] text-foreground/90 mt-2">
        {metric.label}
      </p>
      <p className="relative text-[11.5px] text-muted-foreground mt-0.5">
        {metric.caption}
      </p>
    </div>
  );
}
