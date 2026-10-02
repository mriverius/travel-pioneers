"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  BookMarked,
  Check,
  Lightbulb,
  Pencil,
  Plus,
  RefreshCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  InlineError,
  ModalHeader,
  ModalShell,
} from "@/components/ui/modal";
import AdminGuard from "@/components/admin-guard";
import { ApiError, api, type AgentRule, type AgentRuleSuggestion } from "@/lib/api";

/**
 * Reglas permanentes del agente — la memoria curada de la agencia.
 *
 * Cada regla activa se inyecta en TODAS las extracciones como instrucción de
 * prioridad alta (debajo de los comentarios del run, encima del documento).
 * Es el lugar para el conocimiento que hoy vive en la cabeza del operador:
 * "Los hoteles de Guanacaste siempre cotizan sin impuesto", "Si el contrato
 * dice 'per person' la ocupación es SGL/DBL", etc.
 */

const MAX_RULE_LENGTH = 500;

const EXAMPLES = [
  "Si un contrato en Costa Rica no menciona el impuesto, asumir que los precios NO incluyen el 13% de IVA y anotarlo en notes.",
  "Las tarifas con nombre «Rack» son precio público; «Net» o «Neto» ya tienen la comisión descontada (porcentaje_comision = 0).",
  "Cuando un contrato publica precios por persona en ocupación doble, la fila DBL lleva el precio por persona × 2.",
];

export default function AgentRulesPage() {
  return (
    <AdminGuard>
      <AgentRulesPageContent />
    </AdminGuard>
  );
}

