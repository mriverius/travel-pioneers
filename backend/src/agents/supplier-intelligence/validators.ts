import type {
  ContractRow,
  ExtractedContract,
  SourcePage,
  ValidationResult,
} from "./types.js";
import {
  TIPO_SERVICIO_CODES,
  CATEGORIAS_BY_TIPO_SERVICIO,
} from "./generated/serviceTypesData.js";

/**
 * Validate the IBAN checksum per ISO 13616 (mod-97 = 1).
 *
 * Algorithm:
 *   1. Move the first 4 characters (country + check digits) to the end.
 *   2. Replace every letter with its base-36 numeric value (A = 10 … Z = 35).
 *   3. The resulting large integer modulo 97 must equal 1.
 *
 * We can't use BigInt or Number directly for the modulo because IBANs can be
 * up to 34 characters, which yields integers bigger than Number.MAX_SAFE.
 * Instead we fold the string digit-by-digit.
 */
export function isValidIban(raw: string): boolean {
  const iban = raw.replace(/\s+/g, "").toUpperCase();

  if (iban.length < 15 || iban.length > 34) return false;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged
    .split("")
    .map((c) => {
      if (c >= "0" && c <= "9") return c;
      return String(c.charCodeAt(0) - 55); // A=10 .. Z=35
    })
    .join("");

  // Fold digit-by-digit to stay within safe integer range.
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/**
 * Quick heuristic for Costa Rica's cédula jurídica (format X-XXX-XXXXXX).
 * Non-CR shapes are allowed through with just a warning so we don't reject
 * perfectly valid Mexican RFCs, Colombian NITs, etc.
 */
export function looksLikeCostaRicaCedulaJuridica(raw: string): boolean {
  return /^\d-\d{3}-\d{6}$/.test(raw.trim());
}

/* -------------------------------------------------------------------------- */
/*                              Date normalization                            */
/* -------------------------------------------------------------------------- */

/**
 * Guardrail server-side: TODA fecha que devolvamos a partir del agente
 * (campos `fecha`, `contract_starts`, `contract_ends`, `season_starts`,
 * `season_ends`) tiene que salir en formato ISO YYYY-MM-DD. El prompt ya
 * lo pide, pero el modelo igualmente emite a veces "6 de enero de 2026",
 * "06/01/2026", "2026-01-06T00:00:00Z", etc. — este normalizador es el
 * cinturón de seguridad.
 *
 * Acepta:
 *   - YYYY-MM-DD                 → passthrough (no warn)
 *   - YYYY/MM/DD, YYYY.MM.DD     → reformatea con guiones
 *   - YYYYMMDD                   → reformatea con guiones
 *   - YYYY-MM-DD HH:MM... / T... → strip de hora
 *   - DD/MM/YYYY, DD-MM-YYYY     → reformatea (convención CR/LatAm)
 *   - MM/DD/YYYY (cuando es no-ambiguo: mes > 12 imposible al inicio)
 *   - "6 de enero de 2026", "6 ene 2026", "January 6, 2026", etc.
 *   - Sentinel "NOT AVAILABLE"   → preserva tal cual (downstream lo usa)
 *
 * Devuelve `{ value, changed }`:
 *   - `value`: la fecha normalizada en YYYY-MM-DD, o `"NOT AVAILABLE"`, o
 *     `null` si no se pudo parsear.
 *   - `changed`: true si tuvimos que reformatear o si perdimos la fecha
 *     (para que el caller pueda agregar un warning visible).
 *
 * Convención de DD/MM vs MM/DD: cuando ambos componentes son ≤ 12 (caso
 * ambiguo), preferimos DD/MM porque el universo de contratos del
 * producto es LatAm. Si el primer componente es > 12, el formato sólo
 * puede ser MM/DD así que lo aceptamos. Si el segundo es > 12, sólo
 * puede ser DD/MM.
 */
const SPANISH_MONTHS: Record<string, number> = {
  ene: 1, enero: 1,
  feb: 2, febrero: 2,
  mar: 3, marzo: 3,
  abr: 4, abril: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6,
  jul: 7, julio: 7,
  ago: 8, agosto: 8,
  sep: 9, sept: 9, septiembre: 9, set: 9, setiembre: 9,
  oct: 10, octubre: 10,
  nov: 11, noviembre: 11,
  dic: 12, diciembre: 12,
};

const ENGLISH_MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }
  // Rango razonable para contratos turísticos. Si aparece algo fuera de
  // esta ventana es casi seguro un error de parseo (ej: año 0006).
  if (y < 1900 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // Verifica que el Date construido refleje los mismos componentes — así
  // detectamos casos como "Feb 30" o "Apr 31".
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function fmtYmd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Quita acentos (NFD + strip combining marks) para matchear "enero" vs "énero". */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Resolve a 2- or 4-digit year. 2-digit years are a pain because contracts
 * could in theory reference past or future decades; lacking a stronger
 * signal, asumimos 20YY para YY ≤ 49 y 19YY para YY ≥ 50.
 */
function expandYear(y: number): number {
  if (y >= 100) return y;
  return y <= 49 ? 2000 + y : 1900 + y;
}

export interface NormalizedDate {
  value: string | null;
  changed: boolean;
}

export function normalizeDate(raw: unknown): NormalizedDate {
  if (raw === null || raw === undefined) return { value: null, changed: false };
  if (typeof raw !== "string") {
    // Defensive — el coerce upstream debería garantizar string|null, pero
    // si llega un número/fecha por accidente, lo descartamos en lugar de
    // crashear.
    return { value: null, changed: true };
  }
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, changed: true };

  // Sentinel reservado por el prompt — passthrough.
  if (trimmed.toUpperCase() === "NOT AVAILABLE") {
    return { value: "NOT AVAILABLE", changed: false };
  }

  // 1) YYYY-MM-DD limpio.
  {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (isValidYmd(y, mo, d)) return { value: trimmed, changed: false };
      return { value: null, changed: true };
    }
  }

  // 2) ISO con hora: 2026-01-06T... / "2026-01-06 12:34:56"
  {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ]/.exec(trimmed);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (isValidYmd(y, mo, d)) {
        return { value: fmtYmd(y, mo, d), changed: true };
      }
      return { value: null, changed: true };
    }
  }

  // 3) YYYY/MM/DD o YYYY.MM.DD (incluye dígitos sueltos).
  {
    const m = /^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/.exec(trimmed);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (isValidYmd(y, mo, d)) {
        return { value: fmtYmd(y, mo, d), changed: true };
      }
      return { value: null, changed: true };
    }
  }

  // 4) YYYYMMDD compacto.
  {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (isValidYmd(y, mo, d)) {
        return { value: fmtYmd(y, mo, d), changed: true };
      }
      return { value: null, changed: true };
    }
  }

  // 5) DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (o MM/DD/YYYY cuando es
  //    no-ambiguo). Acepta también años de 2 dígitos.
  {
    const m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(trimmed);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const y = expandYear(Number(m[3]));

      // Heurística de orden — ver doc del normalizador.
      const dmy = isValidYmd(y, b, a) ? ([b, a] as const) : null;
      const mdy = isValidYmd(y, a, b) ? ([a, b] as const) : null;

      let pick: readonly [number, number] | null = null;
      if (a > 12 && b <= 12) pick = dmy;          // sólo cabe DD/MM
      else if (b > 12 && a <= 12) pick = mdy;     // sólo cabe MM/DD
      else pick = dmy ?? mdy;                     // ambiguo → DD/MM

      if (pick) return { value: fmtYmd(y, pick[0], pick[1]), changed: true };
      return { value: null, changed: true };
    }
  }

  // 6) Nombre de mes — soporta variantes comunes en es/en:
  //      "6 de enero de 2026" / "6 enero 2026" / "6-ene-2026" / "6 ene 26"
  //      "January 6, 2026"    / "Jan 6 2026"   / "Jan-6-2026"
  {
    const cleaned = stripAccents(trimmed.toLowerCase())
      .replace(/\bde\b/g, " ")
      .replace(/[,]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Pattern A: D MONTH YEAR
    const a = /^(\d{1,2})[\s\-\/]+([a-z]{3,9})[\s\-\/]+(\d{2,4})$/.exec(cleaned);
    if (a) {
      const [, dayStr, monthName, yearStr] = a;
      const day = Number(dayStr);
      const month =
        SPANISH_MONTHS[monthName ?? ""] ??
        ENGLISH_MONTHS[monthName ?? ""] ??
        null;
      const y = expandYear(Number(yearStr));
      if (month !== null && isValidYmd(y, month, day)) {
        return { value: fmtYmd(y, month, day), changed: true };
      }
      return { value: null, changed: true };
    }

    // Pattern B: MONTH D YEAR (típico en inglés)
    const b = /^([a-z]{3,9})[\s\-\/]+(\d{1,2})[\s\-\/]+(\d{2,4})$/.exec(cleaned);
    if (b) {
      const [, monthName, dayStr, yearStr] = b;
      const month =
        SPANISH_MONTHS[monthName ?? ""] ??
        ENGLISH_MONTHS[monthName ?? ""] ??
        null;
      const day = Number(dayStr);
      const y = expandYear(Number(yearStr));
      if (month !== null && isValidYmd(y, month, day)) {
        return { value: fmtYmd(y, month, day), changed: true };
      }
      return { value: null, changed: true };
    }
  }

  // 7) Nada matcheó — perdemos la fecha pero al menos lo decimos.
  return { value: null, changed: true };
}

