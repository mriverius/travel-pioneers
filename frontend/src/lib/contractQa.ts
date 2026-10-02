/**
 * QA determinístico del flujo de contratos — sin IA.
 *
 * Es el "revisor" del sistema: código que contrasta lo que dijo el modelo
 * (brief del Paso 2, filas del Paso 3) con hechos que el modelo no produjo:
 * lo leído literalmente de los documentos (pre-scan), aritmética, el maestro
 * de proveedores y la propia consistencia interna del resultado.
 *
 * Dos salidas:
 *   - `findings`: hallazgos con severidad, para mostrar y para bloquear.
 *   - `questions` (sólo Paso 2): hallazgos que un humano debe decidir,
 *     convertidos en preguntas con opciones pre-llenadas. La respuesta se
 *     aplica al brief Y viaja como instrucción del usuario a la extracción.
 *
 * Precedencia del sistema: instrucción humana (comentarios / respuestas) >
 * texto literal del documento > inferencias. Un comentario sobre un tema
 * convierte la discrepancia IA-vs-documento de ese tema en informativa.
 */
import type {
  CatalogSupplier,
  ContractConfigVariables,
  ExtractedContractRow,
  PreScanResult,
  PreScanSeason,
} from "@/lib/api";

export type QaSeverity = "error" | "warning" | "info";

export interface QaFinding {
  id: string;
  severity: QaSeverity;
  /** Tema, para agrupar y para cruzar con comentarios del usuario. */
  topic: "tax" | "commission" | "currency" | "validity" | "seasons" | "prices" | "services" | "rows" | "bank" | "identity" | "documents" | "other";
  title: string;
  detail: string;
}

export interface QaOption {
  id: string;
  label: string;
  /** Texto que se envía como instrucción del usuario a la extracción. */
  instruction: string;
  /** Cambios al brief (parcial, se fusiona). */
  patch?: Partial<ContractConfigVariables> | ((b: ContractConfigVariables) => ContractConfigVariables);
}