function AgentRulesPageContent() {
  const [rules, setRules] = useState<AgentRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [editing, setEditing] = useState<AgentRule | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AgentRule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Sugerencias derivadas de correcciones recurrentes (sólo propone). */
  const [suggestions, setSuggestions] = useState<AgentRuleSuggestion[]>([]);
  const [thresholds, setThresholds] = useState<{ runs: number; suppliers: number } | null>(null);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<AgentRuleSuggestion | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.agentRules
      .suggestions()
      .then((d) => {
        if (cancelled) return;
        setSuggestions(d.suggestions);
        setThresholds(d.thresholds);
      })
      .catch((err: unknown) => {
        if (!cancelled) setSuggestionsError(describeError(err, "No se pudieron cargar las sugerencias."));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = async (sug: AgentRuleSuggestion) => {
    try {
      const { suggestion } = await api.agentRules.dismissSuggestion(sug.id);
      setSuggestions((prev) => prev.map((x) => (x.id === suggestion.id ? suggestion : x)));
    } catch (err) {
      setSuggestionsError(describeError(err, "No se pudo descartar la sugerencia."));
    }
  };

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { rules: fetched } = await api.agentRules.list();
      setRules(fetched);
    } catch (err) {
      setLoadError(describeError(err, "No se pudieron cargar las reglas."));
    } finally {
      setLoading(false);
    }
  }, []);

  // Carga inicial (el estado ya arranca en loading=true; el setState ocurre
  // en el callback de la promesa, no en el cuerpo del efecto).
  useEffect(() => {
    let cancelled = false;
    api.agentRules
      .list()
      .then(({ rules: fetched }) => {
        if (!cancelled) setRules(fetched);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(describeError(err, "No se pudieron cargar las reglas."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addRule = async () => {
    const text = draft.replace(/\s+/g, " ").trim();
    if (text.length < 5 || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { rule } = await api.agentRules.create(text);
      setRules((prev) => [...prev, rule]);
      setDraft("");
    } catch (err) {
      setSaveError(describeError(err, "No se pudo guardar la regla."));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (rule: AgentRule) => {
    if (busyId) return;
    setBusyId(rule.id);
    try {
      const { rule: updated } = await api.agentRules.update(rule.id, {
        enabled: !rule.enabled,
      });
      setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setLoadError(describeError(err, "No se pudo actualizar la regla."));
    } finally {
      setBusyId(null);
    }
  };

  const enabledCount = rules.filter((r) => r.enabled).length;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 pl-12 lg:pl-0">
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-foreground">
            Reglas del agente
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Conocimiento permanente de la agencia. Cada regla activa se aplica
            en <span className="font-medium text-foreground">todas</span> las
            extracciones con prioridad alta: por encima de lo que dice el
            documento y sólo por debajo de los comentarios que el operador
            escribe en cada contrato.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading}
          className="inline-flex items-center gap-2 h-10 px-3 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-50 self-start"
          aria-label="Refrescar"
          title="Refrescar"
        >
          <RefreshCcw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>

      {loadError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
        >
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1">{loadError}</span>
          <button
            type="button"
            onClick={() => void reload()}
            className="px-2 py-0.5 rounded-md border border-destructive/40 text-[12px] hover:bg-destructive/20 transition-colors"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* Nueva regla */}
      <section className="bg-card/80 border border-border rounded-xl p-4 sm:p-5 space-y-3">
        <div className="flex items-center gap-2">
          <BookMarked className="w-4 h-4 text-primary" />
          <h2 className="text-[14px] font-semibold text-foreground">Nueva regla</h2>
          <span className="ml-auto text-[11.5px] text-muted-foreground">
            {draft.trim().length}/{MAX_RULE_LENGTH}
          </span>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, MAX_RULE_LENGTH))}
          rows={3}
          placeholder="Escribe la regla como se la dirías a un asistente nuevo. Una idea por regla, concreta y verificable."
          className="w-full rounded-md bg-input/70 border border-border px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/30 transition-colors resize-y"
        />
        {saveError && <InlineError message={saveError} />}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex flex-wrap gap-1.5 text-[11.5px] text-muted-foreground">
            <span>Ejemplos:</span>
            {EXAMPLES.map((ex, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setDraft(ex)}
                className="rounded-md border border-border px-2 py-0.5 hover:bg-secondary/60 hover:text-foreground transition-colors"
                title={ex}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void addRule()}
            disabled={saving || draft.trim().length < 5}
            className="sm:ml-auto inline-flex items-center justify-center gap-2 h-10 px-4 rounded-md gradient-primary text-white text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            {saving ? "Guardando…" : "Agregar regla"}
          </button>
        </div>
      </section>

      {/* Sugerencias */}
      <SuggestionsSection
        suggestions={suggestions}
        thresholds={thresholds}
        error={suggestionsError}
        onAccept={(s) => setAccepting(s)}
        onDismiss={(s) => void dismiss(s)}
      />

      {/* Lista */}
      <section className="bg-card/80 border border-border rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-border">
          <h2 className="text-[14px] font-semibold text-foreground">
            Reglas{" "}
            <span className="font-normal text-muted-foreground">
              · {enabledCount} activa{enabledCount === 1 ? "" : "s"} de {rules.length}
            </span>
          </h2>
        </div>
        {loading && rules.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13px] text-muted-foreground">Cargando…</p>
        ) : rules.length === 0 ? (
          <div className="px-5 py-10 text-center space-y-1.5">
            <p className="text-[13.5px] text-foreground">Todavía no hay reglas.</p>
            <p className="text-[12.5px] text-muted-foreground max-w-md mx-auto">
              Cuando corrijas lo mismo por segunda vez en un contrato, escríbelo
              aquí y el agente lo aplicará siempre.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rules.map((rule, idx) => (
              <li
                key={rule.id}
                className={`flex items-start gap-3 px-4 sm:px-5 py-3 ${rule.enabled ? "" : "opacity-60"}`}
              >
                <span className="mt-0.5 w-6 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                  {idx + 1}
                </span>
                <p className="flex-1 min-w-0 text-[13px] text-foreground whitespace-pre-wrap break-words">
                  {rule.text}
                </p>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={rule.enabled}
                    onClick={() => void toggle(rule)}
                    disabled={busyId === rule.id}
                    title={rule.enabled ? "Desactivar" : "Activar"}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors disabled:opacity-50 ${
                      rule.enabled
                        ? "bg-primary/80 border-primary"
                        : "bg-secondary border-border"
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                        rule.enabled ? "translate-x-4" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(rule)}
                    className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
                    aria-label="Editar"
                    title="Editar"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(rule)}
                    className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    aria-label="Eliminar"
                    title="Eliminar"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-[12px] text-muted-foreground">
        Consejo: una regla debe ser cierta para <em>todos</em> los contratos.
        Lo que aplica a un solo proveedor va en «Comentarios adicionales» de ese
        contrato, no aquí.
      </p>

      {accepting && (
        <AcceptSuggestionDialog
          suggestion={accepting}
          onClose={() => setAccepting(null)}
          onAccepted={(suggestion, rule) => {
            setSuggestions((prev) => prev.map((x) => (x.id === suggestion.id ? suggestion : x)));
            setRules((prev) => [...prev, rule]);
          }}
        />
      )}
      {editing && (
        <EditRuleDialog
          rule={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
          }}
        />
      )}
      {pendingDelete && (
        <ConfirmDeleteDialog
          rule={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onConfirm={async () => {
            await api.agentRules.remove(pendingDelete.id);
            setRules((prev) => prev.filter((r) => r.id !== pendingDelete.id));
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Dialogs                                   */
/* -------------------------------------------------------------------------- */

function EditRuleDialog({
  rule,
  onClose,
  onSaved,
}: {
  rule: AgentRule;
  onClose: () => void;
  onSaved: (r: AgentRule) => void;
}) {
  const [text, setText] = useState(rule.text);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    if (!submitting) onClose();
  }, [submitting, onClose]);

  const save = async () => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length < 5) {
      setError("La regla es demasiado corta.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { rule: updated } = await api.agentRules.update(rule.id, { text: t });
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(describeError(err, "No se pudo guardar la regla."));
      setSubmitting(false);
    }
  };

  return (
    <ModalShell onClose={close} labelledBy="edit-rule-title" maxWidth="max-w-lg">
      <ModalHeader id="edit-rule-title" title="Editar regla" onClose={close} />
      <div className="p-4 sm:p-6 space-y-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_RULE_LENGTH))}
          rows={4}
          autoFocus
          className="w-full rounded-md bg-input/70 border border-border px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/30 transition-colors resize-y"
        />
        <p className="text-right text-[11.5px] text-muted-foreground">
          {text.trim().length}/{MAX_RULE_LENGTH}
        </p>
        {error && <InlineError message={error} />}
      </div>
      <footer className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center sm:justify-end gap-2 px-4 sm:px-6 py-4 border-t border-border">
        <button
          type="button"
          onClick={close}
          disabled={submitting}
          className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-md border border-border text-[13px] hover:bg-secondary/60 transition-colors disabled:opacity-50"
        >
          <X className="w-4 h-4" />
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={submitting}
          className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-md gradient-primary text-white text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <Check className="w-4 h-4" />
          {submitting ? "Guardando…" : "Guardar"}
        </button>
      </footer>
    </ModalShell>
  );
}

function ConfirmDeleteDialog({
  rule,
  onClose,
  onConfirm,
}: {
  rule: AgentRule;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    if (!submitting) onClose();
  }, [submitting, onClose]);

  const handleConfirm = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(describeError(err, "No se pudo eliminar la regla."));
      setSubmitting(false);
    }
  };

  return (
    <ModalShell onClose={close} labelledBy="delete-rule-title" maxWidth="max-w-md">
      <ModalHeader id="delete-rule-title" title="Eliminar regla" onClose={close} tone="danger" />
      <div className="p-4 sm:p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-destructive/10 border border-destructive/30 flex items-center justify-center text-destructive shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="min-w-0 text-[13.5px] text-foreground">
            <p>¿Seguro que quieres eliminar esta regla?</p>
            <p className="mt-1.5 text-[12.5px] text-muted-foreground">
              Dejará de aplicarse en las próximas extracciones. Si sólo quieres
              pausarla, desactívala en lugar de eliminarla.
            </p>
          </div>
        </div>
        <blockquote className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-[12.5px] text-foreground whitespace-pre-wrap">
          {rule.text}
        </blockquote>
        {error && <InlineError message={error} />}
      </div>
      <footer className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center sm:justify-end gap-2 px-4 sm:px-6 py-4 border-t border-border">
        <button
          type="button"
          onClick={close}
          disabled={submitting}
          className="px-3.5 py-2 rounded-md border border-border text-[13px] hover:bg-secondary/60 transition-colors disabled:opacity-50"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={submitting}
          autoFocus
          className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-md bg-destructive text-white text-[13px] font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50"
        >
          {submitting ? (
            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4" />
          )}
          Eliminar regla
        </button>
      </footer>
    </ModalShell>
  );
}

/* -------------------------------------------------------------------------- */
/*                                Sugerencias                                 */
/* -------------------------------------------------------------------------- */

function humanValue(v: string | null): string {
  if (v === null || v === "") return "vacío";
  if (v === "true") return "sí";
  if (v === "false") return "no";
  return v;
}

/**
 * El sistema detecta que la MISMA corrección se repitió en varios contratos
 * de proveedores distintos y la propone como regla. No decide: un admin
 * acepta (editando el texto si hace falta) o descarta. Lo descartado no
 * vuelve a proponerse.
 */
function SuggestionsSection({
  suggestions,
  thresholds,
  error,
  onAccept,
  onDismiss,
}: {
  suggestions: AgentRuleSuggestion[];
  thresholds: { runs: number; suppliers: number } | null;
  error: string | null;
  onAccept: (s: AgentRuleSuggestion) => void;
  onDismiss: (s: AgentRuleSuggestion) => void;
}) {
  const pending = suggestions.filter((s) => s.status === "pending");
  const decided = suggestions.filter((s) => s.status !== "pending");
  return (
    <section className="bg-card/80 border border-primary/25 rounded-xl p-4 sm:p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Lightbulb className="w-4 h-4 text-primary" />
        <h2 className="text-[14px] font-semibold text-foreground">Sugerencias del sistema</h2>
        <span className="ml-auto text-[11.5px] text-muted-foreground">
          {pending.length} pendiente{pending.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="text-[12.5px] text-muted-foreground">
        Cuando la misma corrección se repite en{" "}
        {thresholds ? `${thresholds.runs} contratos de ${thresholds.suppliers} proveedores distintos` : "varios contratos"}, aparece
        aquí. El sistema sólo propone: tú decides si es una regla universal o una casualidad.
      </p>
      {error && <InlineError message={error} />}
      {pending.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground italic">
          Sin sugerencias por ahora. Se generan solas a partir de los contratos que apruebes.
        </p>
      ) : (
        <ul className="space-y-2">
          {pending.map((s) => (
            <li key={s.id} className="rounded-lg border border-border bg-secondary/30 px-3 py-2.5 space-y-1.5">
              <p className="text-[13px] text-foreground">
                <span className="font-medium">{s.field}</span>:{" "}
                <span className="line-through opacity-60">{humanValue(s.before)}</span> → {humanValue(s.after)}
              </p>
              <p className="text-[12px] text-muted-foreground">
                {s.evidence.runs} contrato(s) · {s.evidence.suppliers.join(", ")}
              </p>
              <p className="text-[12.5px] text-foreground/90 border-l-2 border-primary/40 pl-2">{s.proposedText}</p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => onAccept(s)}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md gradient-primary text-white text-[12px] font-medium hover:opacity-90"
                >
                  <Check className="w-3.5 h-3.5" />
                  Revisar y aceptar
                </button>
                <button
                  type="button"
                  onClick={() => onDismiss(s)}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border text-[12px] text-muted-foreground hover:text-foreground hover:bg-secondary/60"
                >
                  <X className="w-3.5 h-3.5" />
                  Descartar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <details className="text-[12px] text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">Decididas ({decided.length})</summary>
          <ul className="mt-1.5 space-y-1">
            {decided.map((s) => (
              <li key={s.id}>
                <span className={s.status === "accepted" ? "text-emerald-300" : "text-muted-foreground"}>
                  {s.status === "accepted" ? "aceptada" : "descartada"}
                </span>{" "}
                · {s.field}: {humanValue(s.before)} → {humanValue(s.after)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function AcceptSuggestionDialog({
  suggestion,
  onClose,
  onAccepted,
}: {
  suggestion: AgentRuleSuggestion;
  onClose: () => void;
  onAccepted: (s: AgentRuleSuggestion, rule: AgentRule) => void;
}) {
  const [text, setText] = useState(suggestion.proposedText);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => {
    if (!submitting) onClose();
  }, [submitting, onClose]);

  const accept = async () => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length < 5) {
      setError("La regla es demasiado corta.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { suggestion: updated, rule } = await api.agentRules.acceptSuggestion(suggestion.id, t);
      onAccepted(updated, rule);
      onClose();
    } catch (err) {
      setError(describeError(err, "No se pudo aceptar la sugerencia."));
      setSubmitting(false);
    }
  };

  return (
    <ModalShell onClose={close} labelledBy="accept-sug-title" maxWidth="max-w-lg">
      <ModalHeader id="accept-sug-title" title="Convertir en regla" onClose={close} />
      <div className="p-4 sm:p-6 space-y-3">
        <p className="text-[12.5px] text-muted-foreground">
          Escribe la regla como condición general («cuando…, entonces…»). Una regla aplica a{" "}
          <em>todos</em> los contratos; si sólo vale para estos proveedores, descártala.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_RULE_LENGTH))}
          rows={5}
          autoFocus
          className="w-full rounded-md bg-input/70 border border-border px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/30 transition-colors resize-y"
        />
        <p className="text-right text-[11.5px] text-muted-foreground">{text.trim().length}/{MAX_RULE_LENGTH}</p>
        {error && <InlineError message={error} />}
      </div>
      <footer className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center sm:justify-end gap-2 px-4 sm:px-6 py-4 border-t border-border">
        <button type="button" onClick={close} disabled={submitting} className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-md border border-border text-[13px] hover:bg-secondary/60 transition-colors disabled:opacity-50">
          <X className="w-4 h-4" />
          Cancelar
        </button>
        <button type="button" onClick={() => void accept()} disabled={submitting} className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-md gradient-primary text-white text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
          <Check className="w-4 h-4" />
          {submitting ? "Guardando…" : "Crear regla"}
        </button>
      </footer>
    </ModalShell>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.details.length > 0) {
      return err.details.map((d) => d.message).join(", ");
    }
    return err.message || fallback;
  }
  if (err instanceof TypeError) {
    return "No se pudo contactar con el servidor. Revisa tu conexión.";
  }
  return fallback;
}
