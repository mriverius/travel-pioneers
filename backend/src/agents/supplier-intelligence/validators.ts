import type {
  ContractRow,
  ExtractedContract,
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

/**
 * Very loose E.164 check: strip everything non-digit, require 7–15 digits.
 */
export function phoneDigitCountInRange(raw: string): boolean {
  const digits = raw.replace(/\D+/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

/**
 * Limpia una fila en sitio: si la categoría no pertenece al tipo_servicio
 * shared, devolvemos la fila con categoria=null y un mensaje de warning. No
 * mutamos — devolvemos una copia.
 */
function sanitizeRow(
  row: ContractRow,
  tipoServicio: string | null,
  rowIndex: number,
  warnings: string[],
): ContractRow {
  if (!row.categoria) return row;
  if (!tipoServicio) {
    warnings.push(
      `Fila ${rowIndex + 1}: se devolvió 'categoria' pero 'tipo_servicio' es null — categoria ignorada.`,
    );
    return { ...row, categoria: null };
  }
  const validCats = CATEGORIAS_BY_TIPO_SERVICIO[tipoServicio];
  const ok =
    Array.isArray(validCats) &&
    validCats.some((c) => c.codigo === row.categoria);
  if (!ok) {
    warnings.push(
      `Fila ${rowIndex + 1} (${row.product_name ?? "?"} / ${row.season_name ?? "?"}): ` +
        `categoría "${row.categoria}" no es válida para tipo_servicio ` +
        `"${tipoServicio}" — se ignoró.`,
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

  // Detect duplicated (product_name, season_name) combinations — eso indica
  // que la IA generó la misma fila dos veces.
  const seenKeys = new Set<string>();
  extraction.rows.forEach((r, i) => {
    const key = `${r.product_name ?? ""}__${r.season_name ?? ""}`;
    if (seenKeys.has(key) && r.product_name && r.season_name) {
      warnings.push(
        `Fila ${i + 1}: combinación duplicada (${r.product_name} × ${r.season_name}).`,
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
