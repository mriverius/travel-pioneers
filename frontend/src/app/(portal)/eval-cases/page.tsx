"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FlaskConical,
  FolderGit2,
  Play,
  RefreshCcw,
  Trash2,
  XCircle,
} from "lucide-react";
import AdminGuard from "@/components/admin-guard";
import { InlineError, ModalHeader, ModalShell } from "@/components/ui/modal";
import {
  ApiError,
  api,
  type EvalCase,
  type EvalCaseResult,
  type EvalRunSummary,
} from "@/lib/api";

/**
 * Casos de prueba del lector sin IA (pre-scan).
 *
 * Un caso = los documentos de un contrato + lo que el lector debe encontrar
 * en ellos. «Correr verificación» pasa el lector por todos los casos y
 * compara, en segundos y sin IA. Es el cinturón de seguridad para cambiar el
 * lector: si un arreglo para un proveedor rompe a otro, aparece aquí.
 *
 * Los casos del repositorio (carpeta `backend/evals/prescan`) los mantiene
 * el equipo técnico; los demás se guardan desde el Paso 4 del agente.
 */

export default function EvalCasesPage() {
  return (
    <AdminGuard>
      <EvalCasesPageContent />
    </AdminGuard>
  );
}

function EvalCasesPageContent() {
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [runs, setRuns] = useState<EvalRunSummary[]>([]);
  const [limits, setLimits] = useState<{ maxDbCases: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<{ run: EvalRunSummary; results: EvalCaseResult[] } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<EvalCase | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.evals.list();
      setCases(data.cases);
      setRuns(data.runs);
      setLimits(data.limits);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los casos de prueba.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.evals
      .list()
      .then((data) => {
        if (cancelled) return;
        setCases(data.cases);
        setRuns(data.runs);
        setLimits(data.limits);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "No se pudieron cargar los casos de prueba.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runAll = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const data = await api.evals.run();
      setLastRun(data);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "La verificación falló.");
    } finally {
      setRunning(false);
    }
  };

  const repoCases = cases.filter((c) => c.source === "repo");
  const dbCases = cases.filter((c) => c.source === "db");
  const latest = runs[0] ?? null;
  const okCount = cases.filter((c) => c.lastResult?.ok).length;
  const failCount = cases.filter((c) => c.lastResult && !c.lastResult.ok).length;
  const neverRun = cases.filter((c) => !c.lastResult).length;
  const resultFor = (slug: string): EvalCaseResult | undefined => lastRun?.results.find((r) => r.slug === slug);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 pl-12 lg:pl-0">
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-foreground">Casos de prueba</h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Contratos de referencia con los que se verifica el lector sin IA cada vez que alguien lo
            modifica. No hacen al sistema más inteligente: evitan que un arreglo para un proveedor rompa
            a otro. Valen por diversidad de formato, no por cantidad.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start">
          <button
            type="button"
            onClick={() => void runAll()}
            disabled={running || cases.length === 0}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-md gradient-primary text-white text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {running ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? "Verificando…" : "Correr verificación"}
          </button>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void load();
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

      {/* Estado */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Casos" value={`${cases.length}`} sub={`${repoCases.length} del repositorio · ${dbCases.length} del portal`} />
        <Stat label="Pasan" value={`${okCount}`} tone={failCount === 0 && okCount > 0 ? "good" : "muted"} sub={neverRun > 0 ? `${neverRun} sin correr` : "última corrida"} />
        <Stat label="Fallan" value={`${failCount}`} tone={failCount > 0 ? "bad" : "muted"} sub={failCount > 0 ? "revisar con el equipo técnico" : "ninguno"} />
        <Stat
          label="Última corrida"
          value={latest ? fmtDate(latest.ranAt) : "—"}
          sub={latest ? `${latest.totalChecks - latest.failedChecks}/${latest.totalChecks} verificaciones` : "nunca"}
        />
      </section>

      {lastRun && (
        <div
          className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px] ${
            lastRun.run.failedChecks === 0
              ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-100"
              : "border-red-500/40 bg-red-500/5 text-red-100"
          }`}
        >
          {lastRun.run.failedChecks === 0 ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" /> : <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />}
          <span>
            Verificación terminada en {((lastRun.run.ms ?? 0) / 1000).toFixed(1)} s: {lastRun.run.totalChecks - lastRun.run.failedChecks} de{" "}
            {lastRun.run.totalChecks} verificaciones correctas en {lastRun.run.totalCases} caso(s).
            {lastRun.run.failedChecks > 0 && " Abre los casos en rojo para ver qué esperaba y qué encontró."}
          </span>
        </div>
      )}

      {/* Lista */}
      <section className="bg-card/80 border border-border rounded-xl overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-foreground">Casos</h2>
          {limits && (
            <span className="text-[11.5px] text-muted-foreground">
              {dbCases.length}/{limits.maxDbCases} del portal
            </span>
          )}
        </div>
        {loading && cases.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13px] text-muted-foreground">Cargando…</p>
        ) : cases.length === 0 ? (
          <div className="px-5 py-10 text-center space-y-1.5">
            <FlaskConical className="mx-auto h-6 w-6 text-primary" />
            <p className="text-[13.5px] text-foreground">No hay casos de prueba.</p>
            <p className="text-[12.5px] text-muted-foreground max-w-md mx-auto">
              Se agregan desde el Paso 4 del agente, al terminar un contrato cuyo formato no esté cubierto.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {cases.map((c) => {
              const live = resultFor(c.slug);
              const status = live
                ? { ok: !live.error && live.checks.every((x) => x.ok), failed: live.checks.filter((x) => !x.ok).length, passed: live.checks.filter((x) => x.ok).length, error: live.error }
                : c.lastResult
                  ? { ok: c.lastResult.ok, failed: c.lastResult.failed, passed: c.lastResult.passed, error: c.lastResult.error }
                  : null;
              const isOpen = expanded === c.slug;
              return (
                <li key={c.slug} className="px-4 sm:px-5 py-3">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 shrink-0">
                      {status === null ? (
                        <span className="inline-block h-4 w-4 rounded-full border border-border" title="Sin correr" />
                      ) : status.ok ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-400" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <p className="text-[13.5px] font-medium text-foreground">{c.title}</p>
                        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                          {c.source === "repo" ? <FolderGit2 className="h-3 w-3" /> : <FlaskConical className="h-3 w-3" />}
                          {c.source === "repo" ? "repositorio" : "portal"}
                        </span>
                        {c.supplierCodigo && <span className="font-mono text-[11px] text-muted-foreground">{c.supplierCodigo}</span>}
                        {c.layoutFamily && <span className="text-[11.5px] text-primary/90">{c.layoutFamily}</span>}
                      </div>
                      <p className="text-[12px] text-muted-foreground truncate">
                        {c.files.map((f) => f.filename).join(" · ")} · {Object.keys(c.expected).filter((k) => k !== "suppliers").length} valores esperados
                        {status ? ` · ${status.passed} ok${status.failed > 0 ? `, ${status.failed} fallan` : ""}` : " · sin correr"}
                        {status?.error ? ` · error: ${status.error}` : ""}
                      </p>
                      {c.notes && <p className="text-[12px] text-muted-foreground/90 mt-0.5">{c.notes}</p>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {live && (
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : c.slug)}
                          className="inline-flex items-center gap-1 h-8 px-2 rounded-md text-[12px] text-muted-foreground hover:text-foreground hover:bg-secondary/60"
                        >
                          Detalle
                          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                        </button>
                      )}
                      {c.source === "db" && (
                        <button
                          type="button"
                          onClick={() => setPendingDelete(c)}
                          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          aria-label="Eliminar caso"
                          title="Eliminar caso"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  {isOpen && live && (
                    <ul className="mt-2 ml-7 space-y-1">
                      {live.checks.map((x) => (
                        <li key={x.name} className={`text-[12px] ${x.ok ? "text-muted-foreground" : "text-red-200"}`}>
                          <span className="font-mono">{x.ok ? "✔" : "✖"} {x.name}</span>
                          {!x.ok && (
                            <span className="block ml-5 text-[11.5px]">
                              esperado <code className="text-foreground">{JSON.stringify(x.expected)}</code> · encontrado{" "}
                              <code className="text-foreground">{JSON.stringify(x.actual)}</code>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="rounded-xl border border-border bg-secondary/20 px-4 py-3 text-[12.5px] text-muted-foreground space-y-1">
        <p className="flex items-center gap-1.5 text-foreground font-medium">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          Qué hacer cuando un caso falla
        </p>
        <p>
          Un caso en rojo no significa que el agente produzca un Excel malo: el lector sin IA es prioridad
          media y sus errores quedan visibles en el Paso 2. Significa que el lector dejó de entender ese
          formato y alguien del equipo técnico debe ajustarlo; copia el detalle (esperado vs. encontrado) al
          pedirlo.
        </p>
      </div>

      {pendingDelete && (
        <ConfirmDeleteDialog
          evalCase={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onConfirm={async () => {
            if (!pendingDelete.id) return;
            await api.evals.remove(pendingDelete.id);
            setCases((prev) => prev.filter((x) => x.slug !== pendingDelete.slug));
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-CR", { day: "numeric", month: "short" });
}

function Stat({ label, value, sub, tone = "muted" }: { label: string; value: string; sub: string; tone?: "good" | "bad" | "muted" }) {
  const color = { good: "text-emerald-300", bad: "text-red-300", muted: "text-foreground" }[tone];
  return (
    <div className="bg-card/80 border border-border rounded-xl px-4 py-3.5">
      <p className="text-[11.5px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-[22px] font-bold mt-1 ${color}`}>{value}</p>
      <p className="text-[11.5px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function ConfirmDeleteDialog({ evalCase, onClose, onConfirm }: { evalCase: EvalCase; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (!submitting) onClose();
  };
  const handle = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo eliminar el caso.");
      setSubmitting(false);
    }
  };
  return (
    <ModalShell onClose={close} labelledBy="delete-eval-title" maxWidth="max-w-md">
      <ModalHeader id="delete-eval-title" title="Eliminar caso de prueba" onClose={close} tone="danger" />
      <div className="p-4 sm:p-6 space-y-3 text-[13px] text-foreground">
        <p>
          ¿Eliminar <span className="font-semibold">{evalCase.title}</span>? Se borran sus documentos guardados. Esta acción no se puede deshacer.
        </p>
        {error && <InlineError message={error} />}
      </div>
      <footer className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center sm:justify-end gap-2 px-4 sm:px-6 py-4 border-t border-border">
        <button type="button" onClick={close} disabled={submitting} className="px-3.5 py-2 rounded-md border border-border text-[13px] hover:bg-secondary/60 transition-colors disabled:opacity-50">
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => void handle()}
          disabled={submitting}
          autoFocus
          className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-md bg-destructive text-white text-[13px] font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50"
        >
          <Trash2 className="w-4 h-4" />
          {submitting ? "Eliminando…" : "Eliminar"}
        </button>
      </footer>
    </ModalShell>
  );
}
