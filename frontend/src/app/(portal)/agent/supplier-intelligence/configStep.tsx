"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  Brain,
  Building2,
  CalendarRange,
  Calculator,
  Check,
  ChevronDown,
  Info,
  Loader2,
  Percent,
  Plus,
  Receipt,
  Send,
  Sparkles,
  Tags,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AnalyzeBriefMeta,
  BriefChatMessage,
  ConfigAdditionalPerson,
  ConfigBankAccount,
  ConfigSeason,
  ConfigSharedFields,
  ContractConfigVariables,
} from "@/lib/api";
import type { CatalogPrefill } from "./workflow";

/**
 * STEP 2 — Variables de Configuración (paso intermedio del flujo gated).
 *
 * Muestra las REGLAS GLOBALES que la Fase 1 (pre-análisis) detectó en el/los
 * contrato(s): si los precios incluyen IVA, la comisión por defecto, las
 * temporadas con sus fechas, persona adicional, cuentas bancarias, periodos
 * especiales, etc. El usuario las confirma o corrige ANTES de la extracción
 * completa — y la versión editada se inyecta como reglas autoritativas en la
 * pasada principal (Opus). Es el gate de mayor impacto: un valor mal acá (ej.
 * "los precios NO incluyen IVA") se propaga a TODAS las filas.
 *
 * El componente es totalmente controlado por estado local: clona el config
 * entrante, deja editar cada campo, y al confirmar emite el objeto editado.
 */

/* -------------------------------------------------------------------------- */
/*                         Draft hydration from config                        */
/* -------------------------------------------------------------------------- */

function hydrateDraftFromConfig(
  config: ContractConfigVariables,
): ContractConfigVariables {
  const detail = config.seasons_detail.map((s) => ({ ...s }));
  const haveNames = new Set(
    detail.map((s) => (s.name ?? "").trim().toLowerCase()),
  );
  for (const name of config.seasons) {
    const key = name.trim().toLowerCase();
    if (key !== "" && !haveNames.has(key)) {
      haveNames.add(key);
      detail.push({ name, starts: null, ends: null, raw_range: null });
    }
  }
  return {
    ...config,
    shared_fields: { ...config.shared_fields },
    bank_accounts: config.bank_accounts.map((b) => ({ ...b })),
    additional_person: config.additional_person.map((a) => ({ ...a })),
    seasons_detail: detail,
    product_categories: [...config.product_categories],
    seasons: [...config.seasons],
    sections: [...config.sections],
    row_plan: config.row_plan ? { ...config.row_plan, categories: [...config.row_plan.categories] } : null,
  };
}

function buildLogicSummaryFromBrief(
  brief: ContractConfigVariables,
): string | null {
  const parts: string[] = [];
  const name =
    brief.shared_fields.nombre_comercial?.trim() ||
    brief.shared_fields.proveedor?.trim();
  if (name) {
    parts.push(`Estás cargando las tarifas de ${name}.`);
  }

  const loc = [brief.shared_fields.direccion, brief.shared_fields.pais]
    .filter(Boolean)
    .join(", ");
  if (loc) parts.push(`Ubicación: ${loc}.`);

  if (brief.shared_fields.contract_starts || brief.shared_fields.contract_ends) {
    parts.push(
      `Vigencia: ${brief.shared_fields.contract_starts ?? "?"} al ${brief.shared_fields.contract_ends ?? "?"}.`,
    );
  }

  if (brief.seasons_detail.length > 0) {
    const seasonDesc = brief.seasons_detail
      .map((s) => {
        const range =
          s.raw_range?.trim() ||
          [s.starts, s.ends].filter(Boolean).join(" – ");
        return `${s.name ?? "Temporada"}${range ? ` (${range})` : ""}`;
      })
      .join("; ");
    parts.push(`Temporadas: ${seasonDesc}.`);
  } else if (brief.seasons.length > 0) {
    parts.push(`Temporadas: ${brief.seasons.join(", ")}.`);
  }

  if (brief.currency) parts.push(`Moneda: ${brief.currency}.`);

  if (brief.prices_include_tax === false) {
    const rate = brief.tax_rate_pct ?? 13;
    parts.push(`Los precios NO incluyen el IVA del ${rate}%.`);
  } else if (brief.prices_include_tax === true) {
    parts.push("Los precios incluyen IVA.");
  }

  if (brief.commission_default_pct != null) {
    parts.push(`Comisión general: ${brief.commission_default_pct}%.`);
  }
  if (brief.commission_summary?.trim()) {
    parts.push(brief.commission_summary.trim());
  }

  if (brief.product_categories.length > 0) {
    parts.push(`Categorías: ${brief.product_categories.join(", ")}.`);
  }

  if (brief.expected_row_estimate != null && brief.expected_row_estimate > 0) {
    parts.push(
      `Se estiman aproximadamente ${brief.expected_row_estimate} filas en el Excel.`,
    );
  }

  if (brief.meal_plan_note?.trim()) parts.push(brief.meal_plan_note.trim());
  if (brief.special_periods_note?.trim()) {
    parts.push(brief.special_periods_note.trim());
  }
  if (brief.notes?.trim()) parts.push(brief.notes.trim());

  return parts.length > 0 ? parts.join(" ") : null;
}