export interface QaQuestion {
  id: string;
  topic: QaFinding["topic"];
  /** Si es true, no se puede extraer sin responder u omitir explícitamente. */
  required: boolean;
  title: string;
  detail: string;
  options: QaOption[];
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let t = raw.replace(/[^\d.,-]/g, "");
  if (!t) return null;
  const lc = t.lastIndexOf(",");
  const ld = t.lastIndexOf(".");
  if (lc > -1 && ld > -1) t = lc > ld ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (lc > -1) t = t.length - lc - 1 === 2 ? t.replace(",", ".") : t.replace(/,/g, "");
  else if (ld > -1 && t.length - ld - 1 === 3 && /^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function parsePct(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /(\d{1,3}(?:[.,]\d+)?)/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function dayOfYear(iso: string): number | null {
  const m = ISO.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 86_400_000);
}

/** IBAN mod-97 (ISO 13616). Devuelve null si no parece IBAN. */
export function ibanValid(raw: string | null | undefined): boolean | null {
  if (!raw) return null;
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return null;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Temas sobre los que el usuario escribió instrucciones en "Comentarios". */
export function commentTopics(comments: string): Set<QaFinding["topic"]> {
  const c = comments.toLowerCase();
  const out = new Set<QaFinding["topic"]>();
  if (/\b(iva|impuesto|tax|vat)\b/.test(c)) out.add("tax");
  if (/\b(comisi[oó]n|commission|neto|net rate|rack)\b/.test(c)) out.add("commission");
  if (/\b(moneda|currency|d[oó]lares?|colones|usd|crc|\$|₡)/.test(c)) out.add("currency");
  if (/\b(vigencia|validez|v[aá]lido|valid|vence|expira|desde|hasta|from|until)\b/.test(c)) out.add("validity");
  if (/\b(temporada|season)\b/.test(c)) out.add("seasons");
  return out;
}

const fmtSeason = (s: PreScanSeason) => `${s.name ?? "Temporada"}: ${s.ranges.map((r) => `${r.start}→${r.end}`).join(", ")}`;

/* -------------------------------------------------------------------------- */
/*                              QA del brief (Paso 2)                         */
/* -------------------------------------------------------------------------- */

export interface BriefQaInput {
  brief: ContractConfigVariables;
  scan: PreScanResult | null;
  supplier: CatalogSupplier | null;
  comments: string;
}

export interface BriefQaResult {
  findings: QaFinding[];
  questions: QaQuestion[];
}

export function qaBrief({ brief, scan, supplier, comments }: BriefQaInput): BriefQaResult {
  const findings: QaFinding[] = [];
  const questions: QaQuestion[] = [];
  const overridden = commentTopics(comments);
  const inf = scan?.inferences ?? null;
  const facts = scan?.facts ?? null;
  const anyText = !!scan && scan.documents.some((d) => d.textAvailable);

  const note = (topic: QaFinding["topic"]) =>
    overridden.has(topic) ? " Tienes un comentario sobre esto: el comentario tiene prioridad." : "";

  /* ---------- Impuestos ---------- */
  {
    const docInc = inf?.taxes?.included ?? null;
    const docPct = inf?.taxes?.percent ?? null;
    const aiInc = brief.prices_include_tax;
    const aiPct = brief.tax_rate_pct;
    if (aiInc === null && !overridden.has("tax")) {
      findings.push({ id: "tax-unknown", severity: "warning", topic: "tax", title: "No se determinó si los precios incluyen impuesto", detail: docInc === null ? "Ni la IA ni el documento lo dicen explícitamente." : `El documento sugiere: ${docInc ? "incluido" : "no incluido"}${docPct !== null ? ` (${docPct}%)` : ""}.` });
      questions.push({
        id: "q-tax", topic: "tax", required: true,
        title: "¿Los precios incluyen el impuesto?",
        detail: docInc === null ? "El documento no lo dice de forma explícita." : `El documento dice «${inf?.taxes?.snippet.slice(0, 120)}…».`,
        options: [
          { id: "excl", label: `No incluido${docPct ? ` (+${docPct}%)` : " (+13%)"}`, instruction: `Los precios NO incluyen impuesto; aplicar ${docPct ?? 13}% de IVA.`, patch: { prices_include_tax: false, tax_rate_pct: docPct ?? 13 } },
          { id: "incl", label: `Incluido${docPct ? ` (${docPct}%)` : " (13%)"}`, instruction: `Los precios SÍ incluyen el impuesto (${docPct ?? 13}%).`, patch: { prices_include_tax: true, tax_rate_pct: docPct ?? 13 } },
        ],
      });
    } else if (docInc !== null && aiInc !== null && docInc !== aiInc) {
      const sev: QaSeverity = overridden.has("tax") ? "info" : "error";
      findings.push({ id: "tax-mismatch", severity: sev, topic: "tax", title: "IVA: la IA y el documento no coinciden", detail: `La IA marcó "${aiInc ? "incluido" : "no incluido"}"; el documento dice «${inf?.taxes?.snippet.slice(0, 110)}…».${note("tax")}` });
      if (!overridden.has("tax")) {
        questions.push({
          id: "q-tax-mismatch", topic: "tax", required: true,
          title: "¿Los precios incluyen el impuesto?",
          detail: `La IA interpretó "${aiInc ? "incluido" : "no incluido"}" pero el documento dice literalmente «${inf?.taxes?.snippet.slice(0, 120)}…».`,
          options: [
            { id: "doc", label: `Lo que dice el documento: ${docInc ? "incluido" : "no incluido"}${docPct !== null ? ` (${docPct}%)` : ""}`, instruction: `Los precios ${docInc ? "SÍ incluyen" : "NO incluyen"} impuesto${docPct !== null ? ` (${docPct}%)` : ""}, como dice el documento.`, patch: { prices_include_tax: docInc, tax_rate_pct: docPct ?? aiPct } },
            { id: "ai", label: `Lo que interpretó la IA: ${aiInc ? "incluido" : "no incluido"}`, instruction: `Los precios ${aiInc ? "SÍ incluyen" : "NO incluyen"} impuesto (confirmado por el revisor pese al texto del documento).`, patch: { prices_include_tax: aiInc } },
          ],
        });
      }
    } else if (docPct !== null && aiPct !== null && docPct !== aiPct && !overridden.has("tax")) {
      findings.push({ id: "tax-pct", severity: "warning", topic: "tax", title: `IVA ${aiPct}% vs ${docPct}% en el documento`, detail: "Revisa la tasa antes de extraer." });
    }
  }

  /* ---------- Comisión ---------- */
  {
    const aiPct = brief.commission_default_pct;
    const doc = inf?.commission ?? null;
    const conflictDocs = (scan?.crossDocumentWarnings ?? []).filter((w) => /^Comisi[oó]n:/.test(w));
    if (conflictDocs.length > 0 && !overridden.has("commission")) {
      findings.push({ id: "commission-docs", severity: "warning", topic: "commission", title: "Los documentos no coinciden en la comisión", detail: conflictDocs[0]! });
      questions.push({
        id: "q-commission-docs", topic: "commission", required: true,
        title: "¿Qué comisión aplica?",
        detail: conflictDocs[0]!,
        options: [
          { id: "net", label: "Tarifas netas (0%) para todo", instruction: "Todas las tarifas son netas: comisión 0%.", patch: { commission_default_pct: 0 } },
          ...(doc?.percent !== null && doc?.percent !== undefined ? [{ id: "pct", label: `${doc.percent}% para todo`, instruction: `Comisión del ${doc.percent}% sobre rack para todas las tarifas.`, patch: { commission_default_pct: doc.percent } }] : []),
          { id: "mixed", label: "Depende del servicio (la IA decide por fila)", instruction: "La comisión varía por servicio: usar la comisión que indique cada tabla/documento para sus filas (p. ej. transporte neto, tours comisionables)." },
        ],
      });
    } else if (doc && aiPct !== null && !overridden.has("commission")) {
      if (doc.net && aiPct > 0) findings.push({ id: "commission-net", severity: "warning", topic: "commission", title: `Comisión ${aiPct}% pero el documento habla de tarifas netas`, detail: doc.snippet.slice(0, 140) });
      else if (doc.percent !== null && doc.percent !== aiPct) findings.push({ id: "commission-pct", severity: "warning", topic: "commission", title: `Comisión ${aiPct}% vs ${doc.percent}% en el documento`, detail: doc.snippet.slice(0, 140) });
    }
  }

  /* ---------- Moneda ---------- */
  {
    const docCur = facts?.currencies ?? [];
    if (brief.currency === null && docCur.length === 1) {
      findings.push({ id: "currency-fill", severity: "info", topic: "currency", title: `Moneda no indicada por la IA; el documento usa ${docCur[0]}`, detail: "Se usará la del documento salvo que indiques otra." });
    } else if (brief.currency && docCur.length > 0 && !docCur.some((c) => brief.currency!.toUpperCase().includes(c)) && !overridden.has("currency")) {
      findings.push({ id: "currency-mismatch", severity: "error", topic: "currency", title: `Moneda ${brief.currency} vs ${docCur.join("/")} en el documento`, detail: "Los montos del documento llevan otro símbolo de moneda." });
      questions.push({
        id: "q-currency", topic: "currency", required: true, title: "¿En qué moneda están las tarifas?",
        detail: `La IA puso ${brief.currency}; los montos del documento usan ${docCur.join(", ")}.`,
        options: [
          ...docCur.map((c) => ({ id: `cur-${c}`, label: c, instruction: `Las tarifas están en ${c}.`, patch: { currency: c } })),
          { id: "cur-ai", label: brief.currency, instruction: `Las tarifas están en ${brief.currency}.`, patch: { currency: brief.currency } },
        ],
      });
    }
    const curConflict = (scan?.crossDocumentWarnings ?? []).find((w) => /^Moneda:/.test(w));
    if (curConflict && !overridden.has("currency")) findings.push({ id: "currency-docs", severity: "warning", topic: "currency", title: "Los documentos usan monedas distintas", detail: curConflict });
  }

  /* ---------- Vigencia ---------- */
  {
    const s = brief.shared_fields.contract_starts;
    const e = brief.shared_fields.contract_ends;
    const doc = inf?.validity ?? null;
    if ((!s || !e) && !overridden.has("validity")) {
      findings.push({ id: "validity-missing", severity: "warning", topic: "validity", title: "Vigencia incompleta", detail: doc ? `El documento sugiere ${doc.start} → ${doc.end}${doc.source === "year" ? " (por el año del título)" : ""}.` : "Ni la IA ni el documento la indican." });
      questions.push({
        id: "q-validity", topic: "validity", required: false, title: "¿Cuál es la vigencia del contrato?",
        detail: doc ? `El documento sugiere ${doc.start} → ${doc.end}.` : "No aparece de forma explícita.",
        options: doc
          ? [{ id: "doc", label: `${doc.start} → ${doc.end}`, instruction: `Vigencia del contrato: ${doc.start} a ${doc.end}.`, patch: (b) => ({ ...b, shared_fields: { ...b.shared_fields, contract_starts: doc.start, contract_ends: doc.end } }) }]
          : [],
      });
    } else if (s && e) {
      const ds = dayOfYear(s);
      const de = dayOfYear(e);
      if (ds !== null && de !== null && de < ds) findings.push({ id: "validity-order", severity: "error", topic: "validity", title: "La vigencia termina antes de empezar", detail: `${s} → ${e}` });
      if (doc && doc.source === "explicit" && (doc.start !== s || doc.end !== e) && !overridden.has("validity")) {
        findings.push({ id: "validity-mismatch", severity: "warning", topic: "validity", title: "Vigencia distinta a la del documento", detail: `IA: ${s} → ${e}; documento: ${doc.start} → ${doc.end}.` });
        questions.push({
          id: "q-validity-mismatch", topic: "validity", required: true, title: "¿Qué vigencia aplica?",
          detail: `La IA puso ${s} → ${e}; el documento dice ${doc.start} → ${doc.end}.`,
          options: [
            { id: "doc", label: `Documento: ${doc.start} → ${doc.end}`, instruction: `Vigencia: ${doc.start} a ${doc.end} (según documento).`, patch: (b) => ({ ...b, shared_fields: { ...b.shared_fields, contract_starts: doc.start, contract_ends: doc.end } }) },
            { id: "ai", label: `IA: ${s} → ${e}`, instruction: `Vigencia: ${s} a ${e} (confirmado por el revisor).` },
          ],
        });
      }
    }
  }

  /* ---------- Temporadas ---------- */
  {
    const seasons = brief.seasons_detail ?? [];
    // Solapes / huecos dentro de la vigencia.
    const ranges = seasons
      .map((x) => ({ name: x.name, a: x.starts ? dayOfYear(x.starts) : null, b: x.ends ? dayOfYear(x.ends) : null }))
      .filter((x): x is { name: string | null; a: number; b: number } => x.a !== null && x.b !== null)
      .sort((x, y) => x.a - y.a);
    for (let i = 1; i < ranges.length; i += 1) {
      const prev = ranges[i - 1]!;
      const cur = ranges[i]!;
      if (cur.a <= prev.b) {
        findings.push({ id: `season-overlap-${i}`, severity: "error", topic: "seasons", title: "Temporadas solapadas", detail: `"${prev.name ?? "?"}" y "${cur.name ?? "?"}" comparten fechas. Cada fecha debe caer en una sola temporada.` });
      } else if (cur.a - prev.b > 1) {
        findings.push({ id: `season-gap-${i}`, severity: "warning", topic: "seasons", title: "Hueco entre temporadas", detail: `${cur.a - prev.b - 1} día(s) sin temporada entre "${prev.name ?? "?"}" y "${cur.name ?? "?"}".` });
      }
    }
    // Conflicto entre documentos → pregunta con las versiones de cada documento.
    const conflict = (scan?.crossDocumentWarnings ?? []).find((w) => /^Temporadas:/.test(w));
    if (conflict && scan && !overridden.has("seasons")) {
      const docsWithSeasons = scan.documents.filter((d) => d.seasons.length > 0);
      findings.push({ id: "seasons-docs", severity: "warning", topic: "seasons", title: "Los documentos no coinciden en las temporadas", detail: conflict });
      questions.push({
        id: "q-seasons-docs", topic: "seasons", required: true, title: "¿Qué temporadas aplican?",
        detail: conflict,
        options: docsWithSeasons.map((d, i) => ({
          id: `sd-${i}`,
          label: `${d.filename}: ${d.seasons.map(fmtSeason).join(" | ")}`,
          instruction: `Temporadas según "${d.filename}": ${d.seasons.map(fmtSeason).join("; ")}. Ignorar las fechas de temporada de los demás documentos.`,
          patch: (b) => ({
            ...b,
            seasons_detail: d.seasons.flatMap((se) => se.ranges.map((r) => ({ name: se.name, starts: null, ends: null, raw_range: `${r.start}→${r.end}` }))),
            seasons: d.seasons.map((se) => se.name ?? "Temporada"),
          }),
        })),
      });
    }
    // Fechas de temporada de la IA que no aparecen en el documento.
    if (inf && inf.seasons.length > 0 && seasons.length > 0 && !overridden.has("seasons")) {
      const docDays = new Set(inf.seasons.flatMap((s) => s.ranges.flatMap((r) => [r.start, r.end])));
      const bad = seasons.flatMap((s) => [s.starts, s.ends]).filter((d): d is string => !!d && ISO.test(d) && !docDays.has(d.slice(5)));
      if (bad.length > 0) findings.push({ id: "season-dates", severity: "warning", topic: "seasons", title: "Fechas de temporada que no aparecen en el documento", detail: `${[...new Set(bad)].slice(0, 6).join(", ")}. El documento define: ${inf.seasons.map(fmtSeason).join("; ")}.` });
      if (inf.seasons.length !== seasons.length) findings.push({ id: "season-count", severity: "info", topic: "seasons", title: `La IA identificó ${seasons.length} temporada(s); el documento parece tener ${inf.seasons.length}`, detail: inf.seasons.map(fmtSeason).join("; ") });
    }
  }

  /* ---------- Plan de filas vs precios del documento ---------- */
  if (inf && inf.priceMentions >= 4) {
    const plan = brief.row_plan;
    const expected = brief.expected_row_estimate ?? plan?.expected_rows ?? null;
    if (inf.estimatedProducts && plan?.categories && plan.categories.length > 0 && Math.abs(plan.categories.length - inf.estimatedProducts) / inf.estimatedProducts > 0.34) {
      findings.push({ id: "products-count", severity: "warning", topic: "rows", title: `La IA plantea ${plan.categories.length} producto(s); los precios del documento sugieren ${inf.estimatedProducts}`, detail: `${inf.priceMentions} precios ÷ ${Math.max(1, inf.occupancies.filter((o) => o !== "CHD").length)} ocupaciones ÷ ${Math.max(1, inf.seasons.length)} temporadas.` });
    }
    if (expected !== null && expected * 2 < inf.prices.length) {
      findings.push({ id: "rows-vs-prices", severity: "info", topic: "rows", title: `${expected} filas estimadas para ${inf.prices.length} precios distintos`, detail: "Si cada fila lleva pocos precios, puede faltar inventario. Se verificará contra la tabla en el Paso 3." });
    }
  }

  /* ---------- Bancos ---------- */
  {
    for (const acc of brief.bank_accounts ?? []) {
      const v = ibanValid(acc.account_number);
      if (v === false) findings.push({ id: `iban-${acc.account_number}`, severity: "error", topic: "bank", title: `IBAN inválido: ${acc.account_number}`, detail: "No pasa la verificación de dígitos de control; probablemente está mal transcrito." });
    }
    if (inf && inf.bankAccounts.length > 0) {
      const briefNums = (brief.bank_accounts ?? []).map((a) => (a.account_number ?? "").replace(/\s+/g, "").toUpperCase());
      const missing = inf.bankAccounts.filter((b) => b.iban && !briefNums.some((n) => n.includes(b.iban!) || b.iban!.includes(n)));
      if (missing.length > 0 && briefNums.length < inf.bankAccounts.length) {
        findings.push({ id: "bank-missing", severity: "warning", topic: "bank", title: `${missing.length} cuenta(s) del documento no están en el brief`, detail: missing.map((b) => `${b.bank ?? "banco"} ${b.currency ?? ""} ${b.iban}`).join("; ") });
      }
    }
  }

  /* ---------- Identidad ---------- */
  if (facts) {
    if (!brief.shared_fields.cedula && facts.cedulas[0]) findings.push({ id: "cedula-fill", severity: "info", topic: "identity", title: `Cédula tomada del documento: ${facts.cedulas[0]}`, detail: "La IA no la indicó." });
    if (brief.shared_fields.cedula && facts.cedulas.length > 0 && !facts.cedulas.some((c) => c.replace(/\D/g, "") === brief.shared_fields.cedula!.replace(/\D/g, ""))) {
      findings.push({ id: "cedula-mismatch", severity: "warning", topic: "identity", title: `Cédula ${brief.shared_fields.cedula} no aparece en el documento`, detail: `El documento menciona ${facts.cedulas.join(", ")}.` });
    }
  }

  /* ---------- Servicios del maestro ---------- */
  if (supplier && supplier.servicios.length === 0 && supplier.serviceCount === 0) {
    findings.push({ id: "no-services", severity: "warning", topic: "services", title: "El proveedor no tiene servicios en el maestro", detail: "El «Código servicio» quedará manual. Puedes agregarlos en Proveedores." });
  }

  /* ---------- Documentos ---------- */
  if (scan) {
    const noText = scan.documents.filter((d) => !d.textAvailable);
    if (noText.length > 0) findings.push({ id: "scanned", severity: "info", topic: "documents", title: `${noText.length} documento(s) sin texto legible`, detail: `${noText.map((d) => d.filename).join(", ")}: la IA los leerá como imagen; no hay anclas determinísticas para ellos.` });
    for (const w of scan.crossDocumentWarnings.filter((x) => /parece ser de/.test(x))) findings.push({ id: `wrongdoc-${w.slice(0, 20)}`, severity: "error", topic: "documents", title: "Un documento parece de otro proveedor", detail: w });
  }
  if (!anyText) findings.push({ id: "no-anchors", severity: "info", topic: "documents", title: "Sin anclas determinísticas", detail: "Ningún documento tenía texto legible; la verificación automática será limitada." });

  return { findings, questions };
}

/* -------------------------------------------------------------------------- */
/*                               QA de filas (Paso 3)                         */
/* -------------------------------------------------------------------------- */

export interface RowsQaInput {
  rows: ExtractedContractRow[];
  scan: PreScanResult | null;
  brief: ContractConfigVariables | null;
  supplier: CatalogSupplier | null;
}

export function qaRows({ rows, scan, brief, supplier }: RowsQaInput): QaFinding[] {
  const findings: QaFinding[] = [];
  const inf = scan?.inferences ?? null;
  const anyText = !!scan && scan.documents.some((d) => d.textAvailable);

  /* Campos obligatorios y duplicados */
  {
    const missing: number[] = [];
    const seen = new Map<string, number>();
    const dupes: string[] = [];
    rows.forEach((r, idx) => {
      const hasPrice = [r.precios_neto_iva, r.precio_rack_iva, r.precios_neto_iva_fds, r.precio_rack_iva_fds].some((v) => parseAmount(v) !== null);
      if (!r.product_name?.trim() || !hasPrice) missing.push(idx + 1);
      const key = `${(r.product_name ?? "").trim().toLowerCase()}|${r.season_starts ?? ""}|${r.season_ends ?? ""}|${(r.ocupacion ?? "").trim().toLowerCase()}`;
      if (seen.has(key)) dupes.push(`${r.product_name ?? "?"} (${r.season_name ?? r.season_starts ?? "?"}, ${r.ocupacion ?? "—"})`);
      else seen.set(key, idx);
    });
    if (missing.length > 0) findings.push({ id: "rows-missing", severity: "error", topic: "rows", title: `${missing.length} fila(s) sin producto o sin precio`, detail: `Filas: ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? "…" : ""}.` });
    if (dupes.length > 0) findings.push({ id: "rows-dupes", severity: "error", topic: "rows", title: `${dupes.length} fila(s) duplicada(s)`, detail: `${[...new Set(dupes)].slice(0, 5).join("; ")}.` });
  }

  /* Aritmética neto = rack × (1 − comisión) */
  {
    const bad: string[] = [];
    let checked = 0;
    rows.forEach((r, idx) => {
      const net = parseAmount(r.precios_neto_iva);
      const rack = parseAmount(r.precio_rack_iva);
      const pct = parsePct(r.porcentaje_comision) ?? brief?.commission_default_pct ?? null;
      if (net === null || rack === null || pct === null) return;
      checked += 1;
      const expected = rack * (1 - pct / 100);
      if (Math.abs(expected - net) > Math.max(1, rack * 0.01)) bad.push(`fila ${idx + 1}: ${rack} × (1 − ${pct}%) = ${expected.toFixed(2)} ≠ ${net}`);
    });
    if (bad.length > 0) findings.push({ id: "rows-arith", severity: "error", topic: "commission", title: `${bad.length} de ${checked} fila(s) no cuadran neto / rack / comisión`, detail: `${bad.slice(0, 4).join("; ")}${bad.length > 4 ? "…" : ""}.` });
  }

  /* Cobertura de precios del documento */
  if (inf && anyText && inf.prices.length >= 4) {
    const inTable = new Set<number>();
    for (const r of rows) for (const v of [r.precios_neto_iva, r.precio_rack_iva, r.precios_neto_iva_fds, r.precio_rack_iva_fds]) { const n = parseAmount(v); if (n !== null) inTable.add(n); }
    const matched = inf.prices.filter((p) => inTable.has(p));
    const missing = inf.prices.filter((p) => !inTable.has(p));
    const ratio = matched.length / inf.prices.length;
    if (ratio < 0.9) {
      findings.push({ id: "price-coverage", severity: ratio < 0.6 ? "error" : "warning", topic: "prices", title: `La tabla contiene ${matched.length} de ${inf.prices.length} precios distintos del documento (${Math.round(ratio * 100)}%)`, detail: `Posibles faltantes: ${missing.slice(0, 12).map((m) => m.toLocaleString("es-CR")).join(", ")}${missing.length > 12 ? "…" : ""}.` });
    } else {
      findings.push({ id: "price-coverage-ok", severity: "info", topic: "prices", title: `Precios: ${matched.length}/${inf.prices.length} del documento aparecen en la tabla`, detail: missing.length > 0 ? `No aparecen: ${missing.slice(0, 8).join(", ")}.` : "Cobertura completa." });
    }
    // Precios en la tabla que no están en el documento (inventados o mal copiados)
    const docSet = new Set(inf.prices);
    const alien = [...inTable].filter((p) => !docSet.has(p));
    if (alien.length > 0 && alien.length / Math.max(1, inTable.size) > 0.2) {
      findings.push({ id: "price-alien", severity: "warning", topic: "prices", title: `${alien.length} precio(s) de la tabla no aparecen en el documento`, detail: `${alien.slice(0, 10).map((m) => m.toLocaleString("es-CR")).join(", ")}${alien.length > 10 ? "…" : ""}. Pueden ser cálculos (neto con IVA) o errores de lectura.` });
    }
  }

  /* Temporadas: fechas del documento, solapes por producto */
  {
    if (inf && anyText && inf.seasons.length > 0) {
      const docDays = new Set(inf.seasons.flatMap((s) => s.ranges.flatMap((r) => [r.start, r.end])));
      const bad = new Set<string>();
      for (const r of rows) for (const d of [r.season_starts, r.season_ends]) { const m = ISO.exec(d ?? ""); if (m && !docDays.has(`${m[2]}-${m[3]}`)) bad.add(d as string); }
      if (bad.size > 0) findings.push({ id: "season-dates-rows", severity: "warning", topic: "seasons", title: `${bad.size} fecha(s) de temporada que el documento no define`, detail: `${[...bad].slice(0, 6).join(", ")}${bad.size > 6 ? "…" : ""}. Documento: ${inf.seasons.map(fmtSeason).join("; ")}.` });
    }
    const byProduct = new Map<string, { a: number; b: number; label: string }[]>();
    rows.forEach((r) => {
      const a = r.season_starts ? dayOfYear(r.season_starts) : null;
      const b = r.season_ends ? dayOfYear(r.season_ends) : null;
      if (a === null || b === null) return;
      const k = `${(r.product_name ?? "").trim().toLowerCase()}|${(r.ocupacion ?? "").trim().toLowerCase()}`;
      const list = byProduct.get(k) ?? [];
      list.push({ a, b, label: r.product_name ?? "?" });
      byProduct.set(k, list);
    });
    const overlaps: string[] = [];
    for (const list of byProduct.values()) {
      list.sort((x, y) => x.a - y.a);
      for (let i = 1; i < list.length; i += 1) if (list[i]!.a <= list[i - 1]!.b) { overlaps.push(list[i]!.label); break; }
    }
    if (overlaps.length > 0) findings.push({ id: "season-overlap-rows", severity: "error", topic: "seasons", title: `${overlaps.length} producto(s) con temporadas solapadas`, detail: `${[...new Set(overlaps)].slice(0, 5).join("; ")}. Dos filas del mismo producto no pueden cubrir la misma fecha.` });
  }

  /* Código de servicio ∈ maestro */
  if (supplier && supplier.servicios.length > 0) {
    const valid = new Set(supplier.servicios.map((s) => s.codigo.toUpperCase()));
    const bad = [...new Set(rows.map((r) => r.codigo_servicio?.trim()).filter((c): c is string => !!c && !valid.has(c.toUpperCase())))];
    if (bad.length > 0) findings.push({ id: "service-codes", severity: "error", topic: "services", title: `${bad.length} código(s) de servicio que no existen para ${supplier.nombre ?? supplier.codigo}`, detail: `${bad.slice(0, 8).join(", ")}. Válidos: ${supplier.servicios.slice(0, 12).map((s) => s.codigo).join(", ")}${supplier.servicios.length > 12 ? "…" : ""}.` });
  }

  /* Ocupaciones del documento */
  if (inf && anyText && inf.occupancies.length > 0) {
    const doc = new Set(inf.occupancies.map((o) => o.toUpperCase()));
    const rowOcc = [...new Set(rows.map((r) => (r.ocupacion ?? "").trim().toUpperCase()).filter(Boolean))];
    const unknown = rowOcc.filter((o) => !doc.has(o) && !/^\d+$/.test(o));
    if (unknown.length > 0 && unknown.length === rowOcc.length) findings.push({ id: "occupancy", severity: "info", topic: "rows", title: `Ocupaciones en la tabla (${unknown.join(", ")}) distintas a las del documento (${inf.occupancies.join(", ")})`, detail: "Puede ser nomenclatura; verifica que no falten columnas de ocupación." });
  }

  return findings;
}

export function worstSeverity(findings: QaFinding[]): QaSeverity | null {
  if (findings.some((f) => f.severity === "error")) return "error";
  if (findings.some((f) => f.severity === "warning")) return "warning";
  if (findings.length > 0) return "info";
  return null;
}
