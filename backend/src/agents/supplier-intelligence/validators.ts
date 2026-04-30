import type { ExtractedContract, ValidationResult } from "./types.js";
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
 *
 * TODO: expand to country-specific validators (RFC MX, NIT CO, CIF ES, etc.)
 * once we decide how to pass the country hint through the request.
 */
export function looksLikeCostaRicaCedulaJuridica(raw: string): boolean {
  return /^\d-\d{3}-\d{6}$/.test(raw.trim());
}

/**
 * Very loose E.164 check: strip everything non-digit, require 7–15 digits.
 * We don't try to verify the country code because the model is already
 * instructed to include one and any stricter check would produce false
 * negatives on valid numbers (e.g. short service codes).
 */
export function phoneDigitCountInRange(raw: string): boolean {
  const digits = raw.replace(/\D+/g, "");
  return digits.length >= 7 && digits.length <= 15;
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
  if (extraction.numero_cuenta) {
    const normalized = extraction.numero_cuenta.replace(/\s+/g, "");
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
  if (extraction.cedula && !looksLikeCostaRicaCedulaJuridica(extraction.cedula)) {
    warnings.push(
      "La cédula no sigue el formato de Costa Rica (X-XXX-XXXXXX). " +
        "Puede ser válida para otro país.",
    );
  }

  // teléfono — warn if digit count is clearly out of E.164 range.
  if (extraction.telefono && !phoneDigitCountInRange(extraction.telefono)) {
    warnings.push(
      "El teléfono extraído tiene un número de dígitos fuera del rango E.164 (7–15).",
    );
  }

  // tipo_servicio — si Claude devolvió un código fuera del catálogo (no
  // debería pasar por el enum del schema, pero defensive), lo limpiamos a
  // null para no propagar basura al frontend, y avisamos.
  if (
    extraction.tipo_servicio &&
    !TIPO_SERVICIO_CODES.includes(extraction.tipo_servicio)
  ) {
    warnings.push(
      `Tipo de servicio "${extraction.tipo_servicio}" no está en el catálogo Utopía — se ignoró.`,
    );
    extraction = { ...extraction, tipo_servicio: null, categoria: null };
  }

  // categoria — debe pertenecer al tipo_servicio elegido. Si no, advertimos
  // y la dejamos null para que el usuario revise; mantenemos tipo_servicio
  // para no perder esa parte del trabajo.
  if (extraction.categoria) {
    if (!extraction.tipo_servicio) {
      warnings.push(
        "Se devolvió 'categoria' pero 'tipo_servicio' es null — categoria ignorada.",
      );
      extraction = { ...extraction, categoria: null };
    } else {
      const validCats = CATEGORIAS_BY_TIPO_SERVICIO[extraction.tipo_servicio];
      const ok =
        Array.isArray(validCats) &&
        validCats.some((c) => c.codigo === extraction.categoria);
      if (!ok) {
        warnings.push(
          `Categoría "${extraction.categoria}" no es válida para tipo_servicio "${extraction.tipo_servicio}" — se ignoró.`,
        );
        extraction = { ...extraction, categoria: null };
      }
    }
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