/* -------------------------------------------------------------------------- */
/*                         Logic summary (Markdown-lite)                       */
/* -------------------------------------------------------------------------- */

/**
 * Renderiza el `logic_summary` (Markdown-lite): convierte **negritas** en
 * <strong> y preserva saltos de línea. Las líneas que son SOLO un título en
 * negrita (las 10 secciones estándar) se muestran como encabezados. Siempre
 * dentro del MISMO contenedor (mismo alto/estilo) sea análisis inicial o
 * corrección — así el bloque no "encoge" tras un refine.
 */
function renderInlineBold(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== "");
  return parts.map((part, i) => {
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    if (m) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-foreground">
          {m[1]}
        </strong>
      );
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

function LogicSummaryView({ summary }: { summary: string }) {
  const lines = summary.split("\n");
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (trimmed === "") return <div key={i} className="h-1.5" />;
        // Línea que es solo un título de sección en negrita → encabezado.
        const isHeading = /^\*\*[^*]+\*\*$/.test(trimmed);
        return (
          <p
            key={i}
            className={
              isHeading
                ? "text-[13px] font-semibold text-foreground mt-2 first:mt-0"
                : "text-[13px] leading-relaxed text-foreground/90"
            }
          >
            {renderInlineBold(line, `l${i}`)}
          </p>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Small UI helpers                              */
/* -------------------------------------------------------------------------- */

function SectionCard({
  icon,
  title,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60">
      <header className="flex items-start gap-2 px-4 py-3 border-b border-border/60">
        <span className="mt-0.5 text-primary">{icon}</span>
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold text-foreground">{title}</p>
          {hint && (
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">{hint}</p>
          )}
        </div>
      </header>
      <div className="px-4 py-3.5 space-y-3">{children}</div>
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "number" | "date";
  className?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/60 focus:bg-secondary/50 ${className}`}
    />
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <label className="block text-[11px] font-medium text-muted-foreground mb-1">
      {children}
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Tax (IVA) tri-state toggle                        */
/* -------------------------------------------------------------------------- */

function TaxToggle({
  value,
  onChange,
}: {
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const opts: { label: string; v: boolean | null; tone: string }[] = [
    { label: "Sí, ya incluyen IVA", v: true, tone: "emerald" },
    { label: "No, hay que sumarlo", v: false, tone: "amber" },
    { label: "No está claro", v: null, tone: "muted" },
  ];
  return (
    <div className="inline-flex flex-wrap gap-1.5">
      {opts.map((o) => {
        const active = value === o.v;
        return (
          <button
            key={String(o.v)}
            type="button"
            onClick={() => onChange(o.v)}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors ${
              active
                ? "bg-primary text-primary-foreground border-primary shadow-[0_0_10px_0_hsl(var(--primary)/0.35)]"
                : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground"
            }`}
          >
            {active && <Check className="h-3.5 w-3.5" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Main step                                  */
/* -------------------------------------------------------------------------- */

export function ConfigVariablesStep({
  config,
  meta,
  catalogPrefill,
  extracting,
  isRefining,
  chatHistory,
  serverError,
  onConfirm,
  onRefine,
  onBack,
  onDraftChange,
  onCatalogChange,
  showActions = true,
}: {
  config: ContractConfigVariables;
  meta: AnalyzeBriefMeta;
  /** Clasificación de catálogo (lista-proveedores) matcheada en el step 1. */
  catalogPrefill: CatalogPrefill | null;
  /** True mientras corre la extracción principal disparada al confirmar. */
  extracting: boolean;
  /** True mientras Sonnet re-analiza tras feedback del chat. */
  isRefining: boolean;
  /** Historial conversacional de correcciones. */
  chatHistory: BriefChatMessage[];
  serverError: string | null;
  onConfirm: (
    edited: ContractConfigVariables,
    catalog: CatalogPrefill | null,
  ) => void;
  onRefine: (message: string) => Promise<void>;
  onBack: () => void;
  /**
   * Reporta el brief editado hacia el padre en cada cambio. Lo usa el flujo
   * multi-documento para mantener vivos los drafts de cada tab sin perder
   * ediciones al cambiar de pestaña.
   */
  onDraftChange?: (edited: ContractConfigVariables) => void;
  /** Reporta la clasificación de catálogo editada hacia el padre. */
  onCatalogChange?: (catalog: CatalogPrefill) => void;
  /**
   * Cuando es false, el padre maneja la barra de acciones (Volver / Confirmar)
   * y el serverError — útil en multi-documento donde el confirm es global.
   */
  showActions?: boolean;
}) {
  const [feedbackInput, setFeedbackInput] = useState("");

  // Estado local editable — se re-sincroniza cuando el brief se actualiza tras refine.
  const [draft, setDraft] = useState<ContractConfigVariables>(() =>
    hydrateDraftFromConfig(config),
  );

  useEffect(() => {
    setDraft(hydrateDraftFromConfig(config));
  }, [config]);

  // Clasificación de catálogo (lista-proveedores). codigo_servicio es row-level
  // (se confirma en el step 3), así que NO se edita acá — pero lo arrastramos
  // sin tocar para no perder el hint del match.
  const [catalog, setCatalog] = useState<CatalogPrefill>(() => ({
    tipo_actividad: catalogPrefill?.tipo_actividad ?? null,
    zona_turismo: catalogPrefill?.zona_turismo ?? null,
    proveedor_codigo: catalogPrefill?.proveedor_codigo ?? null,
    codigo_servicio: catalogPrefill?.codigo_servicio ?? null,
  }));
  const setCatalogField = (
    key: "tipo_actividad" | "zona_turismo" | "proveedor_codigo",
    value: string,
  ) => setCatalog((c) => ({ ...c, [key]: value.trim() === "" ? null : value }));

  // Reportar draft/catalog hacia el padre (multi-documento). Usamos refs para
  // que un cambio de identidad del callback no re-dispare el efecto, y NO
  // re-hidratamos desde lo que emitimos (el padre no reinyecta `config`).
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const onCatalogChangeRef = useRef(onCatalogChange);
  onCatalogChangeRef.current = onCatalogChange;
  useEffect(() => {
    onDraftChangeRef.current?.(draft);
  }, [draft]);
  useEffect(() => {
    onCatalogChangeRef.current?.(catalog);
  }, [catalog]);

  const patch = (p: Partial<ContractConfigVariables>) =>
    setDraft((d) => ({ ...d, ...p }));

  /** Edita un campo de identidad compartida (proveedor, cédula, vigencia…). */
  const setShared = (key: keyof ConfigSharedFields, value: string) =>
    setDraft((d) => ({
      ...d,
      shared_fields: {
        ...d.shared_fields,
        [key]: value.trim() === "" ? null : value,
      },
    }));

  /* --- seasons --- */
  const setSeason = (i: number, p: Partial<ConfigSeason>) =>
    setDraft((d) => ({
      ...d,
      seasons_detail: d.seasons_detail.map((s, idx) =>
        idx === i ? { ...s, ...p } : s,
      ),
    }));
  const addSeason = () =>
    setDraft((d) => ({
      ...d,
      seasons_detail: [
        ...d.seasons_detail,
        { name: "", starts: "", ends: "", raw_range: null },
      ],
    }));
  const removeSeason = (i: number) =>
    setDraft((d) => ({
      ...d,
      seasons_detail: d.seasons_detail.filter((_, idx) => idx !== i),
    }));

  /* --- additional person --- */
  const setAddl = (i: number, p: Partial<ConfigAdditionalPerson>) =>
    setDraft((d) => ({
      ...d,
      additional_person: d.additional_person.map((a, idx) =>
        idx === i ? { ...a, ...p } : a,
      ),
    }));
  const addAddl = () =>
    setDraft((d) => ({
      ...d,
      additional_person: [
        ...d.additional_person,
        { scope: "", applies_to: "", rack: "", net: "" },
      ],
    }));
  const removeAddl = (i: number) =>
    setDraft((d) => ({
      ...d,
      additional_person: d.additional_person.filter((_, idx) => idx !== i),
    }));

  /* --- bank accounts --- */
  const setBank = (i: number, p: Partial<ConfigBankAccount>) =>
    setDraft((d) => ({
      ...d,
      bank_accounts: d.bank_accounts.map((b, idx) =>
        idx === i ? { ...b, ...p } : b,
      ),
    }));
  const addBank = () =>
    setDraft((d) => ({
      ...d,
      bank_accounts: [
        ...d.bank_accounts,
        { bank: "", account_number: "", currency: "", swift: null, note: null },
      ],
    }));
  const removeBank = (i: number) =>
    setDraft((d) => ({
      ...d,
      bank_accounts: d.bank_accounts.filter((_, idx) => idx !== i),
    }));

  const numOrNull = (s: string): number | null => {
    const t = s.trim();
    if (t === "") return null;
    const n = Number(t.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };
  const strOrNull = (s: string): string | null => (s.trim() === "" ? null : s);

  /* ---- Plan de filas (cuántas líneas tendrá el Excel) ----
   * Cálculo DETERMINÍSTICO desde el inventario confirmado, no una adivinanza
   * del modelo. # temporadas se deriva en vivo de la sección de temporadas;
   * # categorías y ocupaciones/categoría son editables (la lista de categorías
   * del modelo puede venir incompleta). El total base se le pasa a Opus como
   * meta de completitud por temporada, y las filas de persona adicional las
   * agrega el servidor automáticamente. */
  const initSeasons = config.seasons_detail.length;
  const [planCats, setPlanCats] = useState<number>(() => {
    const fromPlan = config.row_plan?.categories.length ?? 0;
    return fromPlan || config.product_categories.length || 0;
  });
  const [planOcc, setPlanOcc] = useState<number>(() => {
    const cats = config.product_categories.length;
    const est = config.expected_row_estimate ?? 0;
    if (est > 0 && cats > 0 && initSeasons > 0) {
      return Math.max(1, Math.round(est / (cats * initSeasons)));
    }
    return 1;
  });

  const planSeasons = draft.seasons_detail.length;
  const perSeasonCombos = Math.max(0, planCats) * Math.max(0, planOcc);
  const baseTotal = planSeasons * perSeasonCombos;
  const hasAddl = draft.additional_person.length > 0;
  // Cada grupo product × temporada con persona adicional materializa TPL + QDP
  // (2 filas extra) en el servidor — estimación.
  const expansionRows = hasAddl ? 2 * Math.max(0, planCats) * planSeasons : 0;
  const finalEstimate = baseTotal + expansionRows;

  const handleRefine = async () => {
    const msg = feedbackInput.trim();
    if (!msg || isRefining || extracting) return;
    setFeedbackInput("");
    await onRefine(msg);
  };

  const logicSummary =
    draft.logic_summary?.trim() ||
    config.logic_summary?.trim() ||
    buildLogicSummaryFromBrief(draft) ||
    buildLogicSummaryFromBrief(config) ||
    "No pudimos generar un resumen. Revisá los detalles técnicos abajo o usá el chat para corregir.";

  const handleConfirm = () => {
    if (extracting) return;
    // Sincroniza `seasons` (nombres) con `seasons_detail` para que el backend
    // tenga ambas representaciones coherentes.
    const seasonNames = draft.seasons_detail
      .map((s) => s.name?.trim())
      .filter((s): s is string => !!s);
    onConfirm(
      {
        ...draft,
        seasons: seasonNames.length > 0 ? seasonNames : draft.seasons,
        // El total base calculado es la meta de completitud que recibe Opus
        // (genera filas base; el servidor agrega persona adicional encima).
        expected_row_estimate:
          baseTotal > 0 ? baseTotal : draft.expected_row_estimate,
      },
      catalog,
    );
  };

  return (
    <div className="px-5 sm:px-8 py-7 space-y-5">
      {/* SECCIÓN 1 — Resumen inteligente */}
      <div className="rounded-xl border border-primary/25 bg-gradient-to-br from-primary/8 via-card/80 to-card/60 shadow-sm">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-primary/15">
          <Brain className="h-4 w-4 text-primary shrink-0" />
          <p className="text-[13px] font-semibold text-foreground">
            Lo que entendí del documento
          </p>
        </header>
        <div className="px-4 py-4">
          {/* Contenedor de alto FIJO/consistente: el análisis inicial y cada
              corrección se muestran en el mismo bloque, mismo tamaño, con
              scroll interno si el contenido es largo. */}
          <div className="min-h-[280px] max-h-[480px] overflow-y-auto pr-1">
            {isRefining ? (
              <div className="flex h-[280px] items-center justify-center gap-2 text-[13px] text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Reanalizando según tus correcciones…
              </div>
            ) : (
              <LogicSummaryView summary={logicSummary} />
            )}
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Fuente:{" "}
            <span className="text-foreground/80">{meta.filename}</span>
            {meta.model ? ` · ${meta.model}` : null}
          </p>
        </div>
      </div>

      {/* SECCIÓN 2 — Chat de feedback */}
      <div className="rounded-xl border border-border bg-card/60">
        <header className="px-4 py-3 border-b border-border/60">
          <p className="text-[12.5px] font-semibold text-foreground">
            ¿Algo está mal o quieres ajustar algo? Cuéntame
          </p>
        </header>
        <div className="px-4 py-3 space-y-3">
          {chatHistory.length > 0 && (
            <div className="space-y-4">
              {chatHistory.map((msg, i) =>
                msg.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[92%] rounded-lg border border-primary/20 bg-primary/15 px-3 py-2 text-[13px] leading-relaxed text-foreground whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  // Respuesta del agente = análisis regenerado. Se muestra con
                  // la MISMA estructura y tamaño que el resumen de arriba.
                  <div
                    key={i}
                    className="rounded-xl border border-primary/25 bg-gradient-to-br from-primary/8 via-card/80 to-card/60 shadow-sm"
                  >
                    <header className="flex items-center gap-2 px-4 py-3 border-b border-primary/15">
                      <Brain className="h-4 w-4 text-primary shrink-0" />
                      <p className="text-[13px] font-semibold text-foreground">
                        Análisis actualizado
                      </p>
                    </header>
                    <div className="px-4 py-4">
                      <div className="min-h-[280px] max-h-[480px] overflow-y-auto pr-1">
                        <LogicSummaryView summary={msg.content} />
                      </div>
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
          <div className="space-y-2">
            <textarea
              value={feedbackInput}
              onChange={(e) => setFeedbackInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleRefine();
                }
              }}
              disabled={isRefining || extracting}
              rows={3}
              placeholder="Ej: La comisión es 20%, no 25%. La temporada alta termina el 15 de abril, no el 30..."
              className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/60 focus:bg-secondary/50 resize-y min-h-[80px] disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void handleRefine()}
              disabled={
                isRefining || extracting || feedbackInput.trim() === ""
              }
              className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-lg border border-border bg-secondary/50 text-[13px] text-foreground hover:bg-secondary/80 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRefining ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Reanalizando…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  Corregir y reanalizar
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* SECCIÓN 3 — Detalles técnicos (colapsable) */}
      <details className="group rounded-xl border border-border bg-card/40 open:bg-card/60">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-[13px] font-medium text-foreground hover:bg-secondary/30 rounded-xl transition-colors [&::-webkit-details-marker]:hidden">
          <span>Ver / editar detalles técnicos</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="px-4 pb-4 pt-1 space-y-5 border-t border-border/60">
          <div className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <p className="text-[11.5px] text-muted-foreground">
                Campos avanzados para ajustes puntuales. La mayoría de correcciones
                se pueden hacer en lenguaje natural con el chat de arriba.
              </p>
            </div>
          </div>

      {/* Clasificación de catálogo (lista-proveedores) */}
      <SectionCard
        icon={<Tags className="h-4 w-4" />}
        title="Clasificación de catálogo"
        hint="Del maestro lista-proveedores. Se repite en todas las filas (columnas A, B, C)."
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <FieldLabel>Tipo Actividad</FieldLabel>
            <TextInput
              value={catalog.tipo_actividad ?? ""}
              onChange={(v) => setCatalogField("tipo_actividad", v)}
              placeholder="Ej: Hospedaje"
            />
          </div>
          <div>
            <FieldLabel>Zona Turismo</FieldLabel>
            <TextInput
              value={catalog.zona_turismo ?? ""}
              onChange={(v) => setCatalogField("zona_turismo", v)}
              placeholder="Ej: Valle Central"
            />
          </div>
          <div>
            <FieldLabel>Proveedor (código)</FieldLabel>
            <TextInput
              value={catalog.proveedor_codigo ?? ""}
              onChange={(v) => setCatalogField("proveedor_codigo", v)}
              placeholder="Ej: GRANORO"
            />
          </div>
        </div>
        {!catalogPrefill?.proveedor_codigo && (
          <p className="text-[11.5px] text-muted-foreground">
            No se encontró el proveedor en el catálogo (o es nuevo). Completá
            estos códigos a mano si los conocés.
          </p>
        )}
      </SectionCard>

      {/* Datos del proveedor (compartidos) */}
      <SectionCard
        icon={<Building2 className="h-4 w-4" />}
        title="Datos del proveedor (compartidos)"
        hint="Estos datos son iguales en todas las filas. Confirmalos una sola vez."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <FieldLabel>Razón social</FieldLabel>
            <TextInput
              value={draft.shared_fields.proveedor ?? ""}
              onChange={(v) => setShared("proveedor", v)}
              placeholder="Ej: Breanne, S.A."
            />
          </div>
          <div>
            <FieldLabel>Nombre comercial</FieldLabel>
            <TextInput
              value={draft.shared_fields.nombre_comercial ?? ""}
              onChange={(v) => setShared("nombre_comercial", v)}
              placeholder="Ej: Hotel Grano de Oro"
            />
          </div>
          <div>
            <FieldLabel>Cédula jurídica / Tax ID</FieldLabel>
            <TextInput
              value={draft.shared_fields.cedula ?? ""}
              onChange={(v) => setShared("cedula", v)}
              placeholder="3-101-123456"
            />
          </div>
          <div>
            <FieldLabel>Tipo de negocio</FieldLabel>
            <TextInput
              value={draft.shared_fields.type_of_business ?? ""}
              onChange={(v) => setShared("type_of_business", v)}
              placeholder="Hotel"
            />
          </div>
          <div className="sm:col-span-2">
            <FieldLabel>Dirección</FieldLabel>
            <TextInput
              value={draft.shared_fields.direccion ?? ""}
              onChange={(v) => setShared("direccion", v)}
              placeholder="Calle, ciudad…"
            />
          </div>
          <div>
            <FieldLabel>Teléfono</FieldLabel>
            <TextInput
              value={draft.shared_fields.telefono ?? ""}
              onChange={(v) => setShared("telefono", v)}
              placeholder="(506) 2255-3322"
            />
          </div>
          <div>
            <FieldLabel>Email de reservas</FieldLabel>
            <TextInput
              value={draft.shared_fields.reservations_email ?? ""}
              onChange={(v) => setShared("reservations_email", v)}
              placeholder="info@hotel.com"
            />
          </div>
          <div>
            <FieldLabel>País</FieldLabel>
            <TextInput
              value={draft.shared_fields.pais ?? ""}
              onChange={(v) => setShared("pais", v)}
              placeholder="Costa Rica"
            />
          </div>
          <div>
            <FieldLabel>Estado / Provincia</FieldLabel>
            <TextInput
              value={draft.shared_fields.state_province ?? ""}
              onChange={(v) => setShared("state_province", v)}
              placeholder="San José"
            />
          </div>
          <div>
            <FieldLabel>Fecha del contrato</FieldLabel>
            <TextInput
              type="date"
              value={draft.shared_fields.fecha ?? ""}
              onChange={(v) => setShared("fecha", v)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:col-span-2">
            <div>
              <FieldLabel>Vigencia — inicio</FieldLabel>
              <TextInput
                type="date"
                value={draft.shared_fields.contract_starts ?? ""}
                onChange={(v) => setShared("contract_starts", v)}
              />
            </div>
            <div>
              <FieldLabel>Vigencia — fin</FieldLabel>
              <TextInput
                type="date"
                value={draft.shared_fields.contract_ends ?? ""}
                onChange={(v) => setShared("contract_ends", v)}
              />
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Impuestos */}
      <SectionCard
        icon={<Receipt className="h-4 w-4" />}
        title="Impuestos (IVA)"
        hint="¿Los precios del documento ya incluyen el impuesto de ventas?"
      >
        <TaxToggle
          value={draft.prices_include_tax}
          onChange={(v) => patch({ prices_include_tax: v })}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <div>
            <FieldLabel>Tasa de impuesto (%)</FieldLabel>
            <TextInput
              type="number"
              value={draft.tax_rate_pct?.toString() ?? ""}
              onChange={(v) => patch({ tax_rate_pct: numOrNull(v) })}
              placeholder="13"
            />
          </div>
          <div>
            <FieldLabel>Moneda de las tarifas</FieldLabel>
            <TextInput
              value={draft.currency ?? ""}
              onChange={(v) => patch({ currency: strOrNull(v) })}
              placeholder="USD"
            />
          </div>
        </div>
        <div>
          <FieldLabel>Nota sobre impuestos / fees</FieldLabel>
          <TextInput
            value={draft.tax_note ?? ""}
            onChange={(v) => patch({ tax_note: strOrNull(v) })}
            placeholder="Ej: No incluye 13% IVA. Sí incluye 10% servicio. Sustainability fee aparte."
          />
        </div>
      </SectionCard>

      {/* Comisión */}
      <SectionCard
        icon={<Percent className="h-4 w-4" />}
        title="Comisión"
        hint="Comisión por defecto + variaciones por sección, si las hay."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <FieldLabel>Comisión por defecto (%)</FieldLabel>
            <TextInput
              type="number"
              value={draft.commission_default_pct?.toString() ?? ""}
              onChange={(v) => patch({ commission_default_pct: numOrNull(v) })}
              placeholder="20"
            />
          </div>
          <div>
            <FieldLabel>Filas estimadas</FieldLabel>
            <TextInput
              type="number"
              value={draft.expected_row_estimate?.toString() ?? ""}
              onChange={(v) => patch({ expected_row_estimate: numOrNull(v) })}
              placeholder="21"
            />
          </div>
        </div>
        <div>
          <FieldLabel>Comisiones por sección (si varían)</FieldLabel>
          <TextInput
            value={draft.commission_summary ?? ""}
            onChange={(v) => patch({ commission_summary: strOrNull(v) })}
            placeholder="Ej: 30% hospedaje, 10% experiencias, 0% amenidades"
          />
        </div>
      </SectionCard>

      {/* Temporadas */}
      <SectionCard
        icon={<CalendarRange className="h-4 w-4" />}
        title="Temporadas y fechas"
        hint="Las fechas confirmadas acá se usan tal cual en season_starts / season_ends."
      >
        {draft.seasons_detail.length === 0 && (
          <p className="text-[12px] text-muted-foreground">
            No se detectaron temporadas con fechas. Agregalas si el contrato
            las define.
          </p>
        )}
        <div className="space-y-2.5">
          {draft.seasons_detail.map((s, i) => (
            <div
              key={i}
              className="rounded-lg border border-border/60 bg-secondary/20 p-2.5"
            >
              <div className="flex items-center gap-2 mb-2">
                <TextInput
                  value={s.name ?? ""}
                  onChange={(v) => setSeason(i, { name: v })}
                  placeholder="Nombre de temporada (ej. High Season)"
                />
                <button
                  type="button"
                  onClick={() => removeSeason(i)}
                  aria-label="Quitar temporada"
                  className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <FieldLabel>Inicio</FieldLabel>
                  <TextInput
                    type="date"
                    value={s.starts ?? ""}
                    onChange={(v) => setSeason(i, { starts: v })}
                  />
                </div>
                <div>
                  <FieldLabel>Fin</FieldLabel>
                  <TextInput
                    type="date"
                    value={s.ends ?? ""}
                    onChange={(v) => setSeason(i, { ends: v })}
                  />
                </div>
              </div>
              {s.raw_range && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Rango original: {s.raw_range}
                </p>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addSeason}
          className="inline-flex items-center gap-1.5 text-[12px] text-primary hover:text-primary/80 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" /> Agregar temporada
        </button>
      </SectionCard>

      {/* Plan de filas (cuántas líneas tendrá el Excel) */}
      <SectionCard
        icon={<Calculator className="h-4 w-4" />}
        title="Plan de filas (líneas del Excel)"
        hint="Cuántas combinaciones generará Opus. Ajustá los números si el inventario está incompleto."
      >
        <div className="grid grid-cols-3 gap-3">
          <div>
            <FieldLabel>Categorías</FieldLabel>
            <TextInput
              type="number"
              value={String(planCats)}
              onChange={(v) => setPlanCats(Math.max(0, Number(numOrNull(v) ?? 0)))}
              placeholder="8"
            />
          </div>
          <div>
            <FieldLabel>Ocupaciones / categoría</FieldLabel>
            <TextInput
              type="number"
              value={String(planOcc)}
              onChange={(v) => setPlanOcc(Math.max(0, Number(numOrNull(v) ?? 0)))}
              placeholder="1"
            />
          </div>
          <div>
            <FieldLabel>Temporadas</FieldLabel>
            <div className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-[13px] text-muted-foreground">
              {planSeasons}
              <span className="ml-1 text-[11px] opacity-70">(de arriba)</span>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-primary/30 bg-primary/5 px-3.5 py-3 space-y-1.5">
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted-foreground">Por temporada</span>
            <span className="text-foreground tabular-nums">
              {planCats} × {planOcc} ={" "}
              <span className="font-semibold">{perSeasonCombos}</span> combinaciones
            </span>
          </div>
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted-foreground">Combinaciones base (total)</span>
            <span className="text-foreground tabular-nums">
              {planSeasons} × {perSeasonCombos} ={" "}
              <span className="font-semibold">{baseTotal}</span>
            </span>
          </div>
          {hasAddl && (
            <div className="flex items-center justify-between text-[12.5px]">
              <span className="text-muted-foreground">
                + filas 3era/4ta persona (auto)
              </span>
              <span className="text-foreground tabular-nums">≈ {expansionRows}</span>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-border/60 pt-1.5 text-[13px]">
            <span className="font-semibold text-foreground">
              Líneas estimadas del Excel
            </span>
            <span className="font-bold text-primary tabular-nums">
              ≈ {finalEstimate}
            </span>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Opus apunta a generar las {baseTotal} combinaciones base
          {hasAddl
            ? "; las filas de persona adicional se calculan automáticamente."
            : "."}
        </p>
      </SectionCard>

      {/* Persona adicional */}
      <SectionCard
        icon={<UserPlus className="h-4 w-4" />}
        title="Persona adicional"
        hint="Tarifas de 3era/4ta persona — generan filas triples/cuádruples."
      >
        {draft.additional_person.length === 0 && (
          <p className="text-[12px] text-muted-foreground">
            No se detectaron tarifas por persona adicional.
          </p>
        )}
        <div className="space-y-2.5">
          {draft.additional_person.map((a, i) => (
            <div
              key={i}
              className="rounded-lg border border-border/60 bg-secondary/20 p-2.5 space-y-2"
            >
              <div className="flex items-center gap-2">
                <TextInput
                  value={a.scope ?? ""}
                  onChange={(v) => setAddl(i, { scope: v })}
                  placeholder="Aplica a (paquete / temporada)"
                />
                <button
                  type="button"
                  onClick={() => removeAddl(i)}
                  aria-label="Quitar tarifa"
                  className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <FieldLabel>Rack</FieldLabel>
                  <TextInput
                    value={a.rack ?? ""}
                    onChange={(v) => setAddl(i, { rack: v })}
                    placeholder="$46"
                  />
                </div>
                <div>
                  <FieldLabel>Neto</FieldLabel>
                  <TextInput
                    value={a.net ?? ""}
                    onChange={(v) => setAddl(i, { net: v })}
                    placeholder="$37"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addAddl}
          className="inline-flex items-center gap-1.5 text-[12px] text-primary hover:text-primary/80 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" /> Agregar tarifa
        </button>
      </SectionCard>

      {/* Cuentas bancarias */}
      <SectionCard
        icon={<Banknote className="h-4 w-4" />}
        title="Cuentas bancarias"
        hint="Hasta 3 caben en la plantilla. La primera va a los campos compartidos."
      >
        {draft.bank_accounts.length === 0 && (
          <p className="text-[12px] text-muted-foreground">
            No se detectaron cuentas bancarias.
          </p>
        )}
        <div className="space-y-2.5">
          {draft.bank_accounts.map((b, i) => (
            <div
              key={i}
              className="rounded-lg border border-border/60 bg-secondary/20 p-2.5 space-y-2"
            >
              <div className="flex items-center gap-2">
                <TextInput
                  value={b.bank ?? ""}
                  onChange={(v) => setBank(i, { bank: v })}
                  placeholder="Banco"
                />
                <button
                  type="button"
                  onClick={() => removeBank(i)}
                  aria-label="Quitar cuenta"
                  className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="sm:col-span-2">
                  <FieldLabel>Número / IBAN</FieldLabel>
                  <TextInput
                    value={b.account_number ?? ""}
                    onChange={(v) => setBank(i, { account_number: v })}
                    placeholder="CR00 0000 0000 0000"
                  />
                </div>
                <div>
                  <FieldLabel>Moneda</FieldLabel>
                  <TextInput
                    value={b.currency ?? ""}
                    onChange={(v) => setBank(i, { currency: v })}
                    placeholder="USD"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addBank}
          className="inline-flex items-center gap-1.5 text-[12px] text-primary hover:text-primary/80 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" /> Agregar cuenta
        </button>
      </SectionCard>

      {/* Otras reglas */}
      <SectionCard
        icon={<Sparkles className="h-4 w-4" />}
        title="Otras reglas globales"
        hint="Comidas, periodos especiales y notas que aplican a todo el contrato."
      >
        <div>
          <FieldLabel>Plan de comidas</FieldLabel>
          <TextInput
            value={draft.meal_plan_note ?? ""}
            onChange={(v) => patch({ meal_plan_note: strOrNull(v) })}
            placeholder="Ej: Desayuno incluido. Almuerzo/cena opcionales."
          />
        </div>
        <div>
          <FieldLabel>Periodos especiales (Navidad, peak…)</FieldLabel>
          <TextInput
            value={draft.special_periods_note ?? ""}
            onChange={(v) => patch({ special_periods_note: strOrNull(v) })}
            placeholder="Ej: Reservas 15-dic a 15-ene: prepago 14-oct, cancelación 30 días antes."
          />
        </div>
        <div>
          <FieldLabel>Notas adicionales</FieldLabel>
          <TextInput
            value={draft.notes ?? ""}
            onChange={(v) => patch({ notes: strOrNull(v) })}
            placeholder="Ej: niños menores de 2 años sin costo; estadía mínima 3 noches en peak."
          />
        </div>
      </SectionCard>

        </div>
      </details>

      {showActions && serverError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{serverError}</span>
        </div>
      )}

      {showActions && (
      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={onBack}
          disabled={extracting || isRefining}
          className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-border bg-secondary/40 text-[13.5px] text-foreground hover:bg-secondary/70 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowLeft className="w-4 h-4" />
          Volver
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={extracting || isRefining}
          className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
        >
          {extracting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Extrayendo tarifas…
            </>
          ) : (
            <>
              <Check className="w-4 h-4" />
              Confirmar y extraer tarifas
            </>
          )}
        </button>
      </div>
      )}
    </div>
  );
}