/**
 * Very loose E.164 check: strip everything non-digit, require 7–15 digits.
 */
export function phoneDigitCountInRange(raw: string): boolean {
  const digits = raw.replace(/\D+/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

/**
 * Limpia una fila en sitio: si la categoría no pertenece al tipo_servicio
 * efectivo (override por fila > shared), devolvemos la fila con
 * categoria=null y un mensaje de warning. No mutamos — devolvemos una
 * copia.
 *
 * Bug #1 / #5 — el tipo_servicio puede ser un override por fila ahora,
 * así que validamos contra el efectivo, no el shared.
 */
function sanitizeRow(
  row: ContractRow,
  sharedTipoServicio: string | null,
  rowIndex: number,
  warnings: string[],
): ContractRow {
  if (!row.categoria) return row;
  // Override por fila tiene prioridad. Si el override está fuera del
  // catálogo, lo tratamos como inválido y limpiamos la categoría.
  const effectiveTipoServicio =
    row.tipo_servicio?.trim() || sharedTipoServicio || null;
  if (!effectiveTipoServicio) {
    warnings.push(
      `Fila ${rowIndex + 1}: se devolvió 'categoria' pero 'tipo_servicio' es null — categoria ignorada.`,
    );
    return { ...row, categoria: null };
  }
  if (!TIPO_SERVICIO_CODES.includes(effectiveTipoServicio)) {
    warnings.push(
      `Fila ${rowIndex + 1}: tipo_servicio "${effectiveTipoServicio}" no está en el catálogo — categoria ignorada.`,
    );
    return { ...row, categoria: null, tipo_servicio: null };
  }
  const validCats = CATEGORIAS_BY_TIPO_SERVICIO[effectiveTipoServicio];
  const ok =
    Array.isArray(validCats) &&
    validCats.some((c) => c.codigo === row.categoria);
  if (!ok) {
    warnings.push(
      `Fila ${rowIndex + 1} (${row.product_name ?? "?"} / ${row.season_name ?? "?"}): ` +
        `categoría "${row.categoria}" no es válida para tipo_servicio ` +
        `"${effectiveTipoServicio}" — se ignoró.`,
    );
    return { ...row, categoria: null };
  }
  return row;
}

/**
 * Detect whether a per-row policy field actually varies between rows. If
 * every non-null value is the same string, the UI can collapse it as
 * "shared". This is informational only — included in warnings for human
 * review.
 */
function policiesVaryByRow(
  rows: ContractRow[],
  key: keyof Pick<
    ContractRow,
    | "cancellation_policy"
    | "range_payment_policy"
    | "kids_policy"
    | "other_included"
    | "feeds_adicionales"
  >,
): boolean {
  const values = rows
    .map((r) => r[key])
    .filter((v): v is string => typeof v === "string" && v.trim() !== "");
  if (values.length < 2) return false;
  const first = values[0];
  return values.some((v) => v !== first);
}

/* -------------------------------------------------------------------------- */
/*                 Occupancy expansion (triple / quadruple)                   */
/* -------------------------------------------------------------------------- */

/**
 * Parse a price-ish string ("$1,234.50", "295", "51,98") into a Number.
 * Devuelve null si no hay un número utilizable. Maneja separadores de miles
 * (coma) y decimales (punto o coma) de forma tolerante porque los contratos
 * mezclan convenciones.
 */
function parseAmount(raw: string | null): number | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/[^0-9.,-]/g, "").trim();
  if (cleaned === "") return null;
  let normalized = cleaned;
  if (normalized.includes(",") && normalized.includes(".")) {
    // "1,234.50" → la coma es separador de miles.
    normalized = normalized.replace(/,/g, "");
  } else if (normalized.includes(",")) {
    // "51,98" → coma decimal.
    normalized = normalized.replace(",", ".");
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Formatea un monto a 2 decimales, redondeo half-up estable. */
function fmtAmount(n: number): string {
  return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
}

const OCCUPANCY_MULTIPLIER: Record<"TPL" | "QDP", number> = {
  TPL: 1, // tercera persona
  QDP: 2, // tercera + cuarta persona
};

/**
 * Ocupaciones "base" desde las que SÍ tiene sentido expandir a TPL/QDP.
 * Si una fila ya es TPL/QDP (o algo ajeno a hospedaje), no la tocamos.
 */
const BASE_OCCUPANCIES = new Set(["", "SGL", "DBL", "FAM", "DOBLE", "SENCILLA"]);

/**
 * Construye una fila derivada de ocupación (TPL o QDP) a partir de una fila
 * base, sumando la tarifa por persona adicional a los precios.
 *
 * - El adicional viene como precio RACK con IVA incluido (`addlRack`).
 * - Para el precio NETO derivamos el adicional escalando por la razón
 *   neto/rack de la propia fila base, así la relación comisión/IVA queda
 *   consistente con lo que el modelo ya calculó (en vez de re-derivar la
 *   comisión, que el modelo a veces redondea de forma no obvia).
 * - Se aplica a la tarifa estándar y a la de fin de semana (_fds).
 */
function buildOccupancyRow(
  base: ContractRow,
  occ: "TPL" | "QDP",
  addlRack: number,
): ContractRow {
  const mult = OCCUPANCY_MULTIPLIER[occ];

  const computePair = (
    neto: string | null,
    rack: string | null,
  ): { neto: string | null; rack: string | null } => {
    const baseRack = parseAmount(rack);
    const baseNeto = parseAmount(neto);
    const extraRack = mult * addlRack;
    const newRack = baseRack !== null ? fmtAmount(baseRack + extraRack) : rack;
    let newNeto = neto;
    if (baseNeto !== null) {
      const ratio =
        baseRack !== null && baseRack !== 0 ? baseNeto / baseRack : 1;
      newNeto = fmtAmount(baseNeto + extraRack * ratio);
    }
    return { neto: newNeto, rack: newRack };
  };

  const std = computePair(base.precios_neto_iva, base.precio_rack_iva);
  const fds = computePair(base.precios_neto_iva_fds, base.precio_rack_iva_fds);

  return {
    ...base,
    ocupacion: occ,
    precios_neto_iva: std.neto,
    precio_rack_iva: std.rack,
    precios_neto_iva_fds: fds.neto,
    precio_rack_iva_fds: fds.rack,
    // Ya aplicada — evitar re-expansión y dejar limpio el campo auxiliar.
    tarifa_persona_adicional: null,
  };
}

/**
 * Materializa filas de ocupación triple (TPL) y cuádruple (QDP) a partir de
 * la tarifa por persona adicional que la IA dejó en `tarifa_persona_adicional`.
 *
 * Por cada fila base con un adicional > 0 y ocupación base (DBL/SGL/FAM/null),
 * se insertan inmediatamente después dos filas calculadas (TPL y QDP). El
 * campo auxiliar queda en null en TODAS las filas resultantes (base incluida)
 * para que no quede colgando ni dispare una segunda expansión.
 *
 * Mantiene `paginas_origen_rows` en paralelo: las filas derivadas heredan el
 * origen de la base con `ocupacion: "calculado"` para trazabilidad.
 */
function expandOccupancy(
  extraction: ExtractedContract,
  warnings: string[],
): ExtractedContract {
  const newRows: ContractRow[] = [];
  const newPages: Record<string, SourcePage>[] = [];
  let expanded = 0;

  extraction.rows.forEach((row, i) => {
    const pages = extraction.paginas_origen_rows[i] ?? {};
    const addl = parseAmount(row.tarifa_persona_adicional);
    const occ = (row.ocupacion ?? "").trim().toUpperCase();
    const canExpand = addl !== null && addl > 0 && BASE_OCCUPANCIES.has(occ);

    // Fila base: limpiamos el campo auxiliar (ya consumido).
    newRows.push(
      row.tarifa_persona_adicional == null
        ? row
        : { ...row, tarifa_persona_adicional: null },
    );
    newPages.push(pages);

    if (!canExpand || addl === null) return;

    for (const target of ["TPL", "QDP"] as const) {
      newRows.push(buildOccupancyRow(row, target, addl));
      newPages.push({ ...pages, ocupacion: "calculado" });
      expanded += 1;
    }
  });

  if (expanded === 0) return extraction;

  warnings.push(
    `Se generaron ${expanded} fila(s) de ocupación triple (TPL) y ` +
      `cuádruple (QDP) calculadas a partir de la tarifa por persona ` +
      `adicional (base + 1× para TPL, base + 2× para QDP). Revisá los ` +
      `montos en Step 2.`,
  );

  return { ...extraction, rows: newRows, paginas_origen_rows: newPages };
}

/**
 * Run all post-extraction checks and collect warnings. Downgrades `confianza`
 * to "baja" when the IBAN checksum fails (that's the one signal we're very
 * confident about). Everything else is non-fatal.
 *
 * Mutates nothing — returns the warnings list plus the (possibly downgraded)
 * extraction so the caller can decide how to respond.
 */
export function validateExtraction(
  data: ExtractedContract,
): { extraction: ExtractedContract; validation: ValidationResult } {
  const warnings: string[] = [];
  let extraction = data;

  // Guardrail de fechas — TODAS las fechas deben quedar en YYYY-MM-DD.
  // Si Claude emitió algo distinto (DD/MM/YYYY, "January 6 2026", ISO con
  // hora, etc.) lo normalizamos. Si no se pudo parsear, lo dejamos en
  // null y avisamos para que se revise.
  {
    const shared = extraction.shared_fields;
    const sharedDateFields = [
      "fecha",
      "contract_starts",
      "contract_ends",
    ] as const;
    const patchedShared: Partial<typeof shared> = {};
    for (const field of sharedDateFields) {
      const original = shared[field];
      const { value, changed } = normalizeDate(original);
      if (changed) {
        patchedShared[field] = value;
        if (value === null) {
          warnings.push(
            `Campo "${field}" tenía una fecha en formato no reconocido ` +
              `(${JSON.stringify(original)}) — se descartó. Revisá manualmente.`,
          );
        } else if (value !== "NOT AVAILABLE") {
          warnings.push(
            `Campo "${field}" se reformateó a YYYY-MM-DD (estaba como ${JSON.stringify(original)}).`,
          );
        }
      }
    }
    if (Object.keys(patchedShared).length > 0) {
      extraction = {
        ...extraction,
        shared_fields: { ...shared, ...patchedShared },
      };
    }

    const rowDateFields = ["season_starts", "season_ends"] as const;
    let rowsChanged = false;
    const normalizedRows = extraction.rows.map((row, idx) => {
      let next = row;
      for (const field of rowDateFields) {
        const original = row[field];
        const { value, changed } = normalizeDate(original);
        if (changed) {
          rowsChanged = true;
          next = { ...next, [field]: value };
          if (value === null) {
            warnings.push(
              `Fila ${idx + 1}: "${field}" en formato no reconocido ` +
                `(${JSON.stringify(original)}) — se descartó.`,
            );
          } else if (value !== "NOT AVAILABLE") {
            warnings.push(
              `Fila ${idx + 1}: "${field}" se reformateó a YYYY-MM-DD ` +
                `(estaba como ${JSON.stringify(original)}).`,
            );
          }
        }
      }
      return next;
    });
    if (rowsChanged) {
      extraction = { ...extraction, rows: normalizedRows };
    }
  }

  // Expansión de ocupación: materializa filas TPL/QDP desde la tarifa por
  // persona adicional ANTES del resto de las validaciones, para que las
  // filas derivadas también pasen por las verificaciones de categoría,
  // precio, duplicados, etc.
  extraction = expandOccupancy(extraction, warnings);

  // numero_cuenta — if it looks like an IBAN (starts with two letters), check it.
  const accountNumber = extraction.shared_fields.numero_cuenta;
  if (accountNumber) {
    const normalized = accountNumber.replace(/\s+/g, "");
    if (/^[A-Za-z]{2}/.test(normalized)) {
      if (!isValidIban(normalized)) {
        warnings.push(
          "El número de cuenta parece ser un IBAN pero falla el checksum mod-97.",
        );
        extraction = { ...extraction, confianza: "baja" };
      }
    }
  }

  // cédula — warn only; countries other than CR are legitimate.
  const cedula = extraction.shared_fields.cedula;
  if (cedula && !looksLikeCostaRicaCedulaJuridica(cedula)) {
    warnings.push(
      "La cédula no sigue el formato de Costa Rica (X-XXX-XXXXXX). " +
        "Puede ser válida para otro país.",
    );
  }

  // teléfono — warn if digit count is clearly out of E.164 range.
  const telefono = extraction.shared_fields.telefono;
  if (telefono && !phoneDigitCountInRange(telefono)) {
    warnings.push(
      "El teléfono extraído tiene un número de dígitos fuera del rango E.164 (7–15).",
    );
  }

  // tipo_servicio — si Claude devolvió un código fuera del catálogo (no
  // debería pasar por el enum del schema, pero defensive), lo limpiamos a
  // null y limpiamos la categoría de todas las filas.
  let tipoServicio = extraction.shared_fields.tipo_servicio;
  if (tipoServicio && !TIPO_SERVICIO_CODES.includes(tipoServicio)) {
    warnings.push(
      `Tipo de servicio "${tipoServicio}" no está en el catálogo Utopía — se ignoró.`,
    );
    tipoServicio = null;
    extraction = {
      ...extraction,
      shared_fields: { ...extraction.shared_fields, tipo_servicio: null },
      rows: extraction.rows.map((r) => ({ ...r, categoria: null })),
    };
  }

  // Validar categoría por fila. Cada fila debe tener una categoría válida
  // para el tipo_servicio shared. Si no, se limpia y se avisa.
  const sanitizedRows = extraction.rows.map((r, i) =>
    sanitizeRow(r, tipoServicio, i, warnings),
  );
  if (sanitizedRows.some((r, i) => r !== extraction.rows[i])) {
    extraction = { ...extraction, rows: sanitizedRows };
  }

  // Validar consistencia de filas: cada fila necesita al menos product_name +
  // season_name + un precio para ser útil.
  extraction.rows.forEach((r, i) => {
    const hasName = !!r.product_name?.trim();
    const hasSeason = !!r.season_name?.trim();
    const hasPrice =
      !!r.precios_neto_iva?.trim() || !!r.precio_rack_iva?.trim();
    if (!hasName) {
      warnings.push(`Fila ${i + 1}: falta product_name.`);
    }
    if (!hasSeason) {
      warnings.push(`Fila ${i + 1}: falta season_name.`);
    }
    if (!hasPrice) {
      warnings.push(
        `Fila ${i + 1} (${r.product_name ?? "?"} / ${r.season_name ?? "?"}): ` +
          `no tiene precio neto ni rack — revisar.`,
      );
    }
  });

  // Guardrail anti-alucinación de codigo_servicio (col N): si el mismo
  // código aparece en filas con product_name distintos, es casi seguro
  // que Claude copió el código de la primera fila al resto (bug típico
  // observado con "MAS" en TODAS las filas aunque las filas posteriores
  // sean Infinity/Junior/Deluxe Suite).
  //
  // Estrategia:
  //   - Warn SIEMPRE cuando el patrón aparece para que el usuario lo
  //     vea en Step 2.
  //   - Auto-limpiar (null) las ocurrencias duplicadas SOLO cuando el
  //     tipo_servicio efectivo de la fila es "HO" — en hospedajes el
  //     fallback heurístico server-side (`deriveCodigoServicioFromProduct`
  //     en xlsxGenerator) deriva el código correcto del nombre del
  //     producto con alta confianza. Para tours/transfers/meals el
  //     fallback retorna "UNI" (genérico) y limpiar perdería el código
  //     específico del tour (ej. WHALEDOL) — por eso ahí solo warneamos.
  {
    const sharedTipoSrv = extraction.shared_fields.tipo_servicio;
    const effectiveTipoSrv = (row: ContractRow): string | null =>
      row.tipo_servicio?.trim() || sharedTipoSrv;

    const codeToProducts = new Map<string, Set<string>>();
    for (const row of extraction.rows) {
      const code = row.codigo_servicio?.trim();
      const product = row.product_name?.trim();
      if (!code || !product) continue;
      const set = codeToProducts.get(code) ?? new Set<string>();
      set.add(product);
      codeToProducts.set(code, set);
    }

    const suspectCodes = new Set<string>();
    for (const [code, products] of codeToProducts) {
      if (products.size > 1) {
        warnings.push(
          `codigo_servicio "${code}" aparece en productos distintos ` +
            `(${[...products].join(" / ")}) — posible alucinación, ` +
            `revisar el código en cada fila.`,
        );
        suspectCodes.add(code);
      }
    }

    if (suspectCodes.size > 0) {
      const seenForCode = new Map<string, string>();
      const cleanedRows = extraction.rows.map((row) => {
        const code = row.codigo_servicio?.trim();
        const product = row.product_name?.trim();
        if (!code || !product || !suspectCodes.has(code)) return row;

        // Mantenemos la PRIMERA ocurrencia del par (code, product).
        const firstProductForCode = seenForCode.get(code);
        if (firstProductForCode === undefined) {
          seenForCode.set(code, product);
          return row;
        }
        if (firstProductForCode === product) return row;

        // Esta fila comparte el código con un producto distinto que ya
        // vimos. Solo limpiamos a null si la fila es hospedaje (HO) —
        // en ese caso el writer xlsx puede derivar el código correcto.
        if (effectiveTipoSrv(row) === "HO") {
          return { ...row, codigo_servicio: null };
        }
        // Para tours/transfers/etc dejamos el código tal cual y solo
        // confiamos en el warning de arriba para que el usuario lo
        // edite manualmente en Step 2.
        return row;
      });
      if (cleanedRows.some((r, i) => r !== extraction.rows[i])) {
        extraction = { ...extraction, rows: cleanedRows };
      }
    }
  }

  // Detect duplicated (product_name, season_name) combinations — eso indica
  // que la IA generó la misma fila dos veces.
  const seenKeys = new Set<string>();
  extraction.rows.forEach((r, i) => {
    // Incluye ocupación en la clave: TPL/QDP comparten product_name y
    // season_name con la fila base pero NO son duplicados.
    const key = `${r.product_name ?? ""}__${r.season_name ?? ""}__${r.ocupacion ?? ""}`;
    if (seenKeys.has(key) && r.product_name && r.season_name) {
      warnings.push(
        `Fila ${i + 1}: combinación duplicada (${r.product_name} × ${r.season_name} × ${r.ocupacion ?? "?"}).`,
      );
    }
    seenKeys.add(key);
  });

  // Informational: detect if policies vary by row (helps the UI know whether
  // to collapse them as "shared" in the display).
  const variances: string[] = [];
  if (policiesVaryByRow(extraction.rows, "cancellation_policy")) {
    variances.push("cancellation_policy");
  }
  if (policiesVaryByRow(extraction.rows, "range_payment_policy")) {
    variances.push("range_payment_policy");
  }
  if (policiesVaryByRow(extraction.rows, "kids_policy")) {
    variances.push("kids_policy");
  }
  if (variances.length > 0) {
    warnings.push(
      `Políticas que varían por fila: ${variances.join(", ")}. Revisa cada fila individualmente.`,
    );
  }

  // Campos faltantes / baja confianza → recomendar revisión humana.
  if (extraction.campos_faltantes.length > 0) {
    warnings.push(
      `Se recomienda revisión humana — campos faltantes: ${extraction.campos_faltantes.join(", ")}.`,
    );
  }
  if (extraction.confianza === "baja") {
    warnings.push(
      "Confianza baja — se recomienda revisión humana de los datos extraídos.",
    );
  }

  return {
    extraction,
    validation: {
      valid: warnings.length === 0,
      warnings,
    },
  };
}
