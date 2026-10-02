"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, FlaskConical, X } from "lucide-react";
import {
  api,
  ApiError,
  type ContractConfigVariables,
  type PreScanResult,
} from "@/lib/api";
import { Field, InlineError, ModalHeader, ModalShell, inputClass } from "@/components/ui/modal";
import type { ApprovedPayload } from "./workflow";

/**
 * Paso 4 (admins): convierte el contrato recién aprobado en un caso de
 * prueba del pre-scan. El `expected` se deriva de lo que la PERSONA aprobó
 * (tabla + brief confirmado), no de lo que el pre-scan leyó — así el caso
 * verifica al pre-scan en vez de confirmarlo.
 *
 * Los casos valen por diversidad de formato, no por cantidad: la tarjeta lo
 * recuerda y pide una "familia de formato" para que el equipo piense en
 * términos de cobertura.
 */

const MAX_FILE_BYTES = 8 * 1024 * 1024;

const FAMILY_SUGGESTIONS = [
  "Hotel · tabla por temporada",
  "Hotel · tarifa única anual",
  "Tour · precio por persona",
  "Transporte · por tramo",
  "Paquete / DMC",
  "Carta de tarifas en Word",
  "Tarifario en Excel",
  "Escaneado (sin texto)",
];

function isoDate(v: string | null | undefined): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function currencyCode(v: string | null | undefined): string | null {
  if (!v) return null;
  const u = v.toUpperCase();
  if (/USD|D[OÓ]LAR|\$/.test(u)) return "USD";
  if (/CRC|COL[OÓ]N|₡/.test(u)) return "CRC";
  if (/EUR|€/.test(u)) return "EUR";
  return /^[A-Z]{3}$/.test(u) ? u : null;
}

export function buildExpectedFromApproved(
  payload: ApprovedPayload,
  brief: ContractConfigVariables | null,
  supplierCodigo: string | null,
): Record<string, unknown> {
  const exp: Record<string, unknown> = {};
  if (supplierCodigo) exp.supplier = { codigo: supplierCodigo };
  const cur = currencyCode(payload.sharedFields.tipo_moneda) ?? currencyCode(brief?.currency);
  if (cur) exp.currencies = [cur];
  if (payload.sharedFields.cedula) exp.cedulas = [payload.sharedFields.cedula];
  const start = isoDate(payload.sharedFields.contract_starts);
  const end = isoDate(payload.sharedFields.contract_ends);
  if (start && end) exp.validity = { start, end };
  if (brief) {
    if (brief.prices_include_tax !== null || brief.tax_rate_pct !== null) {
      exp.taxes = {
        ...(brief.prices_include_tax !== null ? { included: brief.prices_include_tax } : {}),
        ...(brief.tax_rate_pct !== null ? { percent: brief.tax_rate_pct } : {}),
      };
    }
    if (brief.commission_default_pct !== null) {
      exp.commission =
        brief.commission_default_pct === 0 ? { net: true } : { net: false, percent: brief.commission_default_pct };
    }
  }
  const seasonNames = new Set(payload.rows.map((r) => r.season_name?.trim()).filter((x): x is string => !!x));
  if (seasonNames.size > 0) exp.seasonsCount = seasonNames.size;
  if (payload.sharedFields.reservations_email) exp.emails = [payload.sharedFields.reservations_email];
  return exp;
}

