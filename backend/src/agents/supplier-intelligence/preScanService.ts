/**
 * Pre-scan determinístico de un contrato recién subido — SIN IA.
 *
 * Corre en el instante en que el usuario suelta el archivo en el Paso 1 y
 * responde en milisegundos con lo que un revisor humano quiere saber antes
 * de gastar una llamada a Claude:
 *
 *   1. ¿De qué proveedor del maestro es este contrato? (match por nombre /
 *      código / nombre de archivo contra la tabla `suppliers`).
 *   2. Datos "duros" que se pueden leer con regex: cédulas, cuentas IBAN,
 *      correos, teléfonos, monedas, fechas.
 *   3. ¿Ya procesamos un contrato de este proveedor? Si sí, comparamos la
 *      cuenta bancaria / cédula anteriores con lo que dice este documento y
 *      avisamos si cambiaron.
 *
 * Nada de esto reemplaza la extracción con IA (que sigue leyendo el PDF
 * completo); su valor es adelantar la confirmación de identidad y las
 * banderas rojas al inicio del flujo, cuando corregir es gratis.
 *
 * Texto: docx (mammoth) y xlsx ya tenían extractor; para PDF usamos la capa
 * de texto con `pdf-parse` (primeras páginas). Un PDF escaneado o una imagen
 * no tienen texto → devolvemos `textAvailable: false` y el flujo sigue como
 * hasta ahora (Claude lee el documento nativamente).
 */
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import prisma from "../../config/prisma.js";
import logger from "../../config/logger.js";
import { prepareFromXlsx } from "./extractors/xlsx.js";
import type { SupportedDocKind } from "./types.js";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

export type PreScanConfidence = "alta" | "media" | "ninguna";

export interface PreScanCandidate {
  id: string;
  codigo: string;
  nombre: string | null;
  actividad: string | null;
  zona: string | null;
  serviceCount: number;
  score: number;
  /** Señales legibles para la UI ("nombre exacto en la página 1", …). */
  reasons: string[];
}

export interface PreScanFacts {
  cedulas: string[];
  ibans: string[];
  emails: string[];
  phones: string[];
  currencies: string[];
  /** Fechas normalizadas a ISO (YYYY-MM-DD), máx. 12, en orden de aparición. */
  dates: string[];
  /** Rango de años mencionados — pista de vigencia. */
  yearRange: { min: number; max: number } | null;
}

export interface PreScanPreviousRun {
  id: string;
  processedAt: string;
  filename: string;
  cedula: string | null;
  numero_cuenta: string | null;
  banco: string | null;
  tipo_moneda: string | null;
  contract_starts: string | null;
  contract_ends: string | null;
  reservations_email: string | null;
}

export interface PreScanSeason {
  /** Etiqueta cercana ("High Season", "Temporada baja") o null. */
  name: string | null;
  /** Rangos MM-DD (sin año: los contratos repiten temporadas por año). */
  ranges: { start: string; end: string }[];
}

/**
 * Inferencias determinísticas orientadas a las columnas del xlsx. Cada una
 * trae `source`/snippet para que el revisor vea de dónde salió. Son
 * sugerencias: la extracción IA sigue siendo la fuente principal, y estas
 * sirven para pre-llenar huecos y para contrastar su resultado.
 */
export interface PreScanBankAccount {
  bank: string | null;
  currency: string | null;
  accountNumber: string | null;
  iban: string | null;
}

export interface PreScanTerm {
  /** Días antes de la llegada / servicio. */
  daysBefore: number | null;
  /** % a pagar (payment) o % de penalidad (cancellation). 0 = sin cargo. */
  percent: number | null;
  /** "high" | "low" | null cuando la oración menciona temporada. */
  season: string | null;
  sentence: string;
}

export interface PreScanSection {
  key: "cancellation" | "payment" | "children" | "checkin" | "meals" | "noshow" | "modifications" | "guide" | "extras" | "taxes" | "reservations" | "banking" | "other";
  title: string;
  text: string;
}

export interface PreScanInferences {
  /** Razón social / nombre legal ("Name: Pacuare Canyon Lodge LLC"). */
  legalName: string | null;
  address: string | null;
  website: string | null;
  checkIn: string | null;
  checkOut: string | null;
  meals: string[];
  paymentTerms: PreScanTerm[];
  cancellationTerms: PreScanTerm[];
  childTerms: string[];
  bankAccounts: PreScanBankAccount[];
  /** Secciones del documento por encabezado ("Cancellation Policies:" …). */
  sections: PreScanSection[];
  /**
   * Si #precios es múltiplo de (ocupaciones × temporadas), estimación de
   * cuántos productos tiene la grilla. Sanity-check para el plan de filas.
   */
  estimatedProducts: number | null;
  country: { value: string; reasons: string[] } | null;
  validity: { start: string; end: string; source: "explicit" | "year" } | null;
  taxes: { included: boolean | null; percent: number | null; snippet: string } | null;
  commission: { net: boolean; percent: number | null; snippet: string } | null;
  rateBasis: string[];
  occupancies: string[];
  seasons: PreScanSeason[];
  minNights: number | null;
  childPolicy: string | null;
  cancellationPolicy: string | null;
  paymentPolicy: string | null;
  /** Montos distintos encontrados (número), ordenados. Para contrastar con la tabla IA. */
  prices: number[];
  priceMentions: number;
  productHints: string[];
}

/** Qué aportó cada documento adjunto, para que el revisor vea que nada quedó fuera. */
export interface PreScanDocument {
  filename: string;
  kind: SupportedDocKind;
  role: "primary" | "secondary";
  textAvailable: boolean;
  pages: { scanned: number; total: number } | null;
  chars: number;
  /** Etiquetas cortas: "72 precios", "2 temporadas", "cancelación", "IBAN"… */
  contributes: string[];
  /** Mejor candidato de proveedor leído en ESTE documento (para detectar mezclas). */
  supplierHint: { codigo: string; nombre: string | null; confidence: PreScanConfidence } | null;
}

export interface PreScanResult {
  /** Documento primario (el primero). */
  filename: string;
  kind: SupportedDocKind;
  textAvailable: boolean;
  pages: { scanned: number; total: number } | null;
  chars: number;
  /** Todos los documentos, en el orden recibido (primario primero). */
  documents: PreScanDocument[];
  /** Avisos entre documentos (p. ej. un adjunto que parece de otro proveedor). */
  crossDocumentWarnings: string[];
  supplier: { confidence: PreScanConfidence; candidates: PreScanCandidate[] };
  facts: PreScanFacts;
  inferences: PreScanInferences;
  previous: { runs: PreScanPreviousRun[]; warnings: string[] } | null;
  durationMs: number;
}

/* -------------------------------------------------------------------------- */
/*                                Text layer                                  */
/* -------------------------------------------------------------------------- */

/**
 * Páginas que leemos de un PDF. Las tarifas suelen estar en páginas
 * intermedias/finales, así que leemos (casi) todo; el tope evita que un
 * catálogo de 300 páginas bloquee el request. Sólo capa de texto — sin
 * render — así que es barato incluso con muchas fotos.
 */
const PDF_PAGES_TO_SCAN = 60;
/** Cota superior de caracteres que analizamos (regex sobre texto gigante = lento). */
const MAX_CHARS = 400_000;

interface TextLayer {
  text: string;
  pages: { scanned: number; total: number } | null;
  /** Texto por página (sólo PDF) — para detectar encabezados/pies. */
  pageTexts: string[] | null;
}

async function extractTextLayer(kind: SupportedDocKind, buffer: Buffer): Promise<TextLayer | null> {
  switch (kind) {
    case "pdf": {
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText({ first: PDF_PAGES_TO_SCAN });
        // pdf-parse separa páginas con "-- N of M --": fuera, o contamina snippets.
        const text = (result.text ?? "").replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, "");
        return {
          text,
          pages: { scanned: result.pages.length, total: result.total },
          pageTexts: result.pages.map((p) => p.text ?? ""),
        };
      } finally {
        await parser.destroy().catch(() => undefined);
      }
    }
    case "docx": {
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value ?? "", pages: null, pageTexts: null };
    }
    case "xlsx": {
      const prepared = prepareFromXlsx(buffer);
      return { text: prepared.kind === "text" ? prepared.text : "", pages: null, pageTexts: null };
    }
    case "image":
      return null;
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                              Normalización                                 */
/* -------------------------------------------------------------------------- */

