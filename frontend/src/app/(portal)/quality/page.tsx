"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertCircle,
  BookMarked,
  FlaskConical,
  RefreshCcw,
  ScanSearch,
  ShieldCheck,
  Table2,
} from "lucide-react";
import AdminGuard from "@/components/admin-guard";
import { ApiError, api, type ContractRangeKey, type QualityReport } from "@/lib/api";

/**
 * Calidad del agente — métricas en vivo a partir del `feedback` de cada run.
 *
 * Es la alternativa barata a "un fixture por contrato": cada contrato real
 * mide dónde acertó el pre-scan, cuánto corrigió la persona a la IA y qué
 * hallazgos del QA se repiten. Sin IA, sólo lectura. Lo que se repite baja
 * a «Reglas del agente» como sugerencia.
 */

const RANGES: { id: ContractRangeKey; label: string }[] = [
  { id: "month", label: "30 días" },
  { id: "quarter", label: "90 días" },
  { id: "all", label: "Todo" },
];

export default function QualityPage() {
  return (
    <AdminGuard>
      <QualityPageContent />
    </AdminGuard>
  );
}

function QualityPageContent() {
  const [range, setRange] = useState<ContractRangeKey>("quarter");
  const [report, setReport] = useState<QualityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.supplierIntelligence
      .quality(range)
      .then(({ quality }) => {
        if (!cancelled) {
          setReport(quality);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "No se pudo cargar el panel de calidad.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, reloadKey]);

  const r = report;
  const pct = (num: number, den: number) => (den === 0 ? null : Math.round((num / den) * 100));
  const supplierPct = r ? pct(r.pre_scan.supplier_hits, r.pre_scan.comparable) : null;
  const avgBriefCorr = r && r.brief.runs > 0 ? (r.brief.user_corrections / r.brief.runs).toFixed(1) : null;
  const cellsPct = r && r.rows.total_rows > 0 ? ((r.rows.corrected_cells / r.rows.total_rows) * 100).toFixed(0) : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 pl-12 lg:pl-0">
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-foreground">Calidad del agente</h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Cada contrato aprobado mide al sistema: qué detectó el lector sin IA, cuánto corrigió la
            persona a la IA y qué revisa el QA una y otra vez. Sirve para decidir dónde invertir, no
            para calificar a nadie.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start">
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            {RANGES.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  setRange(opt.id);
                  setLoading(true);
                }}
                className={`px-3 h-10 text-[12.5px] transition-colors ${
                  range === opt.id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setReloadKey((k) => k + 1);
            }}
            disabled={loading}
            className="inline-flex items-center gap-2 h-10 px-3 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-50"
            aria-label="Refrescar"
          >
            <RefreshCcw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {r && r.runs_with_feedback === 0 && !loading && (
        <div className="rounded-xl border border-border bg-card/80 px-5 py-8 text-center space-y-1.5">
          <Activity className="mx-auto h-6 w-6 text-primary" />
          <p className="text-[14px] font-semibold text-foreground">Todavía no hay mediciones</p>
          <p className="text-[12.5px] text-muted-foreground max-w-md mx-auto">
            {r.runs > 0
              ? `Hay ${r.runs} contrato(s) en este rango, pero se procesaron antes de que el sistema registrara correcciones. `
              : ""}
            A partir del próximo contrato que apruebes, este panel se llena solo.
          </p>
        </div>
      )}

      {r && r.runs_with_feedback > 0 && (
        <>
          {/* KPIs */}
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi
              label="Contratos medidos"
              value={`${r.runs_with_feedback}`}
              sub={r.runs > r.runs_with_feedback ? `de ${r.runs} en el rango` : "en el rango"}
              icon={<Activity className="h-4 w-4" />}
            />
            <Kpi
              label="Proveedor detectado sin IA"
              value={supplierPct === null ? "—" : `${supplierPct}%`}
              sub={r.pre_scan.comparable > 0 ? `${r.pre_scan.supplier_hits}/${r.pre_scan.comparable} aciertos` : "sin casos comparables"}
              icon={<ScanSearch className="h-4 w-4" />}
              tone={supplierPct === null ? "muted" : supplierPct >= 90 ? "good" : supplierPct >= 70 ? "warn" : "bad"}
            />
            <Kpi
              label="Correcciones al brief"
              value={avgBriefCorr ?? "—"}
              sub={avgBriefCorr ? "por contrato (Paso 2)" : "sin datos"}
              icon={<ShieldCheck className="h-4 w-4" />}
              tone={avgBriefCorr === null ? "muted" : Number(avgBriefCorr) <= 1 ? "good" : Number(avgBriefCorr) <= 3 ? "warn" : "bad"}
            />
            <Kpi
              label="Celdas corregidas"
              value={cellsPct === null ? "—" : `${cellsPct}%`}
              sub={cellsPct !== null ? `${r.rows.corrected_cells} celdas en ${r.rows.total_rows} filas` : "sin datos"}
              icon={<Table2 className="h-4 w-4" />}
              tone={cellsPct === null ? "muted" : Number(cellsPct) <= 5 ? "good" : Number(cellsPct) <= 15 ? "warn" : "bad"}
            />
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Pre-scan */}
            <Panel title="Lector sin IA (Paso 1)" icon={<ScanSearch className="h-4 w-4 text-primary" />}>
              <Row k="Documentos con texto legible" v={`${r.pre_scan.with_text} contrato(s)`} />
              <Row k="Huecos del brief rellenados por el documento" v={`${r.brief.prescan_fills}`} />
              {Object.entries(r.pre_scan.by_confidence).length > 0 && (
                <div className="pt-2 space-y-1">
                  <p className="text-[11.5px] uppercase tracking-wider text-muted-foreground">Acierto por confianza declarada</p>
                  {Object.entries(r.pre_scan.by_confidence).map(([conf, v]) => (
                    <Bar key={conf} label={conf} num={v.hits} den={v.total} />
                  ))}
                  <p className="text-[11px] text-muted-foreground pt-1">
                    Si «alta» no está cerca de 100%, el umbral de auto-selección es demasiado bajo. Si «media» acierta
                    mucho, es demasiado alto.
                  </p>
                </div>
              )}
            </Panel>

            {/* Paso 2 */}
            <Panel title="Brief y preguntas (Paso 2)" icon={<ShieldCheck className="h-4 w-4 text-primary" />}>
              <Row k="Correcciones de la persona" v={`${r.brief.user_corrections} en ${r.brief.runs} contrato(s)`} />
              <Row k="Mensajes al chat de refinamiento" v={`${r.brief.chat_messages}`} />
              <Row k="Preguntas del revisor" v={`${r.brief.questions_asked}`} />
              {r.brief.questions_asked > 0 && (
                <div className="pt-1 space-y-1">
                  <Bar label="Ganó el documento" num={r.brief.answered_doc} den={r.brief.questions_asked} />
                  <Bar label="Ganó la IA" num={r.brief.answered_ai} den={r.brief.questions_asked} />
                  <Bar label="Otra opción" num={r.brief.answered_other} den={r.brief.questions_asked} />
                  <Bar label="Omitidas" num={r.brief.skipped} den={r.brief.questions_asked} />
                  <p className="text-[11px] text-muted-foreground pt-1">
                    Muchas «ganó la IA» significa que el lector sin IA se equivoca en ese tema; muchas «ganó el
                    documento», que la IA necesita una regla.
                  </p>
                </div>
              )}
              <TopList title="Campos más corregidos" items={r.brief.top_fields.map((x) => ({ label: fieldLabel(x.field), count: x.count }))} />
              <TopList title="Hallazgos más frecuentes" items={r.brief.top_findings.map((x) => ({ label: x.id, count: x.count, tone: x.severity }))} />
            </Panel>

            {/* Paso 3 */}
            <Panel title="Tabla final (Paso 3)" icon={<Table2 className="h-4 w-4 text-primary" />}>
              <Row k="Filas aprobadas" v={`${r.rows.total_rows} en ${r.rows.runs} contrato(s)`} />
              <Row k="Filas agregadas / eliminadas a mano" v={`${r.rows.rows_added} / ${r.rows.rows_removed}`} />
              <Row k="Mensajes al chat de la tabla" v={`${r.rows.chat_messages}`} />
              <Row
                k="Contratos aprobados con errores del QA"
                v={`${r.rows.runs_with_errors_acknowledged}`}
                warn={r.rows.runs_with_errors_acknowledged > 0}
              />
              <TopList title="Columnas más corregidas" items={r.rows.top_fields.map((x) => ({ label: fieldLabel(x.field), count: x.count }))} />
              <TopList title="Hallazgos más frecuentes" items={r.rows.top_findings.map((x) => ({ label: x.id, count: x.count, tone: x.severity }))} />
            </Panel>

            {/* Recurrentes */}
            <Panel title="Correcciones recurrentes" icon={<BookMarked className="h-4 w-4 text-primary" />}>
              {r.recurring.length === 0 ? (
                <p className="text-[12.5px] text-muted-foreground">
                  Ninguna corrección se repite todavía en dos contratos. Cuando ocurra, aparecerá aquí y como
                  sugerencia en «Reglas del agente».
                </p>
              ) : (
                <ul className="space-y-2">
                  {r.recurring.map((x, i) => (
                    <li key={i} className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-[12.5px]">
                      <p className="text-foreground">
                        <span className="font-medium">{fieldLabel(x.field)}</span>:{" "}
                        <span className="line-through opacity-60">{x.before ?? "vacío"}</span> → {x.after ?? "vacío"}
                      </p>
                      <p className="text-[11.5px] text-muted-foreground">
                        {x.runs} contrato(s) · {x.suppliers.join(", ")}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[12px] text-muted-foreground pt-2">
                <Link href="/agent-rules" className="text-primary hover:underline">
                  Revisar sugerencias de reglas →
                </Link>
              </p>
            </Panel>
          </div>

          <p className="text-[12px] text-muted-foreground flex items-center gap-1.5">
            <FlaskConical className="h-3.5 w-3.5" />
            Esto mide contratos reales. Para proteger el lector sin IA cuando se modifica, están los{" "}
            <Link href="/eval-cases" className="text-primary hover:underline">
              casos de prueba
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

const FIELD_LABELS: Record<string, string> = {
  prices_include_tax: "Precios incluyen impuesto",
  tax_rate_pct: "Tasa de impuesto",
  commission_default_pct: "Comisión por defecto",
  currency: "Moneda",
  seasons_detail: "Temporadas",
  bank_accounts: "Cuentas bancarias",
  product_categories: "Categorías de producto",
  row_plan: "Plan de filas",
  tipo_unidad: "Tipo unidad",
  notes: "Notas",
  "shared_fields.cedula": "Cédula",
  "shared_fields.proveedor": "Razón social",
  "shared_fields.nombre_comercial": "Nombre comercial",
  "shared_fields.reservations_email": "Correo reservas",
  "shared_fields.telefono": "Teléfono",
  "shared_fields.direccion": "Dirección",
  "shared_fields.pais": "País",
  "shared_fields.contract_starts": "Inicio vigencia",
  "shared_fields.contract_ends": "Fin vigencia",
  product_name: "Producto",
  categoria: "Categoría",
  ocupacion: "Ocupación",
  season_name: "Temporada",
  season_starts: "Inicio temporada",
  season_ends: "Fin temporada",
  precios_neto_iva: "Precio neto",
  precio_rack_iva: "Precio rack",
  porcentaje_comision: "% comisión",
  cancellation_policy: "Política de cancelación",
  range_payment_policy: "Política de pago",
  kids_policy: "Política de niños",
  meals_included: "Alimentación",
  codigo_servicio: "Código servicio",
  cedula: "Cédula",
  numero_cuenta: "Cuenta",
  banco: "Banco",
  tipo_moneda: "Moneda",
  reservations_email: "Correo reservas",
};

function fieldLabel(f: string): string {
  return FIELD_LABELS[f] ?? f;
}

function Kpi({
  label,
  value,
  sub,
  icon,
  tone = "muted",
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  tone?: "good" | "warn" | "bad" | "muted";
}) {
  const color = { good: "text-emerald-300", warn: "text-amber-300", bad: "text-red-300", muted: "text-foreground" }[tone];
  return (
    <div className="bg-card/80 border border-border rounded-xl px-4 py-3.5">
      <p className="flex items-center gap-1.5 text-[11.5px] uppercase tracking-wider text-muted-foreground">
        <span className="text-primary">{icon}</span>
        {label}
      </p>
      <p className={`text-[24px] font-bold mt-1 ${color}`}>{value}</p>
      <p className="text-[11.5px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-card/80 border border-border rounded-xl p-4 sm:p-5 space-y-2">
      <h2 className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ k, v, warn = false }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1 text-[12.5px]">
      <span className="text-muted-foreground">{k}</span>
      <span className={warn ? "text-amber-300 font-medium" : "text-foreground"}>{v}</span>
    </div>
  );
}

function Bar({ label, num, den }: { label: string; num: number; den: number }) {
  const p = den === 0 ? 0 : Math.round((num / den) * 100);
  return (
    <div className="text-[12px]">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground">
          {num}/{den} · {p}%
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className="h-full bg-primary/70" style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

function TopList({ title, items }: { title: string; items: { label: string; count: number; tone?: string }[] }) {
  if (items.length === 0) return null;
  const toneClass = (t?: string) => (t === "error" ? "text-red-300" : t === "warning" ? "text-amber-300" : "text-muted-foreground");
  return (
    <div className="pt-2">
      <p className="text-[11.5px] uppercase tracking-wider text-muted-foreground mb-1">{title}</p>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((x) => (
          <li key={x.label} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2 py-0.5 text-[12px]">
            <span className={toneClass(x.tone)}>{x.label}</span>
            <span className="font-mono text-[11px] text-foreground">{x.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
