import { REGISTRAR_BRIEF_CONTRATO_TOOL_NAME } from "./briefSchema.js";

/**
 * Plantilla OBLIGATORIA del campo `logic_summary`. Se inyecta tanto en el
 * análisis inicial como en cada refinamiento por feedback, para que el
 * resumen tenga SIEMPRE la misma estructura de 10 secciones (legible y
 * comparable entre regeneraciones).
 */
export const LOGIC_SUMMARY_FORMAT =
  "FORMATO OBLIGATORIO de `logic_summary` (Markdown, ESPAÑOL, segunda " +
  "persona). Usá EXACTAMENTE estas 10 secciones, SIEMPRE en este orden y " +
  "con estos títulos en negrita SIN EMOJIS (no los cambies, no los reordenes, " +
  "no agregues ni quites secciones). Si una sección no aplica, inclúyela igual " +
  "con 'No se detectaron' o 'No aplica':\n\n" +
  "**Proveedor**\n" +
  "Nombre comercial, razón social, ubicación, tipo de negocio, vigencia del contrato.\n\n" +
  "**Tarifas y moneda**\n" +
  "Moneda, si incluye o no IVA, tasa de impuesto, nota sobre fees adicionales.\n\n" +
  "**Comisión**\n" +
  "Porcentaje base, si varía por temporada/categoría, cómo se calcula.\n\n" +
  "**Temporadas**\n" +
  "Lista de temporadas con nombre, fechas inicio–fin, tipo de tarifa (por noche / por servicio / paquete).\n\n" +
  "**Habitaciones / Servicios**\n" +
  "Lista de categorías detectadas, ocupación máxima y ocupaciones POR CATEGORÍA. " +
  "Si la tabla tiene columnas distintas por habitación (ej. suites SGL+DBL+TPL+Niño; " +
  "villas +Cuádruple; Jaguar +Quíntuple), llená `occupancies_by_product` — NO asumas " +
  "que QDP/QTN aplican a todas. `occupancy_codes` es solo la unión global de referencia.\n" +
  "Si el contrato limita a 2 adultos por habitación o prohíbe cuádruple, llená " +
  "`max_adults_per_room: 2` y `quadruple_allowed: false`.\n\n" +
  "**Tipo de tarifa (tipo_unidad)**\n" +
  "N = por noche (hotel estándar). S = por servicio/paquete (Full Experience, all-inclusive, " +
  "paquete 2N/3D — el precio es el total del paquete, NO una noche). Lodges tipo Pacuare " +
  "Full Experience → S.\n\n" +
  "OBLIGATORIO incluir una línea sobre tarifa de niño: si hay tarifa niño escribí " +
  "'Tarifa de niño detectada: [descripción]. Se generarán filas CHL.'; si no hay, " +
  "'No se detectó tarifa de niño en el contrato.'\n\n" +
  "**Plan de filas estimado**\n" +
  "Fórmula explícita: X categorías × Y ocupaciones × Z temporadas = N filas. Notas sobre el conteo.\n\n" +
  "**Servicios incluidos**\n" +
  "Plan de comidas, transfers, amenidades, Wi-Fi, etc. incluidos en la tarifa.\n\n" +
  "**Políticas de pago y cancelación**\n" +
  "Por temporada: depósitos, deadlines de pago, condiciones de cancelación.\n\n" +
  "**Cuentas bancarias**\n" +
  "Si las hay: banco, titular, IBAN/cuenta. Si no, indicá explícitamente 'No se detectaron'.\n\n" +
  "**Notas críticas**\n" +
  "Cualquier dato inusual, ambiguo, contradictorio o que el operador humano deba verificar a mano.";

/**
 * System prompt dedicado a la Fase 1 (análisis con Opus). Más corto y
 * focalizado que el prompt de extracción: el objetivo es ENTENDER la lógica
 * del documento, no generar filas de tarifas.
 */