export function SaveEvalCaseCard({
  files,
  payload,
  brief,
  preScan,
  supplierCodigo,
}: {
  files: File[];
  payload: ApprovedPayload;
  brief: ContractConfigVariables | null;
  preScan: PreScanResult | null;
  supplierCodigo: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<{ slug: string } | null>(null);

  const tooBig = files.filter((f) => f.size > MAX_FILE_BYTES);
  const noText = preScan ? !preScan.documents.some((d) => d.textAvailable) : false;

  if (saved) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-[13px] text-emerald-100">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
        <span>
          Caso de prueba <span className="font-mono">{saved.slug}</span> guardado.{" "}
          <Link href="/eval-cases" className="underline underline-offset-2 hover:text-foreground">
            Ver casos de prueba
          </Link>
          .
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="text-[12.5px]">
            <p className="font-semibold text-foreground">¿Este formato de contrato es nuevo para el sistema?</p>
            <p className="text-muted-foreground">
              Guárdalo como caso de prueba: cada cambio al lector sin IA se verificará contra él.
              Vale por diversidad de formato, no por cantidad (una vez por familia basta).
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={files.length === 0 || tooBig.length > 0 || noText}
          title={
            tooBig.length > 0
              ? `Archivos mayores a 8 MB: ${tooBig.map((f) => f.name).join(", ")}`
              : noText
                ? "Documentos sin texto legible: el pre-scan no tiene nada que verificar."
                : undefined
          }
          className="inline-flex shrink-0 items-center justify-center gap-2 h-10 px-4 rounded-md border border-primary/40 bg-primary/10 text-[13px] text-foreground hover:bg-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <FlaskConical className="h-4 w-4" />
          Guardar como caso de prueba
        </button>
      </div>
      {open && (
        <SaveEvalCaseDialog
          files={files}
          payload={payload}
          brief={brief}
          supplierCodigo={supplierCodigo}
          onClose={() => setOpen(false)}
          onSaved={(slug) => {
            setSaved({ slug });
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function SaveEvalCaseDialog({
  files,
  payload,
  brief,
  supplierCodigo,
  onClose,
  onSaved,
}: {
  files: File[];
  payload: ApprovedPayload;
  brief: ContractConfigVariables | null;
  supplierCodigo: string | null;
  onClose: () => void;
  onSaved: (slug: string) => void;
}) {
  const year = isoDate(payload.sharedFields.contract_starts)?.slice(0, 4) ?? String(new Date().getFullYear());
  const [title, setTitle] = useState(
    `${(supplierCodigo ?? payload.sharedFields.nombre_comercial ?? files[0]?.name ?? "caso").toLowerCase()}-${year}`,
  );
  const [family, setFamily] = useState("");
  const [notes, setNotes] = useState("");
  const initialExpected = useMemo(
    () => JSON.stringify(buildExpectedFromApproved(payload, brief, supplierCodigo), null, 2),
    [payload, brief, supplierCodigo],
  );
  const [expectedText, setExpectedText] = useState(initialExpected);
  const [advanced, setAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expectedParsed = useMemo<{ value: Record<string, unknown> | null; error: string | null }>(() => {
    try {
      const v = JSON.parse(expectedText) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) return { value: null, error: "Debe ser un objeto JSON." };
      return { value: v as Record<string, unknown>, error: null };
    } catch {
      return { value: null, error: "JSON inválido." };
    }
  }, [expectedText]);

  const summary = useMemo(() => {
    const e = expectedParsed.value ?? {};
    const parts: string[] = [];
    const sup = e.supplier as { codigo?: string } | undefined;
    if (sup?.codigo) parts.push(`proveedor ${sup.codigo}`);
    if (Array.isArray(e.currencies)) parts.push(`moneda ${(e.currencies as string[]).join("/")}`);
    if (Array.isArray(e.cedulas)) parts.push(`cédula ${(e.cedulas as string[])[0]}`);
    const v = e.validity as { start?: string; end?: string } | undefined;
    if (v?.start) parts.push(`vigencia ${v.start} → ${v.end}`);
    const t = e.taxes as { included?: boolean; percent?: number } | undefined;
    if (t) parts.push(`IVA ${t.included === undefined ? "" : t.included ? "incluido" : "no incluido"}${t.percent ? ` ${t.percent}%` : ""}`.trim());
    const c = e.commission as { net?: boolean; percent?: number } | undefined;
    if (c) parts.push(c.net ? "tarifas netas" : `comisión ${c.percent ?? "?"}%`);
    if (typeof e.seasonsCount === "number") parts.push(`${e.seasonsCount} temporada(s)`);
    return parts;
  }, [expectedParsed]);

  const close = () => {
    if (!submitting) onClose();
  };

  const save = async () => {
    if (!expectedParsed.value) return;
    const t = title.trim();
    if (t.length < 3) {
      setError("Ponle un nombre al caso.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { case: created } = await api.evals.create(files, {
        title: t,
        supplierCodigo,
        layoutFamily: family.trim() || null,
        notes: notes.trim() || null,
        expected: expectedParsed.value,
      });
      onSaved(created.slug);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar el caso.");
      setSubmitting(false);
    }
  };

  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  return (
    <ModalShell onClose={close} labelledBy="save-eval-title" maxWidth="max-w-xl">
      <ModalHeader id="save-eval-title" title="Guardar como caso de prueba" onClose={close} />
      <div className="p-4 sm:p-6 space-y-4">
        <p className="text-[12.5px] text-muted-foreground">
          Se guardan los {files.length} documento(s) ({(totalBytes / 1024 / 1024).toFixed(1)} MB) y lo que
          aprobaste como valores esperados. Cuando alguien cambie el lector sin IA, este caso se
          verificará junto con los demás.
        </p>

        <Field label="Nombre del caso">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
        </Field>

        <Field label="Familia de formato" hint="¿Cómo se ve este contrato? Si ya hay un caso de la misma familia, probablemente no hace falta otro.">
          <input
            value={family}
            onChange={(e) => setFamily(e.target.value)}
            list="eval-family-suggestions"
            placeholder="Ej. Hotel · tabla por temporada"
            className={inputClass}
          />
          <datalist id="eval-family-suggestions">
            {FAMILY_SUGGESTIONS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Field>

        <Field label="Notas (opcional)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value.slice(0, 600))}
            rows={2}
            placeholder="Qué tiene de particular este formato (tabla girada, precios por persona, dos monedas…)."
            className={`${inputClass} resize-y`}
          />
        </Field>

        <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2.5 space-y-1.5">
          <p className="text-[12px] font-semibold text-foreground">Lo que el lector deberá encontrar</p>
          {summary.length > 0 ? (
            <p className="text-[12px] text-muted-foreground">{summary.join(" · ")}</p>
          ) : (
            <p className="text-[12px] text-amber-300 flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" /> Sin valores esperados: el caso no verificaría nada.
            </p>
          )}
          <button
            type="button"
            onClick={() => setAdvanced((a) => !a)}
            className="text-[11.5px] text-primary hover:underline"
          >
            {advanced ? "Ocultar JSON" : "Editar JSON (avanzado)"}
          </button>
          {advanced && (
            <>
              <textarea
                value={expectedText}
                onChange={(e) => setExpectedText(e.target.value)}
                rows={10}
                spellCheck={false}
                className={`${inputClass} font-mono text-[11.5px] resize-y`}
              />
              {expectedParsed.error && <InlineError message={expectedParsed.error} />}
            </>
          )}
        </div>

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
          disabled={submitting || !expectedParsed.value || summary.length === 0}
          className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-md gradient-primary text-white text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <FlaskConical className="w-4 h-4" />
          {submitting ? "Guardando…" : "Guardar caso"}
        </button>
      </footer>
    </ModalShell>
  );
}
