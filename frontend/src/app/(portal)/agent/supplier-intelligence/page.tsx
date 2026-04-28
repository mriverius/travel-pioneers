"use client";

import {
  ArrowRight,
  CalendarRange,
  Clock3,
  FileCheck2,
  Gauge,
  History,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/lib/useAuth";
import { SupplierWorkflow } from "./workflow";

/**
 * Supplier Intelligence landing page.
 *
 * - Admin-only metrics widgets at the top with a time-range filter
 *   (hoy / semana / mes / trimestre / all-time). Values swap per range —
 *   mock numbers until the backend publishes real counters per window.
 * - Below, the three-step workflow (`<SupplierWorkflow />`) replaces the
 *   old chat UI. The document-history section was removed per product
 *   feedback: it duplicated data visible in Utopía itself.
 */

type MetricTone = "primary" | "blue" | "amber" | "violet";

type Metric = {
  icon: LucideIcon;
  label: string;
  value: string;
  caption: string;
  trend?: string;
  tone: MetricTone;
};

type RangeKey = "today" | "week" | "month" | "quarter" | "all";

const RANGES: { key: RangeKey; label: string; summary: string }[] = [
  { key: "today", label: "Hoy", summary: "22 abr 2026" },
  { key: "week", label: "Esta semana", summary: "20 – 26 abr" },
  { key: "month", label: "Este mes", summary: "abril 2026" },
  { key: "quarter", label: "Trimestre", summary: "Q2 · abr – jun" },
  { key: "all", label: "Todo el tiempo", summary: "desde el lanzamiento" },
];

/**
 * Mock metrics per time window. The `trend` copy is tailored to the
 * window so the comparison frame always makes sense ("vs. ayer" for
 * today, "vs. trimestre anterior" for the quarter view, etc.).
 */
const METRICS_BY_RANGE: Record<RangeKey, Metric[]> = {
  today: [
    {
      icon: FileCheck2,
      label: "Contratos procesados",
      value: "3",
      caption: "Hoy",
      trend: "+1 vs. ayer",
      tone: "primary",
    },
    {
      icon: Clock3,
      label: "Minutos ahorrados",
      value: "92",
      caption: "≈ 1.5 h de trabajo manual",
      trend: "+28 min vs. ayer",
      tone: "blue",
    },
    {
      icon: Sparkles,
      label: "Plantillas generadas",
      value: "6",
      caption: "Proveedor + Tarifas",
      trend: "1 en borrador",
      tone: "violet",
    },
    {
      icon: Gauge,
      label: "Tasa de éxito",
      value: "100%",
      caption: "Cargas aprobadas a la primera",
      trend: "sin rechazos",
      tone: "amber",
    },
  ],
  week: [
    {
      icon: FileCheck2,
      label: "Contratos procesados",
      value: "14",
      caption: "Esta semana",
      trend: "+22% vs. semana anterior",
      tone: "primary",
    },
    {
      icon: Clock3,
      label: "Minutos ahorrados",
      value: "420",
      caption: "≈ 7 h de trabajo manual",
      trend: "+76 min vs. semana anterior",
      tone: "blue",
    },
    {
      icon: Sparkles,
      label: "Plantillas generadas",
      value: "28",
      caption: "Proveedor + Tarifas",
      trend: "3 en borrador",
      tone: "violet",
    },
    {
      icon: Gauge,
      label: "Tasa de éxito",
      value: "98%",
      caption: "Cargas aprobadas a la primera",
      trend: "+2 pts vs. semana anterior",
      tone: "amber",
    },
  ],
  month: [
    {
      icon: FileCheck2,
      label: "Contratos procesados",
      value: "47",
      caption: "Este mes",
      trend: "+18% vs. mes anterior",
      tone: "primary",
    },
    {
      icon: Clock3,
      label: "Minutos ahorrados",
      value: "1,420",
      caption: "≈ 23 h de trabajo manual",
      trend: "+312 min vs. mes anterior",
      tone: "blue",
    },
    {
      icon: Sparkles,
      label: "Plantillas generadas",
      value: "94",
      caption: "Proveedor + Tarifas",
      trend: "2 formatos en borrador",
      tone: "violet",
    },
    {
      icon: Gauge,
      label: "Tasa de éxito",
      value: "96%",
      caption: "Cargas aprobadas a la primera",
      trend: "+4 pts vs. mes anterior",
      tone: "amber",
    },
  ],
  quarter: [
    {
      icon: FileCheck2,
      label: "Contratos procesados",
      value: "138",
      caption: "Q2 · abr – jun",
      trend: "+24% vs. Q1",
      tone: "primary",
    },
    {
      icon: Clock3,
      label: "Minutos ahorrados",
      value: "4,180",
      caption: "≈ 70 h de trabajo manual",
      trend: "+910 min vs. Q1",
      tone: "blue",
    },
    {
      icon: Sparkles,
      label: "Plantillas generadas",
      value: "276",
      caption: "Proveedor + Tarifas",
      trend: "+58 vs. Q1",
      tone: "violet",
    },
    {
      icon: Gauge,
      label: "Tasa de éxito",
      value: "95%",
      caption: "Cargas aprobadas a la primera",
      trend: "+3 pts vs. Q1",
      tone: "amber",
    },
  ],
  all: [
    {
      icon: FileCheck2,
      label: "Contratos procesados",
      value: "612",
      caption: "Desde el lanzamiento",
      trend: "8 meses activo",
      tone: "primary",
    },
    {
      icon: Clock3,
      label: "Minutos ahorrados",
      value: "18,940",
      caption: "≈ 315 h · 39 días-persona",
      trend: "ROI consolidado",
      tone: "blue",
    },
    {
      icon: Sparkles,
      label: "Plantillas generadas",
      value: "1,224",
      caption: "Proveedor + Tarifas",
      trend: "promedio 2 por contrato",
      tone: "violet",
    },
    {
      icon: Gauge,
      label: "Tasa de éxito",
      value: "94%",
      caption: "Cargas aprobadas a la primera",
      trend: "estable",
      tone: "amber",
    },
  ],
};

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
  amber: {
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    icon: "text-amber-300",
    value: "text-foreground",
  },
  violet: {
    bg: "bg-violet-500/10",
    border: "border-violet-500/30",
    icon: "text-violet-300",
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

      {/* Link to the full history sub-page (table + filters). */}
      <Link
        href="/agent/supplier-intelligence/history"
        className="group flex items-center gap-3 rounded-2xl border border-border bg-card/80 px-5 py-4 hover:border-primary/40 hover:bg-card/90 transition-colors"
      >
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center shrink-0">
          <History className="w-4.5 h-4.5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[14.5px] font-semibold text-foreground">
            Ver historial de contratos
          </p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Tabla con todos los contratos procesados, con filtros por estado,
            tipo de archivo y fecha.
          </p>
        </div>
        <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all shrink-0" />
      </Link>
    </div>
  );
}

function AdminMetrics() {
  const [range, setRange] = useState<RangeKey>("month");
  const active = RANGES.find((r) => r.key === range) ?? RANGES[2];
  const metrics = METRICS_BY_RANGE[range];

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

      {/* Keyed on the range so values animate in when the filter changes */}
      <div
        key={range}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 animate-page-enter"
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
        {metric.trend && (
          <span className="text-[10.5px] font-medium text-primary/90 bg-primary/10 border border-primary/20 rounded px-1.5 py-0.5 whitespace-nowrap">
            {metric.trend}
          </span>
        )}
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
