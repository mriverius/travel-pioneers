import { REGISTRAR_BRIEF_CONTRATO_TOOL_NAME } from "./briefSchema.js";

/**
 * Instrucción final (trailing) para la llamada de BRIEF (Fase 1).
 *
 * Se envía DESPUÉS del/los documento(s) y del bloque de cache, de modo que
 * comparte el prefijo cacheado (system + tools + documento) con la pasada
 * principal pero redirige el objetivo del modelo: en lugar de extraer todas
 * las filas, solo captura las reglas globales + inventario vía el tool de
 * brief. El tool_choice forzado al brief garantiza que NO pueda emitir filas.
 */
export const CONTRACT_BRIEF_INSTRUCTION =
  "PRE-ANÁLISIS DEL CONTRATO (Fase 1 — no es la extracción final).\n\n" +
  "NO extraigas las filas de tarifas todavía. Tu único trabajo ahora es " +
  `registrar el BRIEF del contrato con el tool "${REGISTRAR_BRIEF_CONTRATO_TOOL_NAME}".\n\n` +
  "Recorré el documento ENTERO de principio a fin y capturá, con máxima " +
  "fidelidad, las REGLAS GLOBALES y el inventario:\n" +
  "  1. IMPUESTOS: ¿los precios incluyen el IVA o hay que sumarlo? ¿Qué tasa? " +
  "Distinguí IVA de cargos por servicio (A&B) y de fees (sustainability).\n" +
  "  2. CUENTAS BANCARIAS: TODAS, una por una (suele haber USD + CRC, y a " +
  "veces banco principal + secundario por monto). No te quedes con la primera.\n" +
  "  3. PERSONA ADICIONAL: toda tarifa de 3era/4ta persona, con el paquete y " +
  "la temporada a la que aplica y a qué habitaciones aplica.\n" +
  "  4. COMIDAS: qué incluyen los paquetes (BREAKFAST/LUNCH/DINNER/NONE).\n" +
  "  5. COMISIONES: la comisión por defecto como NÚMERO (commission_default_pct) " +
  "y, si varían por sección, el resumen (commission_summary).\n" +
  "  6. PERIODOS ESPECIALES: políticas de Navidad/peak/etc. de prepago o " +
  "cancelación.\n" +
  "  6b. TEMPORADAS CON FECHAS: llená seasons_detail con el nombre y las fechas " +
  "de CADA temporada (obligatorio, no lo dejes vacío). OJO: dos tablas de " +
  "tarifas lado a lado con rangos de fecha distintos (ej. 'Alta: Nov-Abr' y " +
  "'Baja: May-Oct') son DOS temporadas — capturá ambas. Cuidado también con " +
  "rangos partidos.\n" +
  "  7. INVENTARIO: lista de categorías/habitaciones, temporadas y secciones " +
  "de tarifas (paquetes, noche adicional, experiencias, transfers, spa, " +
  "amenidades…), y un estimado de cuántas filas debería tener el contrato " +
  "completo.\n\n" +
  "Sé EXHAUSTIVO sobre todo en bancos y persona adicional — son los datos que " +
  "más se pierden cuando se extrae todo de una vez.";

/**
 * Renderiza el brief ya extraído como un bloque de texto de PRIORIDAD ALTA
 * que se inyecta en la pasada principal (grid fill). Convierte las reglas
 * globales en instrucciones operativas explícitas para que el modelo no las
 * vuelva a perder al generar las decenas de filas.
 *
 * `brief` es el objeto coercido (ver `coerceBrief` en service.ts). Cualquier
 * campo puede venir en null/undefined; renderizamos solo lo que aporte señal.
 */