export const BRIEF_ANALYSIS_SYSTEM_PROMPT =
  "Eres un analista experto en contratos y tarifarios turísticos " +
  "(hoteles, lodges, tours, transfers) para operadoras en Latinoamérica.\n\n" +
  "Tu trabajo en esta fase es ENTENDER Y ESTRUCTURAR la lógica del documento, " +
  "NO extraer todas las tarifas fila por fila. Identificá:\n" +
  "  • Estructura tarifaria: cómo organiza el proveedor sus precios\n" +
  "  • Nomenclatura de habitaciones/servicios y temporadas\n" +
  "  • Reglas de IVA/impuestos, comisión y moneda\n" +
  "  • Persona adicional, cuentas bancarias, plan de comidas, políticas especiales\n" +
  "  • Inventario: categorías, temporadas con fechas, secciones\n\n" +
  "Generá un `logic_summary` que un operador humano pueda leer de un vistazo " +
  "y confirmar si entendiste bien.\n" +
  "Estimá el `row_plan` (categorías × ocupaciones × temporadas) para que la " +
  "extracción final sepa cuántas filas esperar.\n\n" +
  "IMPORTANTE: si recibís UN SOLO documento, analizá SOLO ese documento. No " +
  "inventes ni asumas datos de otros documentos.\n\n" +
  LOGIC_SUMMARY_FORMAT;

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
  "completo.\n" +
  "  8. logic_summary: resumen narrativo en ESPAÑOL siguiendo el FORMATO " +
  "OBLIGATORIO de 10 secciones (ver abajo).\n" +
  "  9. row_plan: categorías, ocupaciones por categoría, cantidad de " +
  "temporadas y expected_rows (categorías × ocupaciones × temporadas).\n\n" +
  "Sé EXHAUSTIVO sobre todo en bancos y persona adicional — son los datos que " +
  "más se pierden cuando se extrae todo de una vez.\n\n" +
  LOGIC_SUMMARY_FORMAT;

/**
 * Instrucción para re-analizar el brief tras feedback del usuario (refine).
 */
export const CONTRACT_BRIEF_REFINE_INSTRUCTION =
  "RE-ANÁLISIS DEL CONTRATO (corrección humana).\n\n" +
  "Arriba tenés el documento original, el brief que generaste antes y el " +
  "feedback del operador. Tu trabajo es CORREGIR el brief según lo que el " +
  "usuario indicó — no extraigas filas de tarifas todavía.\n\n" +
  `Registrá el brief ACTUALIZADO con el tool "${REGISTRAR_BRIEF_CONTRATO_TOOL_NAME}".\n\n` +
  "Reglas:\n" +
  "  • El feedback del usuario tiene PRIORIDAD sobre tu análisis anterior.\n" +
  "  • Re-leé el documento solo para verificar/corregir lo que el usuario señaló.\n" +
  "  • Actualizá logic_summary respetando el MISMO FORMATO OBLIGATORIO de 10 " +
  "secciones (ver abajo) — no devuelvas un bloque de texto pegado sin estructura.\n" +
  "  • Recalculá row_plan y expected_row_estimate si cambian categorías, " +
  "temporadas u ocupaciones.\n" +
  "  • Mantén intacto lo que el usuario NO cuestionó.\n\n" +
  LOGIC_SUMMARY_FORMAT;

/**
 * Cierre de extracción cuando el brief ya fue validado por un humano.
 */