/** Mismo criterio que `supplierLookup.normalizeKey` en el frontend. */
export function normalizeKey(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Palabras que aparecen en cientos de nombres del maestro y no identifican
 * a nadie por sí solas. Un match sólo con estas no cuenta.
 */
const STOPWORDS = new Set([
  "hotel", "hotels", "lodge", "resort", "resorts", "villa", "villas", "tours",
  "tour", "travel", "costa", "rica", "the", "and", "del", "de", "la", "el",
  "los", "las", "sa", "srl", "ltda", "limitada", "sociedad", "anonima", "inc",
  "spa", "beach", "club", "boutique", "eco", "ecolodge", "san", "jose",
  "rent", "car", "cars", "transportes", "transporte", "transfer", "transfers",
  "adventures", "adventure", "park", "national", "nacional", "reserva",
  "reserve", "casa", "cabinas", "cabins", "bed", "breakfast", "suites", "inn",
]);

function significantTokens(key: string): string[] {
  return key.split(" ").filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/* -------------------------------------------------------------------------- */
/*                           Detección de proveedor                           */
/* -------------------------------------------------------------------------- */

interface SupplierLite {
  id: string;
  codigo: string;
  nombre: string | null;
  actividad: string | null;
  zona: string | null;
  serviceCount: number;
}

/** Ocurrencias de `needle` como frase completa (límites de palabra). */
function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  const h = ` ${hay} `;
  const n0 = ` ${needle} `;
  let n = 0;
  let i = h.indexOf(n0);
  while (i !== -1 && n < 50) {
    n += 1;
    i = h.indexOf(n0, i + n0.length - 1);
  }
  return n;
}

/**
 * ¿Aparecen todos los tokens, en orden, dentro de una ventana corta? Cubre
 * "Lapa Rios Lodge" vs maestro "LAPA RIOS ECO LODGE": no es la frase exacta
 * pero sí casi.
 */
function tokensInOrderNearby(hay: string, tokens: string[], window = 48): boolean {
  const h = ` ${hay} `;
  let from = 0;
  while (from < h.length) {
    const start = h.indexOf(` ${tokens[0]} `, from);
    if (start === -1) return false;
    let pos = start;
    let ok = true;
    for (let i = 1; i < tokens.length; i += 1) {
      const next = h.indexOf(` ${tokens[i]} `, pos + 1);
      if (next === -1 || next - start > window) {
        ok = false;
        break;
      }
      pos = next;
    }
    if (ok) return true;
    from = start + 1;
  }
  return false;
}

/** `needle` como palabra completa dentro de `hay` (ambos normalizados). */
function hasWholeWord(hay: string, needle: string): boolean {
  return needle !== "" && ` ${hay} `.includes(` ${needle} `);
}

export function detectSupplier(
  text: string,
  filename: string,
  suppliers: SupplierLite[],
): { confidence: PreScanConfidence; candidates: PreScanCandidate[] } {
  const full = normalizeKey(text.slice(0, MAX_CHARS));
  const head = full.slice(0, 2_500); // ≈ primera página
  const fileKey = normalizeKey(filename.replace(/\.[a-z0-9]+$/i, ""));

  const scored: PreScanCandidate[] = [];

  for (const s of suppliers) {
    const nameKey = normalizeKey(s.nombre);
    const codeKey = normalizeKey(s.codigo);
    const tokens = significantTokens(nameKey);
    const reasons: string[] = [];
    let score = 0;

    // 1) Nombre completo tal cual (sólo si el nombre no es puro ruido).
    const nameIsSpecific = nameKey.length >= 6 && tokens.length >= 1;
    if (nameIsSpecific) {
      const occ = countOccurrences(full, nameKey);
      if (occ > 0) {
        score += 100 + Math.min(occ, 10) * 2;
        reasons.push(occ === 1 ? "nombre completo en el documento" : `nombre completo ${occ}× en el documento`);
        if (head.includes(nameKey)) {
          score += 30;
          reasons.push("aparece en la primera página");
        }
      }
    }

    // 2) Código del maestro como palabra completa (códigos cortos o que son
    //    palabras comunes no cuentan: "360", "CASA", …).
    const codeIsSpecific = codeKey.length >= 5 && !STOPWORDS.has(codeKey) && !/^\d+$/.test(codeKey);
    if (codeIsSpecific && hasWholeWord(full, codeKey)) {
      score += 60;
      reasons.push(`código ${s.codigo} en el documento`);
    }

    // 3) Nombre del archivo.
    if (fileKey) {
      if (nameIsSpecific && fileKey.includes(nameKey)) {
        score += 40;
        reasons.push("nombre en el archivo");
      } else if (codeIsSpecific && hasWholeWord(fileKey, codeKey)) {
        score += 35;
        reasons.push("código en el nombre del archivo");
      } else if (tokens.length >= 1) {
        const fileTokens = new Set(fileKey.split(" "));
        const hits = tokens.filter((t) => fileTokens.has(t)).length;
        if (hits >= Math.max(1, Math.ceil(tokens.length * 0.6)) && hits >= 1 && tokens.length <= 3) {
          score += 25;
          reasons.push("coincide con el nombre del archivo");
        }
      }
    }

    // 4) Cobertura de tokens significativos (nombres largos escritos distinto:
    //    "Hotel Grano de Oro S.A." vs "GRANO DE ORO").
    if (tokens.length >= 2 && score < 100) {
      const present = tokens.filter((t) => hasWholeWord(full, t)).length;
      if (present === tokens.length) {
        if (tokensInOrderNearby(full, tokens)) {
          score += 80;
          reasons.push("nombre casi completo en el documento");
        } else {
          score += 45;
          reasons.push("todas las palabras clave del nombre aparecen");
        }
      } else if (present >= 2 && present / tokens.length >= 0.6) {
        score += 20;
        reasons.push(`${present} de ${tokens.length} palabras clave aparecen`);
      }
    } else if (tokens.length === 1 && score === 0 && tokens[0]!.length >= 6) {
      // Nombre de una sola palabra distintiva ("Pacuare", "Lapa Rios" → "lapa"/"rios" caen en >=3)
      if (hasWholeWord(full, tokens[0]!)) {
        score += 35;
        reasons.push("palabra clave del nombre aparece");
      }
    }

    if (score > 0) {
      scored.push({
        id: s.id,
        codigo: s.codigo,
        nombre: s.nombre,
        actividad: s.actividad,
        zona: s.zona,
        serviceCount: s.serviceCount,
        score,
        reasons,
      });
    }
  }

  // Un nombre contenido en otro más largo que también matchea ("RIOS LODGE"
  // dentro de "LAPA RIOS LODGE") es casi siempre un falso positivo del corto:
  // le quitamos los puntos de nombre completo para que gane el largo.
  const nameKeyOf = new Map<string, string>();
  for (const s of suppliers) nameKeyOf.set(s.id, normalizeKey(s.nombre));
  const withName = scored.filter((c) => c.reasons.some((r) => r.startsWith("nombre completo") || r.startsWith("nombre casi completo")));
  for (const a of withName) {
    const ak = nameKeyOf.get(a.id) ?? "";
    if (!ak) continue;
    const aTokens = ak.split(" ").filter(Boolean);
    const subsumed = withName.some((b) => {
      if (b.id === a.id) return false;
      const bk = nameKeyOf.get(b.id) ?? "";
      if (bk.length <= ak.length) return false;
      const bTokens = new Set(bk.split(" "));
      // Todas las palabras del nombre corto están en el largo
      // ("rios lodge" ⊂ "lapa rios eco lodge").
      return aTokens.every((t) => bTokens.has(t));
    });
    if (subsumed) {
      a.score = Math.max(0, a.score - 110);
      a.reasons.push("nombre contenido en otro proveedor más específico");
    }
  }

  scored.sort((a, b) => b.score - a.score || (a.nombre ?? a.codigo).localeCompare(b.nombre ?? b.codigo));
  const top = scored[0];
  const second = scored[1];

  let confidence: PreScanConfidence = "ninguna";
  if (top) {
    const gap = top.score - (second?.score ?? 0);
    if (top.score >= 100 && gap >= 40) confidence = "alta";
    else if (top.score >= 45) confidence = "media";
  }

  return { confidence, candidates: scored.slice(0, 4) };
}

/* -------------------------------------------------------------------------- */
/*                               Hechos (regex)                               */
/* -------------------------------------------------------------------------- */

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12, ene: 1, abr: 4, ago: 8, set: 9, dic: 12,
};

const uniq = (xs: string[], cap: number): string[] => Array.from(new Set(xs)).slice(0, cap);

/**
 * "+506 6204-8983" y "6204-8983" son el mismo número: dedupe por los últimos
 * 8 dígitos y preferimos la variante con prefijo internacional.
 */
function dedupePhones(phones: string[], cap: number): string[] {
  const byDigits = new Map<string, string>();
  for (const p of phones) {
    const d = p.replace(/\D/g, "");
    const key = d.length > 8 ? d.slice(-8) : d;
    const prev = byDigits.get(key);
    if (!prev || (p.startsWith("+") && !prev.startsWith("+"))) byDigits.set(key, p);
  }
  return [...byDigits.values()].slice(0, cap);
}

/** Monedas pegadas a montos: "$671,20" → USD, "₡5.000" → CRC, "USD 120" → USD. */
function detectRateCurrencies(text: string): string[] {
  const counts = new Map<string, number>();
  const bump = (c: string) => counts.set(c, (counts.get(c) ?? 0) + 1);
  for (const m of text.matchAll(/(US\$|USD|\$|₡|CRC|€|EUR)[ \t]{0,6}\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\b/gi)) {
    const sym = m[1]!.toUpperCase();
    bump(sym === "$" || sym === "US$" || sym === "USD" ? "USD" : sym === "₡" || sym === "CRC" ? "CRC" : "EUR");
  }
  for (const m of text.matchAll(/\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\s?(USD|US\$|CRC|EUR)\b/gi)) {
    const sym = m[1]!.toUpperCase();
    bump(sym === "CRC" ? "CRC" : sym === "EUR" ? "EUR" : "USD");
  }
  // Una sola mención aislada de otra moneda (ej. "$40 por niño" en un
  // contrato en colones) no la convierte en moneda del contrato: exigimos
  // al menos 2 menciones o ≥10% de las menciones totales.
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return [...counts.entries()]
    .filter(([, n]) => n >= 2 || n / Math.max(total, 1) >= 0.1)
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c);
}