export function renderContractBriefBlock(brief: {
  prices_include_tax: boolean | null;
  tax_rate_pct: number | null;
  tax_note: string | null;
  commission_default_pct?: number | null;
  commission_summary: string | null;
  meal_plan_note: string | null;
  currency?: string | null;
  bank_accounts: Array<{
    bank: string | null;
    account_number: string | null;
    currency: string | null;
    swift: string | null;
    note: string | null;
  }>;
  additional_person: Array<{
    scope: string | null;
    applies_to: string | null;
    rack: string | null;
    net: string | null;
  }>;
  special_periods_note: string | null;
  product_categories: string[];
  seasons: string[];
  seasons_detail?: Array<{
    name: string | null;
    starts: string | null;
    ends: string | null;
    raw_range: string | null;
  }>;
  sections: string[];
  expected_row_estimate: number | null;
  notes: string | null;
}): string {
  const lines: string[] = [];
  lines.push(
    "═══════════════════════════════════════════════════════════════════",
  );
  lines.push("CONTRACT BRIEF (pre-análisis automático) — PRIORIDAD ALTA");
  lines.push(
    "═══════════════════════════════════════════════════════════════════",
  );
  lines.push("");
  lines.push(
    "Un primer pase focalizado ya identificó las REGLAS GLOBALES de este " +
      "contrato. Aplicálas SIN EXCEPCIÓN a TODAS las filas que generes. Estas " +
      "reglas tienen prioridad ALTA: si al generar las filas se te escapa " +
      "alguna, el resultado queda incompleto.",
  );
  lines.push("");

  // 1. Impuestos — la regla #1 que se pierde.
  if (brief.prices_include_tax === false) {
    const rate = brief.tax_rate_pct ?? 13;
    const factor = (1 + rate / 100)
      .toFixed(4)
      .replace(/0+$/, "")
      .replace(/\.$/, "");
    lines.push(
      `• IMPUESTOS (CRÍTICO): los precios del documento NO incluyen el ${rate}% ` +
        `de IVA. Las columnas son "con IVA incluido", así que para CADA fila ` +
        `DEBÉS sumar el ${rate}% tanto al NETO como al RACK (multiplicá por ` +
        `${factor}). Verificá fila por fila — es el error más común. ` +
        (brief.tax_note ? `Regla del contrato: "${brief.tax_note}".` : ""),
    );
  } else if (brief.prices_include_tax === true) {
    lines.push(
      "• IMPUESTOS: los precios del documento YA incluyen el IVA. Usalos tal " +
        "cual (no sumes ni restes impuestos)." +
        (brief.tax_note ? ` Regla: "${brief.tax_note}".` : ""),
    );
  } else if (brief.tax_note) {
    lines.push(`• IMPUESTOS: ${brief.tax_note}`);
  }

  // 2. Persona adicional → triples/cuádruples.
  if (brief.additional_person.length > 0) {
    lines.push(
      "• PERSONA ADICIONAL (genera triples/cuádruples): el contrato define " +
        "tarifas de persona adicional. Para CADA fila base a la que apliquen, " +
        "completá el campo `tarifa_persona_adicional` con la tarifa RACK por " +
        "persona adicional (con IVA según la regla de impuestos de arriba). El " +
        "servidor generará las filas TPL/QDP automáticamente. Tarifas:",
    );
    for (const ap of brief.additional_person) {
      const scope = ap.scope ?? "(alcance no especificado)";
      const applies = ap.applies_to ? ` [aplica a: ${ap.applies_to}]` : "";
      const rack = ap.rack ? `rack ${ap.rack}` : "";
      const net = ap.net ? `neta ${ap.net}` : "";
      const money = [rack, net].filter(Boolean).join(" / ");
      lines.push(`    – ${scope}${applies}: ${money}`);
    }
  }

  // 3. Cuentas bancarias.
  if (brief.bank_accounts.length > 0) {
    lines.push(
      `• CUENTAS BANCARIAS (${brief.bank_accounts.length}): capturá la cuenta ` +
        "principal en shared_fields (numero_cuenta / banco / tipo_moneda). Las " +
        "cuentas adicionales se registran en los campos manuales del step 2, " +
        "pero igual listá TODAS acá para que el revisor las vea:",
    );
    for (const ba of brief.bank_accounts) {
      const parts = [
        ba.bank,
        ba.account_number,
        ba.currency,
        ba.swift ? `SWIFT ${ba.swift}` : null,
        ba.note,
      ].filter(Boolean);
      lines.push(`    – ${parts.join(" · ")}`);
    }
  }

  if (brief.meal_plan_note) {
    lines.push(`• COMIDAS: ${brief.meal_plan_note}`);
  }
  // Comisión por defecto (confirmada por el usuario) → columna porcentaje_comision.
  if (
    brief.commission_default_pct !== null &&
    brief.commission_default_pct !== undefined &&
    brief.commission_default_pct > 0
  ) {
    lines.push(
      `• COMISIÓN POR DEFECTO: ${brief.commission_default_pct}%. Aplicala a la ` +
        `columna porcentaje_comision de CADA fila salvo que la sección tenga ` +
        `una comisión distinta (ver abajo). Si la tarifa es neta, derivá el ` +
        `rack de forma consistente con este porcentaje.`,
    );
  }
  if (brief.commission_summary) {
    lines.push(`• COMISIONES POR SECCIÓN: ${brief.commission_summary}`);
  }
  if (brief.currency) {
    lines.push(
      `• MONEDA: las tarifas están en ${brief.currency}. Usá esa moneda para ` +
        `tipo_moneda salvo que una fila indique otra explícitamente.`,
    );
  }
  // Temporadas con fechas confirmadas → season_starts / season_ends por fila.
  if (brief.seasons_detail && brief.seasons_detail.length > 0) {
    lines.push(
      "• TEMPORADAS CON FECHAS (confirmadas) — usá EXACTAMENTE estos rangos " +
        "para season_starts / season_ends de cada fila de la temporada. NO " +
        "los re-inferas del documento:",
    );
    for (const s of brief.seasons_detail) {
      const name = s.name ?? "(sin nombre)";
      const range =
        s.raw_range ??
        [s.starts, s.ends].filter(Boolean).join(" → ") ??
        "(sin fechas)";
      lines.push(`    – ${name}: ${range}`);
    }
  }
  if (brief.special_periods_note) {
    lines.push(
      `• PERIODOS ESPECIALES → columna "OTHERS IN PAYMENT OR CANCELLATION" ` +
        `(others_payment_cancel): ${brief.special_periods_note}`,
    );
  }

  // Inventario / meta de completitud.
  const inv: string[] = [];
  if (brief.product_categories.length > 0) {
    inv.push(`categorías: ${brief.product_categories.join(", ")}`);
  }
  if (brief.seasons.length > 0) {
    inv.push(`temporadas: ${brief.seasons.join(", ")}`);
  }
  if (brief.sections.length > 0) {
    inv.push(`secciones: ${brief.sections.join(", ")}`);
  }
  if (inv.length > 0) {
    lines.push(
      "• INVENTARIO ESPERADO — generá TODAS las combinaciones; no resumas ni " +
        "omitas ninguna sección (las amenidades, spa y transfers se olvidan " +
        `seguido). ${inv.join(" | ")}.`,
    );
  }
  if (brief.expected_row_estimate && brief.expected_row_estimate > 0) {
    const seasonCount =
      (brief.seasons_detail?.length ?? 0) || brief.seasons.length;
    const perSeason =
      seasonCount > 0
        ? Math.round(brief.expected_row_estimate / seasonCount)
        : 0;
    const perSeasonLine =
      seasonCount > 0 && perSeason > 0
        ? ` Eso es ~${perSeason} combinaciones base POR CADA UNA de las ` +
          `${seasonCount} temporadas — generá ese bloque completo para cada ` +
          `temporada antes de pasar a la siguiente.`
        : "";
    lines.push(
      `• META DE COMPLETITUD: generá aproximadamente ` +
        `${brief.expected_row_estimate} filas base (combinaciones ` +
        `categoría × ocupación × temporada, SIN contar las filas de persona ` +
        `adicional que agrega el servidor).${perSeasonLine} Si tu salida tiene ` +
        "muchas menos, te faltaron combinaciones — revisá temporada por temporada.",
    );
  }
  if (brief.notes) {
    lines.push(`• OTRAS REGLAS: ${brief.notes}`);
  }

  return lines.join("\n");
}