export const EXTRACT_WITH_CONFIRMED_BRIEF_CLOSING =
  "El CONTRACT BRIEF de arriba fue VALIDADO por un operador humano — " +
  "tratalo como FUENTE DE VERDAD para TODAS las reglas globales (IVA, " +
  "comisión, temporadas, fechas, comidas, persona adicional, bancos). " +
  "Usá el documento adjunto ÚNICAMENTE para leer los valores literales de " +
  "precios y nombres de producto; NO re-interprete las reglas globales del " +
  "documento si contradicen el brief confirmado. " +
  "Respetá estrictamente row_plan.expected_rows / expected_row_estimate como " +
  "meta de completitud. Genera TODAS las combinaciones product × season en " +
  "`rows` — no resumas a una sola fila.";

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
  row_plan?: {
    categories: string[];
    occupancies_per_category: number | null;
    seasons_count: number | null;
    expected_rows: number | null;
  } | null;
  tipo_unidad?: "N" | "S" | null;
  occupancy_codes?: string[];
  occupancies_by_product?: Array<{
    product: string;
    occupancy_codes: string[];
  }>;
  max_adults_per_room?: number | null;
  quadruple_allowed?: boolean | null;
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

  if (brief.tipo_unidad === "S") {
    lines.push(
      "• TIPO UNIDAD: S (por servicio/paquete) — el precio es el total del " +
        "paquete/experiencia, NO por noche. Poné tipo_unidad=S en TODAS las filas.",
    );
  } else if (brief.tipo_unidad === "N") {
    lines.push(
      "• TIPO UNIDAD: N (por noche) — multiplicá noches × tarifa para el total.",
    );
  }

  const perProduct =
    brief.occupancies_by_product && brief.occupancies_by_product.length > 0
      ? brief.occupancies_by_product
      : null;
  const occCodes =
    brief.occupancy_codes && brief.occupancy_codes.length > 0
      ? brief.occupancy_codes.map((c) => c.toUpperCase())
      : null;
  if (perProduct && perProduct.length > 0) {
    lines.push(
      "• OCUPACIONES POR PRODUCTO (catálogo Utopía) — generá SOLO las filas " +
        "que correspondan a cada habitación; NO copies QDP/QTN a suites si el " +
        "PDF no las publica:",
    );
    for (const spec of perProduct) {
      const codes = spec.occupancy_codes.map((c) => c.toUpperCase()).join(", ");
      lines.push(`  – ${spec.product}: ${codes}`);
    }
  } else if (occCodes && occCodes.length > 0) {
    lines.push(
      `• OCUPACIONES (referencia global): ${occCodes.join(", ")}. ` +
        "Si el PDF publica columnas distintas por habitación, respetá eso " +
        "(suites ≠ villas).",
    );
  }

  if (
    brief.quadruple_allowed === false ||
    (brief.max_adults_per_room != null && brief.max_adults_per_room <= 3)
  ) {
    lines.push(
      "• CUÁDRUPLE PROHIBIDA — NO generes filas QDP ni QTN en ninguna " +
        "categoría. TPL (triple) solo si el contrato publica precio triple.",
    );
  }

  if (brief.seasons_detail && brief.seasons_detail.length > 0) {
    const seasonLines = brief.seasons_detail
      .filter((s) => s.name)
      .map(
        (s) =>
          `${s.name}: ${s.starts ?? "?"} → ${s.ends ?? "?"}` +
          (s.raw_range ? ` (${s.raw_range})` : ""),
      );
    if (seasonLines.length > 0) {
      lines.push(
        "• FECHAS DE TEMPORADA (usar en season_starts/season_ends de cada fila):",
      );
      for (const sl of seasonLines) lines.push(`  – ${sl}`);
    }
  }

  if (brief.expected_row_estimate && brief.expected_row_estimate > 0) {
    const targetRows =
      brief.row_plan?.expected_rows ?? brief.expected_row_estimate;
    const seasonCount =
      brief.row_plan?.seasons_count ??
      ((brief.seasons_detail?.length ?? 0) || brief.seasons.length);
    const occPerCat = brief.row_plan?.occupancies_per_category;
    const perSeason =
      seasonCount > 0 ? Math.round(targetRows / seasonCount) : 0;
    const perSeasonLine =
      seasonCount > 0 && perSeason > 0
        ? ` Eso es ~${perSeason} combinaciones base POR CADA UNA de las ` +
          `${seasonCount} temporadas — generá ese bloque completo para cada ` +
          `temporada antes de pasar a la siguiente.`
        : "";
    if (occPerCat != null && occPerCat >= 3) {
      lines.push(
        `• OCUPACIONES ESPERADAS: ~${occPerCat} por categoría — si el PDF tiene ` +
          `columnas Triple/Quadruple/Quintuple con precios propios, generá filas ` +
          `TPL/QDP/QTN (no solo SGL/DBL). CHL es aparte si hay tarifa niño.`,
      );
    }
    lines.push(
      `• META DE COMPLETITUD: generá aproximadamente ` +
        `${targetRows} filas base (combinaciones ` +
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