function iso(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function extractFacts(rawText: string): PreScanFacts {
  const text = rawText.slice(0, MAX_CHARS);

  // Cédula jurídica CR (3-101-123456) y física (1-1234-5678); también con
  // espacios en vez de guiones, y la variante sin separadores de 10 dígitos
  // precedida por la palabra "cédula".
  // Cédulas: con separadores (3-101-123456 / 1-1234-5678). Sin separadores
  // sólo si va precedida de la palabra "cédula": una cadena de 10 dígitos
  // suelta suele ser un número de cuenta, no una cédula.
  const cedulas: string[] = [];
  for (const m of text.matchAll(/(?<![\d#-])([1-9])\s?[-\s]\s?(\d{3})\s?[-\s]\s?(\d{6})(?![\d-])/g)) {
    cedulas.push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  for (const m of text.matchAll(/(?<![\d#-])([1-9])\s?[-\s]\s?(\d{4})\s?[-\s]\s?(\d{4})(?![\d-])/g)) {
    cedulas.push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  for (const m of text.matchAll(/c[eé]dula[^0-9]{0,25}(\d{9,12})\b/gi)) {
    cedulas.push(m[1]!);
  }

  // IBAN: CR + 20 dígitos (con o sin espacios); IBAN genérico de otros países.
  const ibans: string[] = [];
  for (const m of text.matchAll(/\bCR\s?\d{2}(?:\s?\d{4}){4}\s?\d{2}\b/gi)) {
    ibans.push(m[0].replace(/\s+/g, "").toUpperCase());
  }
  for (const m of text.matchAll(/\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?)\b/g)) {
    const compact = m[1]!.replace(/\s+/g, "");
    if (compact.length >= 15 && compact.length <= 34 && !compact.startsWith("CR")) {
      ibans.push(compact);
    }
  }

  const emails = Array.from(
    text.matchAll(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi),
    (m) => m[0].toLowerCase(),
  );

  // Teléfonos: quitamos antes los IBAN (sus grupos de 4 dígitos parecen
  // teléfonos) y exigimos prefijo internacional o el formato CR dddd-dddd.
  let phoneSource = text;
  for (const i of ibans) phoneSource = phoneSource.split(i).join(" ");
  phoneSource = phoneSource.replace(/\bCR\s?\d{2}(?:\s?\d{4}){4}\s?\d{2}\b/gi, " ");
  const phones = Array.from(
    phoneSource.matchAll(
      /(?<![\d-])(?:(?:\+|\(0?11\)\s?)\s?\d{1,3}[\s.-]?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?|\(\d{3}\)\s?\d{3,4}[\s.-]?\d{4}|\d{1}\(\d{3}\)\s?\d{3}-\d{4}|\d{3}-\d{3}-\d{4}|\d{4}-\d{4}|\d{4}\s\d{4}(?=\s|$|[.,;)]))(?![\d-])/g,
    ),
    (m) => m[0].replace(/\s+/g, " ").trim(),
  ).filter((p) => {
    const d = p.replace(/\D/g, "");
    // Ni fechas ("2027-01-01") ni cédulas (d-ddd-dddddd) ni cantidades.
    if (/^\d-\d{3}-\d{6}$|^\d-\d{4}-\d{4}$/.test(p)) return false;
    return d.length >= 8 && d.length <= 15 && !/^(19|20)\d{2}/.test(d.replace(/^0?11/, ""));
  });

  // Moneda DE LAS TARIFAS: la que acompaña a los montos ("$671", "₡5.000",
  // "USD 120"). "Colones" en una tabla bancaria no es la moneda del contrato.
  const currencies = detectRateCurrencies(text);
  if (currencies.length === 0) {
    if (/\b(usd|us\$|d[oó]lares?|dollars?)\b/i.test(text)) currencies.push("USD");
    if (/\b(crc|colones|col[oó]n)\b/i.test(text)) currencies.push("CRC");
    if (/\b(eur|euros?)\b/i.test(text)) currencies.push("EUR");
  }

  // Fechas: dd/mm/yyyy, yyyy-mm-dd, "1 de enero de 2027", "January 1, 2027".
  const dates: string[] = [];
  const years: number[] = [];
  for (const m of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g)) {
    const d = iso(Number(m[3]), Number(m[2]), Number(m[1]));
    if (d) dates.push(d);
  }
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const d = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) dates.push(d);
  }
  for (const m of text.matchAll(/\b(\d{1,2})(?:º|°|st|nd|rd|th)?\s+(?:de\s+)?([a-záéíóú]{3,10})\.?,?\s+(?:de\s+|del\s+)?(\d{4})\b/gi)) {
    const mon = MONTHS[m[2]!.toLowerCase()];
    if (mon) {
      const d = iso(Number(m[3]), mon, Number(m[1]));
      if (d) dates.push(d);
    }
  }
  for (const m of text.matchAll(/\b([a-z]{3,10})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi)) {
    const mon = MONTHS[m[1]!.toLowerCase()];
    if (mon) {
      const d = iso(Number(m[3]), mon, Number(m[2]));
      if (d) dates.push(d);
    }
  }
  for (const m of text.matchAll(/\b(20[2-4]\d)\b/g)) years.push(Number(m[1]));
  for (const d of dates) years.push(Number(d.slice(0, 4)));

  const yearRange =
    years.length > 0 ? { min: Math.min(...years), max: Math.max(...years) } : null;

  return {
    cedulas: uniq(cedulas, 5),
    ibans: uniq(ibans, 6),
    emails: uniq(emails, 8),
    phones: dedupePhones(phones, 6),
    currencies: uniq(currencies, 3),
    dates: uniq(dates, 12),
    yearRange,
  };
}

/* -------------------------------------------------------------------------- */
/*                      Inferencias para columnas del xlsx                    */
/* -------------------------------------------------------------------------- */

const MONTH_RE =
  "(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|ene|abr|ago|set|dic)";

const mmdd = (m: number, d: number): string | null =>
  m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;

/**
 * Fragmento legible alrededor de un match: empieza en el inicio de la
 * oración que lo contiene y termina en el próximo fin de oración (tope
 * `span`), con "…" si hubo corte. Es un puntero para el revisor; el texto
 * completo lo lee la IA.
 */
function snippetAround(text: string, index: number, span = 280): string {
  const before = text.slice(Math.max(0, index - 200), index);
  const sentStart = Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n"), before.lastIndexOf(": "));
  const start = sentStart >= 0 ? index - (before.length - sentStart - 1) : Math.max(0, index - 40);
  let out = text.slice(start, start + span).replace(/\s+/g, " ").trim();
  const endIdx = out.search(/[.;]\s+[A-ZÁÉÍÓÚ(]/);
  if (endIdx > 40) out = out.slice(0, endIdx + 1);
  else if (out.length >= span - 1) out = out.replace(/\s\S*$/, "") + "…";
  return out;
}

function firstSnippet(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  if (!m || m.index === undefined) return null;
  return snippetAround(text, m.index);
}

function parseAmount(raw: string): number | null {
  // "1.006,40" (EU) → 1006.40 · "1,006.40" (US) → 1006.40 · "448,00" → 448 · "671.20" → 671.2
  let t = raw.replace(/[^\d.,]/g, "");
  if (!t) return null;
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // El último separador es el decimal.
    if (lastComma > lastDot) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
  } else if (lastComma > -1) {
    // Sólo comas: decimal si quedan 2 dígitos después; si no, miles.
    t = t.length - lastComma - 1 === 2 ? t.replace(",", ".") : t.replace(/,/g, "");
  } else if (lastDot > -1) {
    // Sólo puntos: miles si quedan exactamente 3 dígitos y hay más de un grupo ("1.006").
    if (t.length - lastDot - 1 === 3 && /^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? Math.round(n * 100) / 100 : null;
}

const SECTION_KEYS: { key: PreScanSection["key"]; re: RegExp }[] = [
  { key: "cancellation", re: /cancel|anulaci/i },
  { key: "payment", re: /payment|pago|deposit|dep[oó]sito|prepay|factur|invoice/i },
  { key: "children", re: /child|kids|ni[ñn]|menores|infant/i },
  { key: "checkin", re: /\bcheck[\s-]?in\b|\bcheck[\s-]?out\b|entrada\s+y\s+salida|hora\s+de\s+(?:entrada|salida|llegada)/i },
  { key: "meals", re: /meal|comida|alimentaci|breakfast|desayuno|dining/i },
  { key: "noshow", re: /no[\s-]?shows?/i },
  { key: "modifications", re: /modificat|modificac|changes?\b|cambios/i },
  { key: "guide", re: /guide|gu[ií]a|tour\s+leader|driver|chofer/i },
  { key: "extras", re: /extra|additional\s+services|servicios\s+adicionales|supplement/i },
  { key: "taxes", re: /tax|impuesto|iva/i },
  { key: "reservations", re: /reservation|reserva|booking|guarantee|garant/i },
  { key: "banking", re: /bank|banc|wire|transfer|cuenta/i },
];

/**
 * Secciona el texto por encabezados. Un encabezado es una línea corta
 * (≤ 70 chars, ≤ 8 palabras) que termina en ":" o está en MAYÚSCULAS /
 * Title Case, y no es una oración. Funciona en inglés y español porque la
 * forma del encabezado no depende del idioma; sólo la clave lo hace.
 */
export function extractSections(text: string): PreScanSection[] {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim());
  const isHeading = (l: string): boolean => {
    if (l.length < 4 || l.length > 70) return false;
    const words = l.replace(/:$/, "").split(" ");
    if (words.length > 8) return false;
    if (/[.;,]$/.test(l)) return false;
    if (/^\d+[.)]/.test(l) || /^[•·\-–*]/.test(l)) return false;
    if (!/^[A-ZÁÉÍÓÚ]/.test(l)) return false;
    // Más dígitos que letras = fila de tabla, no encabezado.
    const digitCount = (l.match(/\d/g) ?? []).length;
    const letterCount = (l.match(/[A-Za-zÁÉÍÓÚáéíóúñÑ]/g) ?? []).length;
    if (digitCount > letterCount / 2) return false;
    if (l.endsWith(":")) return true;
    const letters = l.replace(/[^A-Za-zÁÉÍÓÚáéíóúñÑ]/g, "");
    if (letters.length >= 4 && letters === letters.toUpperCase()) return true;
    const caps = words.filter((w) => /^[A-ZÁÉÍÓÚ]/.test(w)).length;
    return words.length >= 2 && caps / words.length >= 0.75 && !/\b(is|are|the|and|our|we|de|la|el|los|las|y)\b/.test(l.toLowerCase().split(" ").slice(1).join(" "));
  };
  const out: PreScanSection[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (!isHeading(l)) continue;
    const title = l.replace(/:$/, "").trim();
    const key = SECTION_KEYS.find((k) => k.re.test(title))?.key ?? "other";
    if (key === "other") continue;
    const body: string[] = [];
    let chars = 0;
    for (let j = i + 1; j < lines.length && chars < 700; j += 1) {
      const nl = lines[j]!;
      if (nl === "") {
        if (body.length > 0 && chars > 80) break;
        continue;
      }
      if (isHeading(nl) && SECTION_KEYS.some((k) => k.re.test(nl))) break;
      body.push(nl);
      chars += nl.length + 1;
    }
    const textOut = body.join(" ").trim();
    if (textOut.length < 15) continue;
    const dedupeKey = `${key}:${title.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ key, title, text: textOut.slice(0, 700) });
    if (out.length >= 16) break;
  }
  return out;
}

/**
 * Nombres de la propia agencia: nunca son "el proveedor" aunque aparezcan
 * con sufijo societario en cada contrato ("Travel Pioneers SRL").
 */
const OWN_COMPANY_KEYS = ["travel pioneers"];
const COMPANY_SUFFIX = "(?:S\\.?\\s?A\\.?|S\\.?R\\.?L\\.?|LLC\\.?|Ltda\\.?|Limitada|Inc\\.?|Corp\\.?|S\\.?A\\.?S\\.?|L\\.?L\\.?C\\.?)(?:\\s+Limited)?";

/**
 * Razón social del proveedor, por orden de confianza:
 *   1. Etiquetas bancarias / legales ("Beneficiary:", "Account name:",
 *      "Razón social:", "Legal name:", "Titular:") — ahí nunca firma una
 *      persona.
 *   2. Cualquier nombre con sufijo societario (S.A., SRL, LLC…) que no sea
 *      la propia agencia; gana el más frecuente.
 *   3. "Name:" genérico sólo si el valor trae sufijo societario (en los
 *      bloques de firma "NAME:" es una persona).
 */
function detectLegalName(text: string): string | null {
  const clean = (v: string) => v.replace(/\s+/g, " ").replace(/[,;]+$/, "").trim();
  const isOwn = (v: string) => OWN_COMPANY_KEYS.some((k) => normalizeKey(v).includes(k));
  const isPerson = (v: string) => /^(?:ms|mrs|mr|sr|sra|srta|dr|dra|lic|ing)\.?\s/i.test(v);

  const labelled = /(?:beneficiar[yio]o?|account\s+name|nombre\s+de\s+(?:la\s+)?cuenta|raz[oó]n\s+social|legal\s+name|company\s+name|nombre\s+(?:legal|jur[ií]dico|de\s+la\s+empresa)|titular|account\s+holder)\s*:\s*([^\n]{3,90})/gi;
  for (const m of text.matchAll(labelled)) {
    const v = clean(m[1]!);
    if (v.length >= 3 && !isOwn(v) && !isPerson(v)) return v;
  }

  const suffixRe = new RegExp(`\\b([A-ZÁÉÍÓÚ][\\w&'.áéíóúñÁÉÍÓÚÑ-]*(?:\\s+(?:de|del|la|las|los|y|and|of|&|[A-ZÁÉÍÓÚ][\\w&'.áéíóúñÁÉÍÓÚÑ-]*)){0,6}),?\\s${COMPANY_SUFFIX}\\b`, "g");
  const counts = new Map<string, { v: string; n: number }>();
  for (const m of text.matchAll(suffixRe)) {
    const v = clean(m[0]!);
    if (isOwn(v) || isPerson(v)) continue;
    const k = normalizeKey(v);
    const e = counts.get(k);
    if (e) e.n += 1;
    else counts.set(k, { v, n: 1 });
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  if (best) return best.v;

  const generic = /(?:^|\n)\s*(?:name|nombre)\s*:\s*([^\n]{3,90})/gi;
  const suffixOnly = new RegExp(`\\b${COMPANY_SUFFIX}\\b`);
  for (const m of text.matchAll(generic)) {
    const v = clean(m[1]!);
    if (suffixOnly.test(v) && !isOwn(v) && !isPerson(v)) return v;
  }
  return null;
}

export function extractInferences(rawText: string, facts: PreScanFacts): PreScanInferences {
  const text = rawText.slice(0, MAX_CHARS);
  const lower = text.toLowerCase();
  const head = text.slice(0, 2_500);

  /* Secciones por encabezado — genérico: una línea corta que termina en ":" o
     está en Title Case / MAYÚSCULAS y contiene una palabra clave, seguida del
     texto hasta el próximo encabezado. */
  const sections = extractSections(text);
  const sectionText = (key: PreScanSection["key"]): string | null =>
    sections.find((x) => x.key === key)?.text ?? null;

  /* País */
  let country: PreScanInferences["country"] = null;
  {
    const reasons: string[] = [];
    if (/costa\s+rica/i.test(text)) reasons.push("\"Costa Rica\" en el documento");
    if (/\+\s?506\b/.test(text)) reasons.push("teléfonos +506");
    if (facts.ibans.some((i) => i.startsWith("CR"))) reasons.push("IBAN CR");
    if (facts.cedulas.some((c) => /^\d-\d{3}-\d{6}$/.test(c))) reasons.push("cédula jurídica CR");
    if (reasons.length > 0) country = { value: "Costa Rica", reasons };
    else {
      const others: [RegExp, string][] = [
        [/\bpanam[aá]\b/i, "Panamá"], [/\bnicaragua\b/i, "Nicaragua"], [/\bguatemala\b/i, "Guatemala"],
        [/\bbelize\b|\bbelice\b/i, "Belice"], [/\bcolombia\b/i, "Colombia"], [/\bm[eé]xico\b/i, "México"],
        [/\bper[uú]\b/i, "Perú"], [/\becuador\b/i, "Ecuador"],
      ];
      for (const [re, name] of others) {
        if (re.test(text)) {
          country = { value: name, reasons: [`"${name}" en el documento`] };
          break;
        }
      }
    }
  }

  /* Vigencia */
  let validity: PreScanInferences["validity"] = null;
  {
    const explicit =
      /(?:valid(?:ity|o|a|ez)?|vigen(?:cia|te)s?|rates?\s+(?:are\s+)?valid|v[aá]lid[oa]s?|period\s+of|per[ií]odo\s+(?:de|del)?|contract\s+period|effective)\s*(?:from|desde|del|de)?\s*:?\s*([^\n)]{4,40}?)\s+(?:to|through|thru|until|hasta|al|a)\s+([^\n)]{4,40}?)(?:[.;\n)]|$)/i.exec(text);
    if (explicit) {
      const a = extractFacts(explicit[1]!).dates[0];
      const b = extractFacts(explicit[2]!).dates[0];
      if (a && b && a <= b) validity = { start: a, end: b, source: "explicit" };
    }
    if (!validity) {
      // Un único año prominente en el título ("NET RATES 2027") → año calendario.
      const yearsInHead = Array.from(head.matchAll(/\b(20[2-4]\d)\b/g), (m) => Number(m[1]));
      const distinct = Array.from(new Set(yearsInHead));
      if (distinct.length === 1) {
        const y = distinct[0]!;
        validity = { start: `${y}-01-01`, end: `${y}-12-31`, source: "year" };
      }
    }
  }

  /* Impuestos */
  let taxes: PreScanInferences["taxes"] = null;
  {
    const m =
      /(?:plus|\+|m[aá]s)\s+(?:the\s+)?(?:\d{1,2}\s*%\s+)?(?:legal\s+)?(?:tax(?:es)?|impuestos?|iva|vat)\s*(?:\(?\s*(\d{1,2})\s*%\)?)?/i.exec(text) ??
      /(?:tax(?:es)?|impuestos?|iva|vat)\s+(?:not\s+included|no\s+incluid[oa]s?)\s*(?:\(?\s*(\d{1,2})\s*%\)?)?/i.exec(text) ??
      /exclusive\s+of\s+(?:all\s+)?(?:applicable\s+)?(?:tax(?:es)?|vat|iva)(?:[^.\n]{0,40}?(\d{1,2})\s*%)?/i.exec(text) ??
      /(?:do(?:es)?\s+not|don't|no)\s+(?:include|incluye[n]?)\s+(?:the\s+)?(?:[\w\s]{0,25}?)(?:tax(?:es)?|vat|iva|impuestos?)[^.\n]{0,20}?(?:\(?\s*(\d{1,2})\s*%\)?)?/i.exec(text) ??
      /subject\s+to\s+(?:a\s+)?(\d{1,2})\s*%\s+(?:tax|vat|iva)/i.exec(text) ??
      /sujet[oa]s?\s+a(?:l)?\s+(?:\d{1,2}\s*%\s+de\s+)?(?:iva|impuesto)/i.exec(text);
    if (m) {
      const pct = m[1] ? Number(m[1]) : (/\b(13)\s*%/.exec(text)?.[1] ? 13 : null);
      taxes = { included: false, percent: pct, snippet: snippetAround(text, m.index) };
    } else {
      // "Included" sólo si NO hay negación justo antes: "rates aren't includes
      // taxes", "no incluye IVA", "do not include tax" significan lo contrario.
      const incRe = /(?:tax(?:es)?|impuestos?|iva|vat)\s+(?:are\s+)?(?:included|incluid[oa]s?)|(?:incluye[n]?|includes?|including)\s+(?:all\s+|the\s+|el\s+|los\s+)?(?:iva|impuestos?|tax(?:es)?|vat)|(?:iva|tax(?:es)?|vat)\s+incl\b/gi;
      let inc: RegExpExecArray | null = null;
      let negated: RegExpExecArray | null = null;
      for (const cand of text.matchAll(incRe)) {
        const before = text.slice(Math.max(0, (cand.index ?? 0) - 24), cand.index ?? 0);
        if (/\b(?:aren'?t|isn'?t|are\s+not|is\s+not|do(?:es)?\s*n'?t|do(?:es)?\s+not|not|no|sin|without|excl\w*)\s*$/i.test(before)) {
          negated = negated ?? (cand as RegExpExecArray);
          continue;
        }
        inc = cand as RegExpExecArray;
        break;
      }
      if (inc) {
        const pct = /\b(\d{1,2})\s*%\s*(?:iva|tax)/i.exec(text)?.[1];
        taxes = { included: true, percent: pct ? Number(pct) : null, snippet: snippetAround(text, inc.index) };
      } else if (negated) {
        const pct = /\b(\d{1,2})\s*%\s*(?:iva|tax|vat)/i.exec(text)?.[1] ?? /(?:iva|tax|vat)[^.\n]{0,15}?(\d{1,2})\s*%/i.exec(text)?.[1];
        taxes = { included: false, percent: pct ? Number(pct) : null, snippet: snippetAround(text, negated.index) };
      } else {
        const pctOnly = /\b(?:iva|tax(?:es)?)\s*:?\s*(\d{1,2})\s*%/i.exec(text) ?? /\b(\d{1,2})\s*%\s*(?:iva|tax)/i.exec(text);
        if (pctOnly) taxes = { included: null, percent: Number(pctOnly[1]), snippet: snippetAround(text, pctOnly.index) };
      }
    }
  }

  /* Comisión */
  let commission: PreScanInferences["commission"] = null;
  {
    const net = /\b(?:non|not)[\s-]*commission(?:able)?\b|\bno\s+comisionable|\bnet\s+rates?\b|\btarifas?\s+netas?\b|\bneto\b/i.exec(text);
    const pct = /\b(?:commission|comisi[oó]n)\w*\s*(?:of|del|de|:)?\s*(\d{1,2})\s*%|\b(\d{1,2})\s*%\s*(?:de\s+)?(?:commission|comisi[oó]n)/i.exec(text);
    if (pct) {
      commission = { net: false, percent: Number(pct[1] ?? pct[2]), snippet: snippetAround(text, pct.index) };
    } else if (net) {
      commission = { net: true, percent: null, snippet: snippetAround(text, net.index) };
    }
  }

  /* Base tarifaria */
  const rateBasis: string[] = [];
  if (/\bper\s+person\b|\bpor\s+persona\b|\bp\/p\b|\bpp\b/i.test(text)) rateBasis.push("por persona");
  if (/\bper\s+room\b|\bpor\s+habitaci[oó]n\b/i.test(text)) rateBasis.push("por habitación");
  if (/\bper\s+night\b|\bpor\s+noche\b|\bnightly\b/i.test(text)) rateBasis.push("por noche");
  if (/\bper\s+package\b|\bpor\s+paquete\b/i.test(text)) rateBasis.push("por paquete");
  if (/\bper\s+(?:vehicle|car|veh[ií]culo)\b/i.test(text)) rateBasis.push("por vehículo");

  /* Ocupaciones */
  const occupancies: string[] = [];
  const occ: [RegExp, string][] = [
    [/\bsgl\b|\bsingle\b|\bsencilla\b|\bindividual\b/i, "SGL"],
    [/\bdbl\b|\bdouble\b|\bdoble\b/i, "DBL"],
    [/\btpl\b|\btriple\b/i, "TPL"],
    [/\bqua\b|\bquad(?:ruple)?\b|\bcu[aá]druple\b/i, "QUA"],
    [/\bchild(?:ren)?\b|\bni[ñn][oa]s?\b|\bkids?\b/i, "CHD"],
  ];
  for (const [re, code] of occ) if (re.test(text)) occupancies.push(code);

  /* Temporadas: rangos "Jan 01 to March 31", "del 1 de enero al 31 de marzo", "01/01 - 31/03" */
  const seasons: PreScanSeason[] = [];
  {
    type Hit = { index: number; start: string; end: string };
    const hits: Hit[] = [];
    const enRange = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?\\s*(?:to|-|–|through|thru|until|hasta|al|a)\\s*${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi");
    for (const m of text.matchAll(enRange)) {
      const a = mmdd(MONTHS[m[1]!.toLowerCase()] ?? 0, Number(m[2]));
      const b = mmdd(MONTHS[m[3]!.toLowerCase()] ?? 0, Number(m[4]));
      if (a && b) hits.push({ index: m.index ?? 0, start: a, end: b });
    }
    // Mismo mes: "Feb 12-20", "March 12-27, 2027", "del 12 al 20 de febrero".
    const sameMonthEn = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|to|al|a)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:de\\s+)?${MONTH_RE})`, "gi");
    for (const m of text.matchAll(sameMonthEn)) {
      const mon = MONTHS[m[1]!.toLowerCase()] ?? 0;
      const a = mmdd(mon, Number(m[2]));
      const b = mmdd(mon, Number(m[3]));
      if (a && b && a < b) hits.push({ index: m.index ?? 0, start: a, end: b });
    }
    const sameMonthEs = new RegExp(`\\b(?:del?\\s+)?(\\d{1,2})\\s*(?:al|a|-|–)\\s*(\\d{1,2})\\s+de\\s+${MONTH_RE}\\b`, "gi");
    for (const m of text.matchAll(sameMonthEs)) {
      const mon = MONTHS[m[3]!.toLowerCase()] ?? 0;
      const a = mmdd(mon, Number(m[1]));
      const b = mmdd(mon, Number(m[2]));
      if (a && b && a < b) hits.push({ index: m.index ?? 0, start: a, end: b });
    }
    const esRange = new RegExp(`\\b(?:del?\\s+)?(\\d{1,2})\\s+de\\s+${MONTH_RE}\\s*(?:de\\s+\\d{4}\\s*)?(?:al?|hasta|-|–)\\s*(?:el\\s+)?(\\d{1,2})\\s+de\\s+${MONTH_RE}\\b`, "gi");
    for (const m of text.matchAll(esRange)) {
      const a = mmdd(MONTHS[m[2]!.toLowerCase()] ?? 0, Number(m[1]));
      const b = mmdd(MONTHS[m[4]!.toLowerCase()] ?? 0, Number(m[3]));
      if (a && b) hits.push({ index: m.index ?? 0, start: a, end: b });
    }
    for (const m of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})(?:[/.]\d{2,4})?\s*(?:-|–|to|al?|hasta|through)\s*(\d{1,2})[/.](\d{1,2})(?:[/.]\d{2,4})?\b/g)) {
      const a = mmdd(Number(m[2]), Number(m[1]));
      const b = mmdd(Number(m[4]), Number(m[3]));
      if (a && b) hits.push({ index: m.index ?? 0, start: a, end: b });
    }
    // Un rango que cubre todo el año (01-01→12-31) o que coincide con la
    // vigencia es el PERÍODO del contrato, no una temporada.
    const validityKey = validity ? `${validity.start.slice(5)}>${validity.end.slice(5)}` : null;
    const filteredHits = hits.filter((h) => {
      const k = `${h.start}>${h.end}`;
      if (k === "01-01>12-31") return false;
      if (validityKey && k === validityKey) return false;
      return true;
    });
    hits.length = 0;
    hits.push(...filteredHits);
    hits.sort((x, y) => x.index - y.index);

    // Etiquetas "High Season" / "Temporada baja" con su posición.
    const labelRe = /\b((?:very\s+)?(?:high|low|peak|green|holiday|shoulder|super\s+high|mid|regular|festive|christmas|premium)\s+(?:season|dates?|period|rates?)|(?:excluding\s+)?premium\s+dates?|rate\s+period\s*\d*|travel\s+window|temporada\s+(?:alta|baja|media|verde|regular|festiva|navide[ñn]a|super\s+alta|premium)|fechas?\s+premium|per[ií]odo\s+\d+)\b/gi;
    // Sólo etiquetas con mayúscula inicial ("High Season", "TEMPORADA ALTA"):
    // una mención en minúscula dentro de una oración ("during the low
    // season") no es un encabezado de tabla.
    const labels = Array.from(text.matchAll(labelRe), (m) => ({
      index: m.index ?? 0,
      name: m[1]!.replace(/\s+/g, " "),
    })).filter((l) => /^[A-ZÁÉÍÓÚ]/.test(l.name));

    // Dedupe conservando orden de aparición.
    const seen = new Set<string>();
    const uniqueHits = hits.filter((h) => {
      const key = `${h.start}>${h.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Agrupamos rangos consecutivos en "corridas": una temporada se escribe
    // como varios rangos en orden cronológico ("Jan 01–Mar 31 / Jun 01–Aug 31
    // / Nov 01–Dec 31"); cuando la fecha retrocede empieza otra temporada.
    // Luego asignamos etiquetas: las que preceden a la corrida en orden de
    // aparición (las tablas en columnas ponen "High Season  Low Season" y
    // después las fechas de ambas, así que el "más cercano" se equivoca).
    type Run = { index: number; ranges: { start: string; end: string }[] };
    const runs: Run[] = [];
    let prevEnd = "";
    for (const h of uniqueHits) {
      const last = runs[runs.length - 1];
      const gapTooBig = last ? h.index - last.index > 400 : true;
      if (!last || gapTooBig || h.start <= prevEnd) {
        runs.push({ index: h.index, ranges: [] });
      }
      runs[runs.length - 1]!.ranges.push({ start: h.start, end: h.end });
      prevEnd = h.end;
    }

    const used = new Set<number>();
    for (const run of runs) {
      // Etiquetas no usadas dentro de los 400 chars previos.
      const pool = labels
        .map((l, i) => ({ ...l, i }))
        .filter((l) => !used.has(l.i) && l.index < run.index && run.index - l.index <= 400);
      // Dos layouts: en COLUMNAS ("High Season   Low Season" en la misma
      // línea y luego las fechas de ambas) la primera corrida corresponde a
      // la etiqueta más a la izquierda; APILADO (etiqueta, fechas, etiqueta,
      // fechas) corresponde a la más cercana.
      let pick: (typeof pool)[number] | null = null;
      if (pool.length >= 2 && pool[pool.length - 1]!.index - pool[pool.length - 2]!.index <= 40) {
        pick = pool[pool.length - 2]!;
      } else {
        pick = pool[pool.length - 1] ?? null;
      }
      if (pick) used.add(pick.i);
      seasons.push({ name: pick?.name ?? null, ranges: run.ranges.slice(0, 8) });
      if (seasons.length >= 12) break;
    }
  }

  /* Mínimo de noches */
  let minNights: number | null = null;
  {
    const m =
      /\bminimum\s+(?:of\s+)?(\d{1,2})\s*(?:-|\s)?nights?\b|\b(\d{1,2})[\s-]*nights?\s+minimum\b|\bm[ií]nimo\s+(?:de\s+)?(\d{1,2})\s+noches?\b|\b(\d{1,2})\s+noches?\s+m[ií]nimo\b/i.exec(text);
    if (m) minNights = Number(m[1] ?? m[2] ?? m[3] ?? m[4]);
  }

  /* Políticas: sólo el primer snippet para que el revisor sepa que existen y dónde. */
  const childPolicy =
    sectionText("children") ??
    firstSnippet(
      text,
      /\b(?:child(?:ren)?|kids?|ni[ñn][oa]s?|menores|infants?)\b[^\n]{0,40}?\b(?:rate|tarifa|free|gratis|polic|pay|pagan?|%|years?|a[ñn]os)\b[^\n]{0,80}/i,
    );
  const cancellationPolicy =
    sectionText("cancellation") ??
    firstSnippet(
      text,
      /\b(?:cancell?ations?\s+polic(?:y|ies)|pol[ií]tica\s+de\s+cancelaci[oó]n|cancelaci[oó]n(?:es)?|cancell?ation\s+(?:fee|charge|terms))\b[^\n]{0,120}/i,
    );
  const paymentPolicy =
    sectionText("payment") ??
    firstSnippet(text, /\b(?:deposit|dep[oó]sito|payment\s+(?:terms|policy)|pol[ií]tica\s+de\s+pago|forma\s+de\s+pago|prepay(?:ment)?|prepago)\b[^\n]{0,120}/i);

  /* Oraciones (para términos estructurados) */
  // Los PDF traen saltos de línea duros dentro de las oraciones: primero
  // des-envolvemos (newline → espacio) y luego cortamos sólo en límites
  // reales: fin de oración, viñetas, ítems numerados y etiquetas "Xxx:".
  const sentences = text
    .replace(/[•·▪●■\uf0b7\uf0a7\uf076\u2022\u25aa]/g, " ¶ ")
    // Un párrafo sin punto final ("…for any tour\n\nInto PEAK SEASON…") es
    // un límite de oración aunque no haya puntuación.
    .replace(/\s*\r?\n\s*\r?\n\s*/g, " ¶ ")
    .replace(/\s*\r?\n\s*/g, " ")
    .split(/(?<=[.;])\s+(?=[A-ZÁÉÍÓÚ(\d])|\s*¶\s*|\s+(?=\d{1,2}\.\s+[A-ZÁÉÍÓÚ])|\s+(?=[A-ZÁÉÍÓÚ][A-Za-zÁÉÍÓÚáéíóúñ /&-]{2,40}:\s)/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter((x) => x.length >= 12 && x.length <= 600);
  const HIGH_RE = /\b(?:high|peak|holiday|festive)\s+season|temporada\s+(?:alta|festiva|navide[ñn]a)/i;
  const LOW_RE = /\blow\s+season|temporada\s+baja/i;
  const seasonOf = (sent: string): string | null =>
    HIGH_RE.test(sent) && LOW_RE.test(sent) ? "both" : HIGH_RE.test(sent) ? "high" : LOW_RE.test(sent) ? "low" : null;

  /* Pago: "100% payment is required 45 days prior … high season and 30 days … low season" */
  const paymentTerms: PreScanTerm[] = [];
  for (const sent of sentences) {
    if (!/\b(payment|paid|pay|deposit|prepay\w*|pago|pagad[oa]s?|pagar|dep[oó]sito|prepago|abono)\b/i.test(sent)) continue;
    if (/\bcancel|cancelaci/i.test(sent)) continue;
    // Intereses de mora, multas o comisiones no son condiciones de pago.
    if (/\b(interest|inter[eé]s|late\s+payment|mora|per\s+month|mensual|penalt|fee\b|violation)/i.test(sent)) continue;
    // Debe hablar de un plazo o de una exigencia de pago, no de cualquier "pay".
    if (!/\b(days?|d[ií]as?|hours?|horas?|before|prior|antes|previo|required|due|must|deber[aá]n?|debe|at\s+(?:the\s+)?time\s+of|al\s+momento)\b/i.test(sent)) continue;
    if (!/\d/.test(sent)) continue;
    const pct = /(\d{1,3})\s?%/.exec(sent) ?? (/\b(?:full|total|100)\b[^.]{0,20}\b(?:payment|pago)|\b(?:in\s+full|por\s+completo)\b/i.test(sent) ? (["", "100"] as unknown as RegExpExecArray) : null);
    const days = Array.from(sent.matchAll(/(\d{1,3})\s*(?:-|\s)?\s*(?:days?|d[ií]as?)\b/gi), (m) => Number(m[1]));
    if (!pct && days.length === 0) continue;
    const season = seasonOf(sent);
    if (season === "both" && days.length >= 2) {
      // "45 days … high season and 30 days … low season": partimos en dos términos.
      const hiFirst = sent.search(HIGH_RE) < sent.search(LOW_RE);
      paymentTerms.push({ daysBefore: days[0]!, percent: pct ? Number(pct[1]) : null, season: hiFirst ? "high" : "low", sentence: sent });
      paymentTerms.push({ daysBefore: days[1]!, percent: pct ? Number(pct[1]) : null, season: hiFirst ? "low" : "high", sentence: sent });
    } else {
      // Varios plazos en una oración ("…72 hours… / …14 days…") → un término por plazo.
      const distinct = [...new Set(days)].slice(0, 3);
      if (distinct.length === 0) distinct.push(null as unknown as number);
      for (const d of distinct) {
        paymentTerms.push({ daysBefore: d ?? null, percent: pct ? Number(pct[1]) : null, season: season === "both" ? null : season, sentence: sent });
      }
    }
    if (paymentTerms.length >= 6) break;
  }

  /* Cancelación: "within 45 days … high season … charged 100%", "more than 45 days … without charge" */
  const cancellationTerms: PreScanTerm[] = [];
  for (const sent of sentences) {
    if (!/\bcancel|cancelaci/i.test(sent)) continue;
    // Días u horas ("72 hours before"): las horas se expresan como días decimales.
    const days = [
      ...Array.from(sent.matchAll(/(\d{1,3})\s*(?:-|\s)?\s*(?:days?|d[ií]as?)\b/gi), (m) => Number(m[1])),
      ...Array.from(sent.matchAll(/(\d{1,3})\s*(?:-|\s)?\s*(?:hours?|horas?|hrs?)\b/gi), (m) => Math.round((Number(m[1]) / 24) * 100) / 100),
    ];
    if (days.length === 0) continue;
    const pctM = /(\d{1,3})\s?%/.exec(sent);
    const free = /\b(without\s+(?:charge|penalty|cost)|no\s+charge|free\s+of\s+charge|sin\s+(?:cargo|costo|penalidad)|full\s+refund|reembolso\s+total)\b/i.test(sent);
    const noRefund = /\b(no\s+refunds?|non[-\s]?refundable|not\s+refundable|sin\s+reembolso|no\s+reembolsable|charged\s+100|100\s?%)\b/i.test(sent);
    const percent = pctM ? Number(pctM[1]) : free ? 0 : noRefund ? 100 : null;
    const season = seasonOf(sent);
    if (season === "both" && days.length >= 2) {
      const hiFirst = sent.search(HIGH_RE) < sent.search(LOW_RE);
      cancellationTerms.push({ daysBefore: days[0]!, percent, season: hiFirst ? "high" : "low", sentence: sent });
      cancellationTerms.push({ daysBefore: days[1]!, percent, season: hiFirst ? "low" : "high", sentence: sent });
    } else {
      // Varios plazos en una oración → un término por plazo (orden de aparición).
      const ordered = [
        ...Array.from(sent.matchAll(/(\d{1,3})\s*(?:-|\s)?\s*(?:days?|d[ií]as?|hours?|horas?|hrs?)\b/gi), (m) => ({
          at: m.index ?? 0,
          d: /hour|hora|hrs/i.test(m[0]) ? Math.round((Number(m[1]) / 24) * 100) / 100 : Number(m[1]),
        })),
      ].sort((a, b) => a.at - b.at);
      const seen = new Set<number>();
      for (const { d } of ordered) {
        if (seen.has(d)) continue;
        seen.add(d);
        // Si la oración menciona temporada sólo para el segundo plazo
        // ("…72 hours… Into PEAK SEASON … 14 days…"), el primero es general.
        const seasonForThis = season && ordered.length > 1 && seen.size === 1 && sent.search(HIGH_RE) > sent.indexOf(String(d)) ? null : season === "both" ? null : season;
        cancellationTerms.push({ daysBefore: d, percent, season: seasonForThis, sentence: sent });
        if (seen.size >= 3) break;
      }
    }
    if (cancellationTerms.length >= 6) break;
  }

  /* Niños: oraciones con niños + (free | % | $ | edad) */
  const childTerms: string[] = [];
  for (const sent of sentences) {
    if (!/\b(child(?:ren)?|kids?|ni[ñn][oa]s?|menores|infants?|beb[eé]s?)\b/i.test(sent)) continue;
    if (!/\b(free|gratis|complimentary|%|years?|a[ñn]os|rate|tarifa|pay|pagan?|cobra)\b|[$₡€]/i.test(sent)) continue;
    childTerms.push(sent.slice(0, 220));
    if (childTerms.length >= 4) break;
  }

  /* Check-in / check-out */
  const checkIn = /check[\s-]?in[^0-9\n]{0,25}(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s?m\.?|hrs?|h)?)/i.exec(text)?.[1]?.trim() ?? null;
  const checkOut = /check[\s-]?out[^0-9\n]{0,25}(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s?m\.?|hrs?|h)?)/i.exec(text)?.[1]?.trim() ?? null;

  /* Comidas */
  const meals: string[] = [];
  for (const sent of sentences) {
    if (!/\b(meals?|breakfast|lunch|dinner|desayunos?|almuerzos?|cenas?|all[\s-]inclusive|todo\s+incluido|pensi[oó]n|half\s+board|full\s+board|plan\s+de\s+comidas)\b/i.test(sent)) continue;
    if (!/\b(?:includ\w*|incluy\w*|incluid\w*|complimentary|cortes[ií]a|not\s+included|no\s+incluid\w*)\b|\d\s*(?:breakfasts?|lunch(?:es)?|dinners?|desayunos?|almuerzos?|cenas?)/i.test(sent)) continue;
    meals.push(sent.slice(0, 160));
    if (meals.length >= 4) break;
  }

  /* Razón social / dirección / web */
  const legalName = detectLegalName(text);
  let address: string | null = null;
  for (const m of text.matchAll(/(?:^|\n)\s*((?:[A-Za-z]+\s+){0,2})(?:address|direcci[oó]n|domicilio)\s*:\s*([^\n]{5,140})/gi)) {
    if (/\b(bank|banco|billing|factura)\b/i.test(m[1] ?? "")) continue;
    address = m[2]!.trim();
    break;
  }
  const website = /\b(?:https?:\/\/)?(?:www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[\w\-./?%&=]*)?/i.exec(text)?.[0] ?? null;

  /* Cuentas bancarias: por cada IBAN, banco / moneda / nº de cuenta cercanos. */
  const bankAccounts: PreScanBankAccount[] = [];
  {
    // Sin /i: la parte "Nombre Propio" debe ir en mayúscula inicial para no
    // arrastrar etiquetas ("Banco Nacional Cuenta en Dolares").
    const bankRe = /\b((?:[Bb]anco|BANCO|[Bb]ank|BANK)\s+(?:de\s+|of\s+)?[A-ZÁÉÍÓÚ][\wÁÉÍÓÚáéíóú.&-]*(?:\s+(?:de|del|of|the)\s+[A-ZÁÉÍÓÚ][\wÁÉÍÓÚáéíóú.&-]*|\s+[A-ZÁÉÍÓÚ][\wÁÉÍÓÚáéíóú.&-]*){0,2}|[A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,2}\s+(?:Bank|BANK)|\bBAC\b(?:\s+(?:San\s+Jos[eé]|Credomatic))?|\bBCR\b|\bBCT\b|\bBNCR\b|Scotiabank|Davivienda|Promerica|Lafise|Coopenae|Mucap|Banco\s+Popular)/g;
    const cleanBank = (raw: string): string => {
      // "rioslodge.com BCT BANK" → "BCT BANK": fuera tokens con ./@/: (urls,
      // correos) y lo que quede antes de ellos.
      const toks = raw.replace(/\s+/g, " ").trim().split(" ");
      let start = 0;
      toks.forEach((t, i) => {
        if (/[.@:/]/.test(t) && !/^(?:S\.?A\.?|Ltda\.?|Inc\.?)$/i.test(t)) start = i + 1;
      });
      // Corta en palabras de etiqueta que no son parte del nombre del banco.
      const stop = /^(?:cuenta|account|swift|iban|currency|moneda|tipo|type|n[uú]mero|number|usd|crc|eur|colones|d[oó]lares|dollars?|address|direcci[oó]n|beneficiar\w*)$/i;
      const cut = toks.slice(start).findIndex((t) => stop.test(t));
      return (cut === -1 ? toks.slice(start) : toks.slice(start, start + cut)).join(" ").trim();
    };
    const banks = Array.from(text.matchAll(bankRe), (m) => ({ index: m.index ?? 0, name: cleanBank(m[1]!) })).filter((b) => b.name.length >= 3);
    // Banco: el más cercano, antes (hasta 800 chars) o en la misma línea /
    // celda siguiente (hasta 120 chars después: "CR73… Banco Nacional").
    const nearestBank = (idx: number, endIdx: number): string | null => {
      let best: { index: number; name: string; dist: number } | null = null;
      for (const b of banks) {
        const dist = b.index < idx ? idx - b.index : b.index - endIdx;
        if (b.index < idx ? dist <= 800 : dist <= 120) {
          const weighted = b.index < idx ? dist : dist * 2; // preferir "antes" en empate
          if (!best || weighted < best.dist) best = { index: b.index, name: b.name, dist: weighted };
        }
      }
      return best?.name ?? null;
    };
    const seenIban = new Set<string>();
    const usedAccounts = new Set<string>();
    const ibanRe = /\b(CR\s?\d{2}(?:\s?\d{4}){4}\s?\d{2}|[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?)\b/g;
    // Spans de TODOS los IBAN: un nº de cuenta candidato que caiga dentro de
    // un IBAN es parte del IBAN, no una cuenta. (No filtramos por substring:
    // los IBAN de Costa Rica CONTIENEN el número de cuenta — CR30 010
    // 71030210467522 9 — y descartaríamos justo el correcto.)
    const ibanSpans = Array.from(text.matchAll(ibanRe), (x) => [x.index ?? 0, (x.index ?? 0) + x[0].length] as const);
    const insideIban = (abs: number) => ibanSpans.some(([a, b]) => abs >= a && abs < b);
    for (const m of text.matchAll(ibanRe)) {
      const iban = m[1]!.replace(/\s+/g, "").toUpperCase();
      if (iban.length < 15 || seenIban.has(iban)) continue;
      seenIban.add(iban);
      const idx = m.index ?? 0;
      const before = text.slice(Math.max(0, idx - 260), idx);
      // Moneda: la mención más cercana ANTES del IBAN ("US Dollars … IBAN",
      // "Costa Rican Colones … IBAN", "Checking Account | Dollar | …").
      const curWords = [...before.matchAll(/\b(colones|col[oó]n|crc|d[oó]lares?|dollars?|usd|euros?|eur)\b/gi)];
      const curWord = curWords.pop()?.[1] ?? null;
      const cur = curWord ? (/^(col|crc)/i.test(curWord) ? "CRC" : /^(eur)/i.test(curWord) ? "EUR" : "USD") : null;
      // Nº de cuenta: el más cercano (antes o después, ±220 chars) que no
      // sea parte del IBAN ni esté ya asignado a otra cuenta.
      const winStart = Math.max(0, idx - 220);
      const window = text.slice(winStart, Math.min(text.length, idx + m[0].length + 220));
      const acctCands = [...window.matchAll(/(?<![\d-])#?(\d{9,20})(?![\d-])/g)]
        .map((x) => {
          const abs = winStart + (x.index ?? 0) + (x[0].startsWith("#") ? 1 : 0);
          return { n: x[1]!, abs, dist: Math.abs(abs - idx) };
        })
        .filter((x) => !insideIban(x.abs) && !usedAccounts.has(x.n))
        .sort((a, b) => a.dist - b.dist);
      const acct = acctCands[0]?.n ?? null;
      if (acct) usedAccounts.add(acct);
      bankAccounts.push({ bank: nearestBank(idx, idx + m[0].length), currency: cur, accountNumber: acct, iban });
      if (bankAccounts.length >= 6) break;
    }
    // Cuentas sin IBAN: "Cuenta corriente: 100-01-000-123456-7"
    if (bankAccounts.length === 0) {
      for (const m of text.matchAll(/(?:cuenta(?:\s+(?:corriente|cliente|bancaria|n[uú]mero|no\.?|#))?|account(?:\s+(?:number|no\.?|#))?)\s*:?\s*([\d-]{9,25})\b/gi)) {
        const idx = m.index ?? 0;
        bankAccounts.push({ bank: nearestBank(idx, idx + m[0].length), currency: null, accountNumber: m[1]!, iban: null });
        if (bankAccounts.length >= 4) break;
      }
    }
  }

  /* Precios */
  const prices: number[] = [];
  let priceMentions = 0;
  {
    const seen = new Set<number>();
    // `[ \t]{0,6}`: en tablas el símbolo y el monto van en celdas distintas
    // ("$      150", "$\t30,00").
    const re = /(?:(?:US\$|USD|\$|₡|CRC|€|EUR)[ \t]{0,6})(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?)\b|\b(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)[ \t]{0,3}(?:USD|US\$|CRC|EUR)\b/g;
    for (const m of text.matchAll(re)) {
      const n = parseAmount(m[1] ?? m[2] ?? "");
      if (n === null || n < 1) continue;
      priceMentions += 1;
      if (!seen.has(n) && seen.size < 500) {
        seen.add(n);
        prices.push(n);
      }
    }
    prices.sort((a, b) => a - b);
  }

  /* Productos mencionados: líneas cortas tipo título con palabras de producto. */
  const productHints: string[] = [];
  {
    const kw = /\b(room|rooms|suite|suites|villa|villas|bungalow|cabin|cabina|cabinas|casita|habitaci[oó]n|habitaciones|package|paquete|tour|tours|transfer|traslado|shuttle|tent|glamping|lodge\s+package|deluxe|standard|superior|junior|master|premium|family|familiar)\b/i;
    const seen = new Set<string>();
    for (const rawLine of text.split(/\r?\n/)) {
      let line = rawLine.replace(/^[\s•·\-–*\uf0b7\uf0a7\uf076]+/, "").replace(/\s+/g, " ").trim();
      // Tablas en columnas duplican el encabezado: "X X" → "X".
      const half = Math.floor(line.length / 2);
      if (line.length >= 8 && line.length % 2 === 1 && line.slice(0, half) === line.slice(half + 1)) {
        line = line.slice(0, half);
      }
      if (line.length < 6 || line.length > 70) continue;
      if (!kw.test(line)) continue;
      if (/[$₡€]|\d{3}[.,]\d{2}|\bper\b|\bpor\b|\binclude|\bincluye|\boccupancy\b|\bocupaci[oó]n\b|[.:;,]$/i.test(line)) continue;
      const words = line.split(" ");
      if (words.length < 2 || words.length > 8) continue;
      if (/^[a-z]/.test(line)) continue;
      // Título, no oración: mayoría de palabras capitalizadas y sin verbos
      // típicos de frase ("There are 4 Suite Rooms…").
      const caps = words.filter((w) => /^[A-ZÁÉÍÓÚ0-9]/.test(w)).length;
      if (caps / words.length < 0.6) continue;
      if (/^(there|our|we|the|this|these|all|each|hay|nuestr|todos|cada|los|las)\b/i.test(line)) continue;
      // Fragmentos de celda: empieza con "(", termina en "*" o en preposición colgante.
      if (/^[(\[]/.test(line) || /[*]$/.test(line) || /\b(at|with|in|de|con|en|del|para|por|and|y|or|o)$/i.test(line)) continue;
      // Encabezados de sección, no productos.
      if (/\b(polic(?:y|ies)|pol[ií]ticas?|fees?|tarifas?|rates?|descriptions?|descripci[oó]n|notes?|notas?|terms|t[eé]rminos|conditions|condiciones|length|duraci[oó]n|methods?|payments?|pagos?|reservations?|reservaci[oó]n|contact)\b/i.test(line)) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      productHints.push(line);
      if (productHints.length >= 20) break;
    }
  }

  /* Grilla: ¿cuántos productos explican los precios? */
  let estimatedProducts: number | null = null;
  {
    const nOcc = occupancies.filter((o) => o !== "CHD").length;
    const nSea = Math.max(1, seasons.length);
    const divisor = nOcc >= 2 ? nOcc * nSea : nSea > 1 ? nSea : 0;
    if (divisor > 0 && priceMentions >= divisor && priceMentions % divisor === 0) {
      estimatedProducts = priceMentions / divisor;
    }
  }

  void lower;
  return {
    legalName,
    address,
    website,
    checkIn,
    checkOut,
    meals,
    paymentTerms,
    cancellationTerms,
    childTerms,
    bankAccounts,
    sections,
    estimatedProducts,
    country,
    validity,
    taxes,
    commission,
    rateBasis,
    occupancies,
    seasons,
    minNights,
    childPolicy,
    cancellationPolicy,
    paymentPolicy,
    prices,
    priceMentions,
    productHints,
  };
}

/* -------------------------------------------------------------------------- */
/*                          Historial del proveedor                           */
/* -------------------------------------------------------------------------- */

interface PreviousRow {
  id: string;
  processed_at: Date;
  filename: string;
  shared_fields: Record<string, unknown> | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const digits = (v: string | null): string => (v ?? "").replace(/\D/g, "");

export async function findPreviousRuns(codigo: string): Promise<PreScanPreviousRun[]> {
  const rows = await prisma.$queryRaw<PreviousRow[]>`
    SELECT id, processed_at, filename, shared_fields
    FROM contract_runs
    WHERE catalog_prefill ->> 'proveedor_codigo' = ${codigo}
    ORDER BY processed_at DESC
    LIMIT 3
  `;
  return rows.map((r) => {
    const sf = r.shared_fields ?? {};
    return {
      id: r.id,
      processedAt: r.processed_at.toISOString(),
      filename: r.filename,
      cedula: str(sf.cedula),
      numero_cuenta: str(sf.numero_cuenta),
      banco: str(sf.banco),
      tipo_moneda: str(sf.tipo_moneda),
      contract_starts: str(sf.contract_starts),
      contract_ends: str(sf.contract_ends),
      reservations_email: str(sf.reservations_email),
    };
  });
}

/**
 * Avisos para el revisor comparando el último contrato procesado del mismo
 * proveedor con lo que dice este documento. Sólo señalamos cuando tenemos
 * evidencia en ambos lados — ausencia de dato no es cambio.
 */
export function buildWarnings(prev: PreScanPreviousRun, facts: PreScanFacts, textAvailable: boolean): string[] {
  const out: string[] = [];
  if (!textAvailable) return out;

  const prevAcct = digits(prev.numero_cuenta);
  if (prevAcct.length >= 8 && facts.ibans.length > 0) {
    const found = facts.ibans.some((i) => digits(i).includes(prevAcct) || prevAcct.includes(digits(i)));
    if (!found) {
      out.push(
        `La cuenta bancaria del contrato anterior (${prev.numero_cuenta}) no aparece en este documento; este menciona ${facts.ibans.join(", ")}. Verifica el cambio de cuenta antes de cargar.`,
      );
    }
  }

  const prevCed = digits(prev.cedula);
  if (prevCed.length >= 9 && facts.cedulas.length > 0) {
    const found = facts.cedulas.some((c) => digits(c) === prevCed);
    if (!found) {
      out.push(
        `La cédula del contrato anterior (${prev.cedula}) no coincide con la(s) de este documento (${facts.cedulas.join(", ")}).`,
      );
    }
  }

  if (prev.tipo_moneda && facts.currencies.length > 0) {
    const prevCur = prev.tipo_moneda.toUpperCase();
    if (!facts.currencies.some((c) => prevCur.includes(c))) {
      out.push(`El contrato anterior estaba en ${prev.tipo_moneda}; este documento menciona ${facts.currencies.join(", ")}.`);
    }
  }

  if (prev.contract_ends && facts.yearRange) {
    const endYear = Number(prev.contract_ends.slice(0, 4));
    if (Number.isFinite(endYear) && facts.yearRange.max <= endYear - 1) {
      out.push(
        `Este documento sólo menciona años hasta ${facts.yearRange.max}, pero el contrato anterior vencía en ${prev.contract_ends}. ¿Es una versión vieja?`,
      );
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*                                Orquestación                                */
/* -------------------------------------------------------------------------- */

/**
 * El maestro cambia poco y cada pre-scan lo necesita entero: lo cacheamos
 * 30 s en memoria para no ir a la DB por cada archivo que el usuario suelta
 * (y para que un usuario que prueba 5 PDFs seguidos no haga 5 queries).
 */
const SUPPLIER_CACHE_TTL_MS = 30_000;
let supplierCache: { at: number; data: SupplierLite[] } | null = null;

async function loadSuppliersCached(): Promise<SupplierLite[]> {
  if (supplierCache && Date.now() - supplierCache.at < SUPPLIER_CACHE_TTL_MS) {
    return supplierCache.data;
  }
  const rows = await prisma.supplier.findMany({
    select: {
      id: true,
      codigo: true,
      nombre: true,
      actividad: true,
      zona: true,
      _count: { select: { servicios: true } },
    },
  });
  const data = rows.map((s) => ({
    id: s.id,
    codigo: s.codigo,
    nombre: s.nombre,
    actividad: s.actividad,
    zona: s.zona,
    serviceCount: s._count.servicios,
  }));
  supplierCache = { at: Date.now(), data };
  return data;
}

/** Lo llama el controller de proveedores tras cualquier escritura. */
export function invalidateSupplierCache(): void {
  supplierCache = null;
}

export interface PreScanInputFile {
  kind: SupportedDocKind;
  buffer: Buffer;
  filename: string;
}

const EMPTY_FACTS: PreScanFacts = {
  cedulas: [], ibans: [], emails: [], phones: [], currencies: [], dates: [], yearRange: null,
};
const EMPTY_INFERENCES: PreScanInferences = {
  legalName: null, address: null, website: null, checkIn: null, checkOut: null, meals: [],
  paymentTerms: [], cancellationTerms: [], childTerms: [], bankAccounts: [], sections: [], estimatedProducts: null,
  country: null, validity: null, taxes: null, commission: null, rateBasis: [], occupancies: [],
  seasons: [], minNights: null, childPolicy: null, cancellationPolicy: null, paymentPolicy: null,
  prices: [], priceMentions: 0, productHints: [],
};

interface ScannedDoc {
  input: PreScanInputFile;
  role: "primary" | "secondary";
  text: string;
  textAvailable: boolean;
  pages: { scanned: number; total: number } | null;
  facts: PreScanFacts;
  inferences: PreScanInferences;
}

async function scanOne(input: PreScanInputFile, role: "primary" | "secondary"): Promise<ScannedDoc> {
  let layer: TextLayer | null = null;
  try {
    layer = await extractTextLayer(input.kind, input.buffer);
  } catch (err) {
    // Un PDF corrupto o protegido no debe romper el Paso 1: seguimos sin texto.
    logger.warn("pre-scan: text layer failed", {
      filename: input.filename,
      kind: input.kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const rawText = layer?.text?.trim() ?? "";
  // Un PDF escaneado puede devolver unas pocas letras de ruido: tratamos
  // < 80 caracteres como "sin texto".
  const textAvailable = rawText.length >= 80;
  // Encabezados/pies de página (logo, teléfonos, web) se repiten en cada
  // página y se pegan a las oraciones. Antes de analizar, extraemos los
  // datos de contacto de esas líneas (ahí suelen vivir) y luego las quitamos.
  const { text, repeated } =
    textAvailable && layer?.pageTexts && layer.pageTexts.length >= 3
      ? stripHeadersAndFooters(layer.pageTexts)
      : { text: rawText, repeated: "" };
  const facts = textAvailable ? mergeFacts(extractFacts(text), extractFacts(repeated)) : EMPTY_FACTS;
  const inferences = textAvailable ? extractInferences(text, facts) : EMPTY_INFERENCES;
  // Un documento sin precios (hoja de cuentas bancarias, políticas) no
  // define la moneda de las tarifas: "Cuenta en Colones" no vota.
  const factsOut = inferences.priceMentions === 0 ? { ...facts, currencies: [] } : facts;
  return { input, role, text, textAvailable, pages: layer?.pages ?? null, facts: factsOut, inferences };
}

const unionStr = (lists: string[][], cap: number): string[] => uniq(lists.flat(), cap);

/**
 * Quita encabezados y pies de página: líneas que (a) están entre las 2
 * primeras o 2 últimas líneas no vacías de una página y (b) se repiten en
 * ≥ 3 páginas. Las dos condiciones juntas evitan borrar contenido que
 * también se repite (p. ej. la línea de temporadas en cada tabla de
 * tarifas). Las líneas quitadas se devuelven aparte para seguir extrayendo
 * teléfonos / correos / web, que suelen vivir ahí.
 */
function stripHeadersAndFooters(pageTexts: string[]): { text: string; repeated: string } {
  const norm = (l: string) => l.replace(/\s+/g, " ").trim();
  const edgeCounts = new Map<string, number>();
  const pagesLines = pageTexts.map((pt) => pt.split(/\r?\n/));
  for (const lines of pagesLines) {
    const nonEmpty = lines.map(norm).filter((l) => l.length > 0);
    const edges = new Set([...nonEmpty.slice(0, 2), ...nonEmpty.slice(-2)]);
    for (const e of edges) if (e.length >= 8) edgeCounts.set(e, (edgeCounts.get(e) ?? 0) + 1);
  }
  const minPages = Math.max(3, Math.ceil(pageTexts.length * 0.5));
  const repeatedKeys = new Set([...edgeCounts.entries()].filter(([, n]) => n >= minPages).map(([k]) => k));
  if (repeatedKeys.size === 0) return { text: pageTexts.join("\n"), repeated: "" };
  const kept: string[] = [];
  for (const lines of pagesLines) {
    const nonEmpty = lines.map(norm).filter((l) => l.length > 0);
    const edges = new Set([...nonEmpty.slice(0, 2), ...nonEmpty.slice(-2)]);
    for (const l of lines) {
      const k = norm(l);
      if (repeatedKeys.has(k) && edges.has(k)) continue;
      kept.push(l);
    }
  }
  return { text: kept.join("\n"), repeated: [...repeatedKeys].join("\n") };
}

function mergeFacts(a: PreScanFacts, b: PreScanFacts): PreScanFacts {
  const years = [a.yearRange, b.yearRange].filter((y): y is { min: number; max: number } => y !== null);
  return {
    cedulas: uniq([...a.cedulas, ...b.cedulas], 5),
    ibans: uniq([...a.ibans, ...b.ibans], 6),
    emails: uniq([...a.emails, ...b.emails], 8),
    phones: dedupePhones([...a.phones, ...b.phones], 6),
    currencies: a.currencies.length > 0 ? a.currencies : b.currencies,
    dates: uniq([...a.dates, ...b.dates], 12),
    yearRange: years.length > 0 ? { min: Math.min(...years.map((y) => y.min)), max: Math.max(...years.map((y) => y.max)) } : null,
  };
}

/**
 * Fusiona lo leído en varios documentos. Regla: el primario manda en los
 * campos escalares (vigencia, impuestos, comisión, temporadas); los
 * secundarios sólo rellenan lo que el primario no tiene. Las listas se unen.
 * Caso típico: tarifario (precios, temporadas) + documento de políticas
 * (cancelación, pago, cuenta bancaria, cédula).
 */
/**
 * Los documentos son PARES: ninguno manda. Para cada campo escalar tomamos
 * el valor en el que los documentos coinciden; si hay más de un valor
 * distinto, usamos el del documento que lo menciona con más contexto
 * (orden de llegada como desempate) y registramos un CONFLICTO para que el
 * revisor lo vea — p. ej. el tarifario dice "temporada baja hasta el 31 de
 * octubre" y el documento de políticas "hasta el 1 de noviembre".
 */
function mergeDocs(docs: ScannedDoc[]): { facts: PreScanFacts; inferences: PreScanInferences; conflicts: string[] } {
  const withText = docs.filter((d) => d.textAvailable);
  if (withText.length === 0) return { facts: EMPTY_FACTS, inferences: EMPTY_INFERENCES, conflicts: [] };
  const conflicts: string[] = [];
  const name = (d: ScannedDoc) => `"${d.input.filename}"`;

  /** Primer valor no nulo; si otros documentos tienen un valor distinto, lo reporta. */
  const agree = <T,>(label: string, pick: (d: ScannedDoc) => T | null, show: (v: T) => string): T | null => {
    const found = withText
      .map((d) => ({ d, v: pick(d) }))
      .filter((x): x is { d: ScannedDoc; v: T } => x.v !== null && x.v !== undefined);
    if (found.length === 0) return null;
    const first = found[0]!;
    const distinct = new Map<string, { d: ScannedDoc; v: T }>();
    for (const f of found) {
      const k = show(f.v);
      if (!distinct.has(k)) distinct.set(k, f);
    }
    if (distinct.size > 1) {
      conflicts.push(
        `${label}: ` + [...distinct.values()].map((x) => `${name(x.d)} dice ${show(x.v)}`).join("; ") + ". Verifica cuál aplica.",
      );
    }
    return first.v;
  };
  const firstNonNull = <T,>(pick: (d: ScannedDoc) => T | null): T | null => {
    for (const d of withText) {
      const v = pick(d);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  const years = withText.map((d) => d.facts.yearRange).filter((y): y is { min: number; max: number } => y !== null);
  const facts: PreScanFacts = {
    cedulas: unionStr(withText.map((d) => d.facts.cedulas), 5),
    ibans: unionStr(withText.map((d) => d.facts.ibans), 6),
    emails: unionStr(withText.map((d) => d.facts.emails), 8),
    phones: dedupePhones(withText.flatMap((d) => d.facts.phones), 6),
    currencies: unionStr(withText.map((d) => d.facts.currencies), 3),
    dates: unionStr(withText.map((d) => d.facts.dates), 12),
    yearRange: years.length > 0 ? { min: Math.min(...years.map((y) => y.min)), max: Math.max(...years.map((y) => y.max)) } : null,
  };
  const priceSet = new Set<number>();
  for (const d of withText) for (const p of d.inferences.prices) priceSet.add(p);
  // Temporadas: comparamos los conjuntos de rangos entre documentos.
  const seasonKey = (xs: PreScanSeason[]) =>
    xs.map((se) => `${se.name ?? "?"}:${se.ranges.map((r) => `${r.start}>${r.end}`).join("/")}`).join(" | ");
  // El documento con más precios es el tarifario: sus temporadas y su
  // estimación de productos son las que importan (independiente del orden).
  const rateDoc = [...withText].sort((a, b) => b.inferences.priceMentions - a.inferences.priceMentions)[0]!;
  const seasonsDoc =
    rateDoc.inferences.seasons.length > 0 ? rateDoc : (withText.find((d) => d.inferences.seasons.length > 0) ?? rateDoc);
  agree("Temporadas", (d) => (d.inferences.seasons.length > 0 ? d.inferences.seasons : null), seasonKey);
  const bankSeen = new Set<string>();
  const bankAccounts: PreScanBankAccount[] = [];
  for (const d of withText) for (const b of d.inferences.bankAccounts) {
    const k = b.iban ?? b.accountNumber ?? "";
    if (k && bankSeen.has(k)) continue;
    bankSeen.add(k);
    bankAccounts.push(b);
  }
  const inferences: PreScanInferences = {
    legalName: agree("Razón social", (d) => d.inferences.legalName, (v) => v),
    address: firstNonNull((d) => d.inferences.address),
    website: firstNonNull((d) => d.inferences.website),
    checkIn: agree("Check-in", (d) => d.inferences.checkIn, (v) => v),
    checkOut: agree("Check-out", (d) => d.inferences.checkOut, (v) => v),
    meals: unionStr(withText.map((d) => d.inferences.meals), 6),
    paymentTerms: withText.flatMap((d) => d.inferences.paymentTerms).slice(0, 8),
    cancellationTerms: withText.flatMap((d) => d.inferences.cancellationTerms).slice(0, 8),
    childTerms: unionStr(withText.map((d) => d.inferences.childTerms), 6),
    bankAccounts: bankAccounts.slice(0, 6),
    sections: withText.flatMap((d) => d.inferences.sections).slice(0, 24),
    estimatedProducts: rateDoc.inferences.estimatedProducts,
    country: agree("País", (d) => d.inferences.country, (v) => v.value),
    validity: agree(
      "Vigencia",
      // Un año inferido del título no contradice una vigencia explícita.
      (d) => d.inferences.validity,
      (v) => (v.source === "explicit" ? `${v.start} → ${v.end}` : `${v.start} → ${v.end} (por el año)`),
    ),
    taxes: agree(
      "Impuestos",
      (d) => d.inferences.taxes,
      (v) => (v.included === null ? `${v.percent}%` : `${v.included ? "incluidos" : "no incluidos"}${v.percent !== null ? ` ${v.percent}%` : ""}`),
    ),
    commission: agree(
      "Comisión",
      (d) => d.inferences.commission,
      (v) => (v.net ? "tarifas netas" : `${v.percent}%`),
    ),
    rateBasis: unionStr(withText.map((d) => d.inferences.rateBasis), 6),
    occupancies: unionStr(withText.map((d) => d.inferences.occupancies), 6),
    seasons: seasonsDoc.inferences.seasons,
    minNights: agree("Mínimo de noches", (d) => d.inferences.minNights, (v) => String(v)),
    childPolicy: firstNonNull((d) => d.inferences.childPolicy),
    cancellationPolicy: firstNonNull((d) => d.inferences.cancellationPolicy),
    paymentPolicy: firstNonNull((d) => d.inferences.paymentPolicy),
    prices: [...priceSet].sort((a, b) => a - b).slice(0, 500),
    priceMentions: withText.reduce((n, d) => n + d.inferences.priceMentions, 0),
    productHints: unionStr(withText.map((d) => d.inferences.productHints), 20),
  };
  // Moneda de tarifas distinta entre documentos (USD vs CRC) también es conflicto.
  const curSets = withText.map((d) => d.facts.currencies.join("+")).filter((x) => x !== "");
  if (new Set(curSets).size > 1) {
    conflicts.push(
      "Moneda: " + withText.filter((d) => d.facts.currencies.length > 0).map((d) => `${name(d)} usa ${d.facts.currencies.join("/")}`).join("; ") + ".",
    );
  }
  return { facts, inferences, conflicts };
}

/** Etiquetas cortas de lo que aporta un documento (para la tarjeta del Paso 1). */
function contributionsOf(d: ScannedDoc): string[] {
  if (!d.textAvailable) return [d.input.kind === "image" ? "imagen (sin texto)" : "sin texto legible"];
  const out: string[] = [];
  const i = d.inferences;
  const f = d.facts;
  if (i.priceMentions > 0) out.push(`${i.priceMentions} precio${i.priceMentions === 1 ? "" : "s"}`);
  if (i.seasons.length > 0) out.push(`${i.seasons.length} temporada${i.seasons.length === 1 ? "" : "s"}`);
  if (i.validity) out.push("vigencia");
  if (i.taxes) out.push("impuestos");
  if (i.commission) out.push("comisión");
  if (i.cancellationPolicy || i.cancellationTerms.length > 0) out.push("cancelación");
  if (i.paymentPolicy || i.paymentTerms.length > 0) out.push("pago");
  if (i.childPolicy || i.childTerms.length > 0) out.push("niños");
  if (i.bankAccounts.length > 0) out.push(`${i.bankAccounts.length} cuenta${i.bankAccounts.length === 1 ? "" : "s"}`);
  if (i.legalName) out.push("razón social");
  if (i.checkIn || i.checkOut) out.push("check-in/out");
  if (i.meals.length > 0) out.push("comidas");
  if (i.minNights) out.push("mín. noches");
  if (f.ibans.length > 0) out.push("IBAN");
  if (f.cedulas.length > 0) out.push("cédula");
  if (f.emails.length > 0) out.push("correo");
  if (f.phones.length > 0) out.push("teléfono");
  if (i.productHints.length > 0) out.push(`${i.productHints.length} producto${i.productHints.length === 1 ? "" : "s"}`);
  return out.length > 0 ? out : ["texto sin datos reconocibles"];
}

/**
 * Pre-scan de todos los documentos adjuntos, tratados como PARES: el
 * proveedor se vota entre todos, los campos se fusionan por acuerdo y las
 * discrepancias entre documentos se reportan como avisos. El primer archivo
 * sólo da nombre al run en el historial.
 */
export async function preScan(files: PreScanInputFile[]): Promise<PreScanResult> {
  const started = Date.now();
  if (files.length === 0) throw new Error("preScan: no files");

  const docs: ScannedDoc[] = [];
  for (let i = 0; i < files.length; i += 1) {
    docs.push(await scanOne(files[i]!, i === 0 ? "primary" : "secondary"));
  }
  const primary = docs[0]!;
  const suppliers = await loadSuppliersCached();

  // Proveedor: cada documento vota. Sumamos el puntaje de cada candidato en
  // todos los documentos (los documentos son pares, ninguno manda) y la
  // confianza se calcula sobre el agregado. Un documento que por sí solo
  // apunta con confianza alta a OTRO proveedor genera un aviso.
  const perDoc = docs.map((d) => detectSupplier(d.textAvailable ? d.text : "", d.input.filename, suppliers));
  const agg = new Map<string, PreScanCandidate>();
  for (const r of perDoc) {
    for (const c of r.candidates) {
      const prev = agg.get(c.id);
      if (prev) {
        prev.score += c.score;
        for (const reason of c.reasons) if (!prev.reasons.includes(reason)) prev.reasons.push(reason);
      } else {
        agg.set(c.id, { ...c, reasons: [...c.reasons] });
      }
    }
  }
  const candidates = [...agg.values()].sort((a, b) => b.score - a.score).slice(0, 4);
  const topC = candidates[0];
  const second = candidates[1];
  let confidence: PreScanConfidence = "ninguna";
  if (topC) {
    const gap = topC.score - (second?.score ?? 0);
    if (topC.score >= 100 && gap >= 40) confidence = "alta";
    else if (topC.score >= 45) confidence = "media";
  }
  const supplier = { confidence, candidates };
  const top = supplier.candidates[0] ?? null;

  // Resumen por documento + aviso de "documento de otro proveedor".
  const crossDocumentWarnings: string[] = [];
  const documents: PreScanDocument[] = docs.map((d, idx) => {
    const own = perDoc[idx]!;
    const ownTop = own.candidates[0] ?? null;
    const hint = ownTop && own.confidence !== "ninguna"
      ? { codigo: ownTop.codigo, nombre: ownTop.nombre, confidence: own.confidence }
      : null;
    if (hint && top && hint.codigo !== top.codigo && own.confidence === "alta") {
      crossDocumentWarnings.push(
        `"${d.input.filename}" parece ser de ${hint.nombre ?? hint.codigo}, no de ${top.nombre ?? top.codigo}. ¿Es el documento correcto?`,
      );
    }
    return {
      filename: d.input.filename,
      kind: d.input.kind,
      role: d.role,
      textAvailable: d.textAvailable,
      pages: d.pages,
      chars: d.text.length,
      contributes: contributionsOf(d),
      supplierHint: hint,
    };
  });

  const { facts, inferences, conflicts } = mergeDocs(docs);
  crossDocumentWarnings.push(...conflicts);
  const textAvailable = docs.some((d) => d.textAvailable);

  // El pre-scan describe SOLO los documentos presentes. La comparación con
  // contratos anteriores del historial se retiró: generaba falsos positivos
  // (p. ej. una cuenta sin IBAN "no aparecía" aunque estaba en el texto) y
  // el revisor quiere ver el contrato actual, no el anterior.
  const previous: PreScanResult["previous"] = null;
  void textAvailable;

  // `filename`/`kind` = primer documento: sólo sirve para nombrar el run en
  // el historial. Ningún otro campo depende del orden.
  return {
    filename: primary.input.filename,
    kind: primary.input.kind,
    textAvailable: primary.textAvailable,
    pages: primary.pages,
    chars: primary.text.length,
    documents,
    crossDocumentWarnings,
    supplier,
    facts,
    inferences,
    previous,
    durationMs: Date.now() - started,
  };
}
