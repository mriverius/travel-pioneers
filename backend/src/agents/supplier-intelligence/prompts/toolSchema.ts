import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";
import {
  TIPO_UNIDAD_CODES,
  TIPO_SERVICIO_CODES,
} from "../generated/serviceTypesData.js";

/**
 * JSON Schema for the single tool this agent forces Claude to call. Using
 * `tool_choice: { type: "tool", name: "extraer_datos_contrato" }` is what
 * guarantees we get structured JSON back instead of free-form text.
 *
 * Modelo de datos: { shared_fields, rows, ... metadata }. Un contrato típico
 * lista N categorías × M temporadas combinaciones (ej. Parador: 7 × 3 = 21).
 * Cada combinación es una fila independiente en el xlsx maestro; los datos
 * del proveedor / contrato / bancos se repiten en cada fila.
 *
 * - `shared_fields`: datos que aparecen UNA sola vez en el contrato.
 * - `rows`: array de combinaciones product × season. La IA debe emitir TODAS
 *   las combinaciones explícitas. Si el contrato cubre solo un producto y una
 *   temporada, devolver `rows: [{ ... }]` (un solo elemento).
 *
 * Los enums de tipo_unidad y tipo_servicio se generan desde el xlsx
 * (`generated/serviceTypesData.ts`). Para `categoria` no podemos restringir
 * con enum porque el conjunto válido depende del tipo_servicio elegido — lo
 * validamos post-hoc en `validators.ts`.
 */
export const EXTRAER_DATOS_CONTRATO_TOOL_NAME = "extraer_datos_contrato" as const;

const sharedFieldsSchema = {
  type: "object",
  description:
    "Datos que aparecen una sola vez en el contrato (proveedor, vigencia, " +
    "clasificación, bancos). Se replican en cada fila del xlsx.",
  properties: {
    fecha: {
      type: ["string", "null"],
      description:
        "Fecha de firma del contrato en formato YYYY-MM-DD. Si hay varias " +
        "firmas (una por parte), usar SIEMPRE la más reciente — es la que " +
        "cierra el acuerdo. Ej: en un contrato firmado el 12-feb-2025 por " +
        "el hotel y el 13-feb-2025 por la agencia, devolver '2025-02-13'.",
    },
    proveedor: {
      type: ["string", "null"],
      description:
        "Razón social / nombre legal completo. Termina típicamente en " +
        "S.A., S.R.L., LLC, S. de R.L. Ejemplos del maestro: " +
        "'Albergues Monteverde, S.A', 'Hotel Parador Quepos S.A.'",
    },
    nombre_comercial: {
      type: ["string", "null"],
      description:
        "Nombre comercial / marca pública. Ejemplos: 'Monteverde Lodge & " +
        "Gardens', 'Hotel Parador Resort & Spa'.",
    },
    cedula: {
      type: ["string", "null"],
      description:
        "Cédula jurídica / RFC / NIT, formato original. Ejemplos del " +
        "maestro CR: '3-101-104645', '3-101-118200'.",
    },
    direccion: {
      type: ["string", "null"],
      description:
        "Dirección física completa, compuesta si está fragmentada en el " +
        "documento.",
    },
    telefono: {
      type: ["string", "null"],
      description:
        "Teléfono con código de país (+506 para CR, +52 para MX, etc.). " +
        "Ej: '(506) 2777-1414'.",
    },
    pais: {
      type: ["string", "null"],
      description:
        "País del proveedor. INFERIBLE: si la dirección menciona ciudades " +
        "costarricenses (Quepos, Monteverde, Manuel Antonio, San José, " +
        "etc.) o el teléfono inicia con '+506' o '(506)', el país es " +
        "'Costa Rica'. Aplicar lógica análoga para MX, GT, etc. Marcar " +
        "como 'inferido' en paginas_origen_shared cuando se infiera.",
    },
    state_province: {
      type: ["string", "null"],
      description:
        "Provincia/estado. INFERIBLE desde geografía conocida: Quepos / " +
        "Manuel Antonio / Jacó → 'Puntarenas'. La Fortuna / Arenal → " +
        "'Alajuela'. Monteverde → 'Puntarenas'. Tamarindo / Liberia → " +
        "'Guanacaste'. San José ciudad → 'San José'. Marcar 'inferido' " +
        "en paginas_origen_shared.",
    },
    type_of_business: {
      type: ["string", "null"],
      description:
        "Rubro principal del proveedor según el contrato. Inferible del " +
        "título / encabezado del documento. Ejemplos: 'Hotel', 'Tour " +
        "Operator', 'Transfer Service', 'Restaurant', 'Rent a Car'. Si el " +
        "título dice 'CONTRATO HOTEL X', devolver 'Hotel'.",
    },
    contract_starts: {
      type: ["string", "null"],
      description:
        "Fecha de inicio de vigencia del contrato (YYYY-MM-DD). Si el " +
        "contrato cubre 'temporada 2026' y la primera temporada/tarifa " +
        "empieza el 20-dic-2025, esa es la fecha de inicio. Si no es " +
        "explícita, inferir de la primera fecha de tarifas/temporadas.",
    },
    contract_ends: {
      type: ["string", "null"],
      description:
        "Fecha de fin de vigencia del contrato (YYYY-MM-DD). Última fecha " +
        "de la temporada/tarifa más tardía mencionada en el contrato.",
    },
    reservations_email: {
      type: ["string", "null"],
      description:
        "Email del departamento de reservaciones. Si hay varios contactos, " +
        "priorizar el etiquetado como 'Reservaciones' o equivalente sobre " +
        "el genérico de info@. Ejemplos: 'reservationsupervisor@hotelparador.com', " +
        "'RESERVACIONES@BOENA.COM'.",
    },
    tipo_unidad: {
      type: ["string", "null"],
      enum: [...TIPO_UNIDAD_CODES, null],
      description:
        "Tipo de unidad (columna P). 'N' si la tarifa contractual es POR " +
        "NOCHE — típico en hoteles, lodges, B&B. 'S' si es POR SERVICIO " +
        "— tours, canopy, transfers, comidas. null si no se puede inferir. " +
        "Normalmente es el MISMO para todas las filas del contrato.",
    },
    tipo_servicio: {
      type: ["string", "null"],
      enum: [...TIPO_SERVICIO_CODES, null],
      description:
        "Código de Tipo de Servicio (columna Q). Debe ser uno de los " +
        "códigos listados en el system prompt — los más comunes son HO " +
        "(HOTEL), TO (TOURS), TR (TRANSFER), RE (RENT A CAR), AL (MEAL). " +
        "Normalmente es el MISMO para todas las filas del contrato.",
    },
    tipo_moneda: {
      type: ["string", "null"],
      description:
        "Código ISO 4217 de la moneda principal de las tarifas (USD, " +
        "CRC, MXN, EUR). Si el contrato usa '$' y el contexto es " +
        "Costa Rica para tarifas turísticas, normalmente es 'USD'. Marcar " +
        "'inferido' en paginas_origen_shared cuando no esté explícita.",
    },
    numero_cuenta: {
      type: ["string", "null"],
      description:
        "Cuenta bancaria. PREFERIR IBAN sobre cuenta local si ambos " +
        "están en el documento. Conservar formato original con espacios. " +
        "Ejemplo: 'CR39 0151 0221 0026 0000 48'.",
    },
    banco: {
      type: ["string", "null"],
      description:
        "Nombre del banco. Ejemplo: 'Banco Nacional de Costa Rica', 'BAC " +
        "Credomatic'.",
    },
    others_payment_cancel: {
      type: ["string", "null"],
      description:
        "Columna AK — 'OTHERS IN PAYMENT OR CANCELLATION'. Reglas de PAGO o " +
        "CANCELACIÓN que aplican SOLO a PERIODOS ESPECIALES y se salen de la " +
        "política general (que va en cancellation_policy / " +
        "range_payment_policy). Casos típicos: temporada navideña / fin de " +
        "año, Semana Santa, feriados, eventos, fechas pico con prepago " +
        "anticipado o cancelación más estricta. Ejemplo real: 'Periodo " +
        "Navideño: reservas que incluyan fechas entre 15-dic-2025 y " +
        "15-ene-2026 deben prepagarse el 14-oct-2025; cancelación 30 días " +
        "antes de la llegada'. Si hay varios periodos especiales, unilos con " +
        "' ; '. Es contract-wide: el writer replica este valor en TODAS las " +
        "filas (columna AK). NO repitas acá la política general de pago/" +
        "cancelación. null si el contrato no define periodos especiales.",
    },
    notes: {
      type: ["string", "null"],
      description:
        "Columna BA — 'NOTAS' (BOOKING NOTES). Listado de cláusulas " +
        "operacionales del contrato. Fuente principal: la sección al final " +
        "del contrato titulada 'BOOKING NOTES' / 'GENERAL CONDITIONS' / " +
        "'TERMS & CONDITIONS' / 'NOTAS DE RESERVA' / 'OBSERVACIONES " +
        "GENERALES' o equivalente — copiar CADA bullet como un item " +
        "separado, en el mismo orden, casi literal. Agregar también " +
        "cláusulas sueltas que estén en otras partes del contrato y no " +
        "encajen en ninguna columna del schema (restricciones de edad, " +
        "requisitos de booking — prepago, garantía con tarjeta, ID — " +
        "alérgenos / restricciones alimentarias, exclusiones, force " +
        "majeure, límites de equipaje, pesos/edades en tours acuáticos, " +
        "etc.). Unir todos los items con ' ; ' (espacio punto-y-coma " +
        "espacio). Ejemplo formato esperado: 'Rates are in US$ and do not " +
        "include 13% government taxes ; Room rates are per night and " +
        "based on double occupancy ; Minimum age for staying is 18 years " +
        "old ; Check-in 3:00 pm, check-out 11:00 am ; Minimum stay during " +
        "Holiday Season is 4 nights'. Es contract-wide: el writer del xlsx " +
        "replica este valor en cada fila de la columna BA. NO inventar; " +
        "NO repetir info que ya está en cancellation_policy o " +
        "range_payment_policy. null si no hay nada que reportar.",
    },
  },
  required: [
    "fecha",
    "proveedor",
    "nombre_comercial",
    "cedula",
    "direccion",
    "telefono",
    "pais",
    "state_province",
    "type_of_business",
    "contract_starts",
    "contract_ends",
    "reservations_email",
    "tipo_unidad",
    "tipo_servicio",
    "tipo_moneda",
    "numero_cuenta",
    "banco",
    "others_payment_cancel",
    "notes",
  ],
} as const;

const rowSchema = {
  type: "object",
  description:
    "Una fila del xlsx — una combinación product × season del contrato. Si " +
    "el contrato lista N categorías × M temporadas, devolver N*M filas.",
  properties: {
    product_name: {
      type: ["string", "null"],
      description:
        "Nombre del producto/categoría de habitación o servicio (ej: " +
        "'Garden', 'Vista Suites', 'Penthouse', 'Canopy Tour'). Tal cual " +
        "aparece en el contrato.",
    },
    categoria: {
      type: ["string", "null"],
      description:
        "Código de Categoría del catálogo Utopía (columna R). Debe " +
        "pertenecer al tipo_servicio de la fila (override) o, en su " +
        "defecto, al tipo_servicio shared. Para hospedajes: STD, OCV " +
        "(Ocean View), DLX, SUI, MAS, FAM, PNT, PRM, etc. Para tours / " +
        "actividades / transfers / comidas: 'UNI' (UNIDADES). NUNCA " +
        "devolver null — usar 'STD' como último recurso para HO y 'UNI' " +
        "para todo lo demás.",
    },
    tipo_servicio: {
      type: ["string", "null"],
      enum: [...TIPO_SERVICIO_CODES, null],
      description:
        "Código de Tipo de Servicio POR FILA (columna Q). Override del " +
        "tipo_servicio shared cuando el contrato mezcla servicios — caso " +
        "típico: contrato de hotel + Experiences Book con tours. " +
        "Hoteles/lodges/resorts → 'HO'. Tours/actividades/canopy → 'TO'. " +
        "Transfers → 'TR'. Comidas/desayunos cobrados aparte → 'AL'. " +
        "Rent a car → 'RE'. Si la fila comparte el mismo valor que el " +
        "shared, devolver null y dejar que el writer use el shared.",
    },
    tipo_unidad: {
      type: ["string", "null"],
      enum: [...TIPO_UNIDAD_CODES, null],
      description:
        "Tipo de unidad POR FILA (columna P). 'N' = POR NOCHE: el precio es " +
        "el costo de UNA noche por habitación (hospedajes estándar). 'S' = " +
        "POR SERVICIO o PAQUETE: tours, transfers, comidas, rent a car por " +
        "día, O una tarifa de hospedaje que es un PAQUETE de varias noches a " +
        "precio fijo por habitación (ej. encabezado '2N/3D' donde el neto ya " +
        "es el total por las 2 noches, no por noche) → 'S' aunque sea hotel. " +
        "Si coincide con el shared, devolver null.",
    },
    codigo_servicio: {
      type: ["string", "null"],
      description:
        "Código corto único por fila (columna N — 'Cod.Servicio'). Bug #2: " +
        "se DEBE derivar del nombre del producto de ESTA fila, no copiar " +
        "el primero del contrato. Reglas de mapeo (case-insensitive, en " +
        "orden de prioridad):\n" +
        "  • 'Master Suite' / 'Vista Master Suite' → 'MAS'\n" +
        "  • 'Penthouse' → 'PNT'\n" +
        "  • 'Family Suite' / 'Family Room' → 'FAM'\n" +
        "  • 'Deluxe Suite' → 'DLX'\n" +
        "  • 'Junior Suite' → 'JUN'\n" +
        "  • 'Infinity Suite' / 'Vista Suite' / cualquier otra '... Suite' → 'SUI'\n" +
        "  • 'Premium' (sin 'Suite') → 'PRM'\n" +
        "  • 'Standard' / 'Garden' / 'Tropical' / nombre de ave o " +
        "naturaleza (Cotinga, Motmot, Toucanet, etc.) → 'STD'\n" +
        "  • 'Superior' → 'SUP'\n" +
        "  • 'Villa' → 'VIL'\n" +
        "  • 'Bungalow' → 'BUN'\n" +
        "  • Tour / actividad / transfer / comida → 'UNI'\n" +
        "  • Cualquier otro hospedaje no reconocido → 'STD'\n" +
        "Si tenés dudas en el mapeo, devolver el código y agregar " +
        "'[REVIEW NEEDED]' al campo `shared_fields.notes` con el motivo.",
    },
    ocupacion: {
      type: ["string", "null"],
      description:
        "Código corto de ocupación. Convención del maestro: 'DBL' = " +
        "doble, 'SGL' = single, 'TPL' = triple, 'QDP' = cuádruple, 'FAM' " +
        "= familiar. Si el contrato dice 'sencilla o doble', devolver 'DBL'. " +
        "NO generes filas TPL/QDP manualmente cuando hay tarifa por persona " +
        "adicional — el servidor las crea solo (ver tarifa_persona_adicional " +
        "y regla 16b del system prompt).",
    },
    tarifa_persona_adicional: {
      type: ["string", "null"],
      description:
        "AUXILIAR (no es una columna del xlsx). Si el contrato define una " +
        "'tarifa por persona adicional' (ej. 'Tarifa persona adicional $46 + " +
        "imp'), poné aquí ese monto YA expresado como precio RACK/público CON " +
        "IVA incluido — la misma convención que precio_rack_iva. Convertí los " +
        "impuestos: si dice '$46 + imp' con IVA 13%, devolvé '51.98'. Si el " +
        "documento ya lo da con impuesto incluido, usá ese número tal cual. " +
        "Solo número (sin símbolo de moneda ni '%'). Poné el MISMO valor en " +
        "cada fila base de hospedaje a la que aplica. El servidor genera " +
        "automáticamente las filas TPL (base + 1×) y QDP (base + 2×). Dejá " +
        "null si el contrato NO menciona persona adicional, o si el contrato " +
        "YA lista tarifas explícitas para triple/cuádruple (en ese caso " +
        "generá esas filas vos mismo con su ocupacion correcta).",
    },
    season_name: {
      type: ["string", "null"],
      description:
        "Nombre de la temporada (ej: 'PEAK', 'ALTA', 'BAJA', 'GREEN " +
        "SEASON'). Tal cual aparece en el contrato.",
    },
    season_starts: {
      type: ["string", "null"],
      description:
        "Fecha de inicio de esta temporada (YYYY-MM-DD). Si la temporada " +
        "tiene rangos múltiples (ej. 'ALTA: 4-ene al 30-abr, 1-jul al " +
        "31-ago, 15-nov al 19-dic'), usar la fecha del PRIMER rango.",
    },
    season_ends: {
      type: ["string", "null"],
      description:
        "Fecha de fin de esta temporada (YYYY-MM-DD). Si hay rangos " +
        "múltiples, usar la fecha del PRIMER rango (consistente con " +
        "season_starts).",
    },
    meals_included: {
      type: ["string", "null"],
      description:
        "Comidas incluidas en la tarifa, en MAYÚSCULAS, usando los NOMBRES " +
        "de las comidas. Valores válidos: 'BREAKFAST', 'LUNCH', 'DINNER', " +
        "'ALL INCLUSIVE', 'NONE'. NO uses códigos de plan tipo 'AP'/'MAP' — " +
        "no existen; traducí el plan a las comidas que cubre. Si hay varias, " +
        "separalas por coma en orden desayuno→almuerzo→cena. Ejemplos: " +
        "'incluye desayuno' → 'BREAKFAST'; media pensión → 'BREAKFAST, " +
        "DINNER'; pensión completa (desayuno, almuerzo y cena) → 'BREAKFAST, " +
        "LUNCH, DINNER'; todo incluido → 'ALL INCLUSIVE'; sin comidas → 'NONE'.",
    },
    precios_neto_iva: {
      type: ["string", "null"],
      description:
        "Precio NETO con IVA incluido (tarifa que el hotel da a la " +
        "agencia, la más baja). Número sin símbolo de moneda (ej: '70', " +
        "'276.75'). SIEMPRE ≤ precio_rack_iva. Si el contrato da SOLO el " +
        "rack + un % de comisión (sin neto explícito), CALCULALO: " +
        "neto = rack × (1 − comisión/100). Ej: rack con IVA 155.94, " +
        "comisión 10% → neto '140.35'. ⚠️ Si NO estás seguro del valor, " +
        "dejá null (no inventes) — el precio es el dato más sensible.",
    },
    precio_rack_iva: {
      type: ["string", "null"],
      description:
        "Precio RACK/público con IVA incluido (tarifa al público, la más " +
        "alta). Misma combinación que precios_neto_iva y SIEMPRE ≥ a ella " +
        "(ej. neto '70' → rack '100'). Si el IVA NO está incluido en el " +
        "documento (ej. '13% IVA no incluido'), SUMALO. Si el contrato no " +
        "distingue neto/rack y no hay comisión, copiar el mismo valor. " +
        "⚠️ Si NO estás seguro del valor, dejá null (no inventes).",
    },
    porcentaje_comision: {
      type: ["string", "null"],
      description:
        "Porcentaje de comisión, SOLO el número sin el símbolo '%' (ej: " +
        "'25', no '25%'). Si viene como fracción ('0.25') convertir a " +
        "'25'. Si el contrato dice 'NETAS, NO COMISIONABLES' o 'sin " +
        "comisión', devolver '0'.",
    },
    precios_neto_iva_fds: {
      type: ["string", "null"],
      description:
        "Precio neto con IVA — fin de semana. Si el contrato NO distingue " +
        "tarifas weekday/weekend, copiar el mismo valor que precios_neto_iva " +
        "(convención del maestro Utopía).",
    },
    precio_rack_iva_fds: {
      type: ["string", "null"],
      description:
        "Precio rack con IVA — fin de semana. Si no hay distinción, " +
        "copiar precio_rack_iva.",
    },
    porcentaje_comision_fds: {
      type: ["string", "null"],
      description:
        "Porcentaje de comisión — fin de semana, SOLO el número sin '%'. " +
        "Copiar porcentaje_comision si no hay distinción.",
    },
    cancellation_policy: {
      type: ["string", "null"],
      description:
        "Política de cancelación aplicable a esta combinación, resumida a " +
        "1-2 oraciones. Si la política varía por temporada (como en " +
        "Parador, donde PEAK/ALTA/BAJA tienen reglas distintas), poner LA " +
        "POLÍTICA DE ESTA TEMPORADA. Si no varía, copiar la misma en " +
        "todas las filas.",
    },
    range_payment_policy: {
      type: ["string", "null"],
      description:
        "POLÍTICA/condiciones de pago para esta combinación: plazos, " +
        "depósitos, anticipos, fechas límite y penalidades. NO listar los " +
        "MEDIOS de pago disponibles (transferencia, tarjeta, etc.) — eso " +
        "no es la política. Ej: '50% de depósito al confirmar, saldo 30 " +
        "días antes del check-in'. Si varía por temporada (Parador: Peak " +
        "60d, Alta 30d, Baja 15d), poner la de ESTA temporada.",
    },
    kids_policy: {
      type: ["string", "null"],
      description:
        "Política de niños. Típicamente igual entre filas — copiar el " +
        "mismo valor en todas si el contrato no la distingue por temporada.",
    },
    other_included: {
      type: ["string", "null"],
      description:
        "Otros servicios/amenidades incluidos en la tarifa que no sean " +
        "comidas (eso va en meals_included). Ejemplo: 'Acceso a fitness, " +
        "Wi-Fi, toallas para piscina/playa, transporte a Manuel Antonio'.",
    },
    feeds_adicionales: {
      type: ["string", "null"],
      description:
        "Cargos adicionales no incluidos en la tarifa base (resort fee, " +
        "conservation fee, IVA externo, etc.). Ejemplo: '$15 resort fee " +
        "por habitación por noche'.",
    },
  },
  required: [
    "product_name",
    "categoria",
    "tipo_servicio",
    "tipo_unidad",
    "codigo_servicio",
    "ocupacion",
    "season_name",
    "season_starts",
    "season_ends",
    "meals_included",
    "precios_neto_iva",
    "precio_rack_iva",
    "porcentaje_comision",
    "precios_neto_iva_fds",
    "precio_rack_iva_fds",
    "porcentaje_comision_fds",
    "cancellation_policy",
    "range_payment_policy",
    "kids_policy",
    "other_included",
    "feeds_adicionales",
  ],
} as const;

export const EXTRAER_DATOS_CONTRATO_TOOL: Tool = {
  name: EXTRAER_DATOS_CONTRATO_TOOL_NAME,
  description:
    "Extrae datos del contrato comercial siguiendo el formato del maestro " +
    "Utopía. Devuelve `shared_fields` (datos del proveedor, contrato y " +
    "bancos — aparecen una sola vez) más `rows` (un array con TODAS las " +
    "combinaciones product × season que el contrato lista explícitamente). " +
    "Si el contrato tiene 7 categorías × 3 temporadas = 21 filas, devolver " +
    "21 elementos en `rows`. Para campos no presentes devolver null y " +
    "agregar el nombre del campo a campos_faltantes.",
  input_schema: {
    type: "object",
    properties: {
      shared_fields: sharedFieldsSchema,
      rows: {
        type: "array",
        minItems: 1,
        description:
          "Array de combinaciones product × season. Mínimo 1, sin máximo. " +
          "Generar TODAS las combinaciones explícitas — no resumir.",
        items: rowSchema,
      },
      bank_accounts: {
        type: "array",
        description:
          "TODAS las cuentas bancarias del contrato. Es MUY común que haya " +
          "varias (USD y CRC, banco principal y secundario, por monto de " +
          "transacción). Capturá CADA UNA por separado — NO resumas ni " +
          "devuelvas solo la primera. Incluí también la que pusiste en " +
          "shared_fields (numero_cuenta/banco). Ejemplo: un contrato con " +
          "cuenta BCR-USD, BCR-CRC, LAFISE-USD y LAFISE-CRC son 4 entradas.",
        items: {
          type: "object",
          properties: {
            bank: {
              type: ["string", "null"],
              description: "Nombre del banco. Ej: 'Banco de Costa Rica (BCR)'.",
            },
            account_number: {
              type: ["string", "null"],
              description:
                "IBAN o número de cuenta tal cual aparece. Ej: " +
                "'CR20015201001050148756'.",
            },
            currency: {
              type: ["string", "null"],
              description: "Moneda de la cuenta: USD, CRC, EUR, etc.",
            },
            note: {
              type: ["string", "null"],
              description:
                "Condición de uso si la hay, ej. 'para transacciones < $49k' " +
                "o 'cuenta principal'.",
            },
          },
          required: ["bank", "account_number", "currency"],
          additionalProperties: false,
        },
      },
      payment_terms: {
        type: "object",
        description:
          "Términos de pago / condición de crédito GLOBAL del contrato. " +
          "Buscar en la sección de forma de pago / términos comerciales.",
        properties: {
          condition: {
            type: ["string", "null"],
            description:
              "Una de: 'CONTADO' (pago inmediato / sin crédito), 'CREDITO' " +
              "(el proveedor da plazo de crédito, ej. 30 días neto), o " +
              "'PREPAGO' (hay que prepagar antes de la llegada / por " +
              "anticipado). null si el contrato no lo especifica.",
          },
          term_days: {
            type: ["number", "null"],
            description:
              "Días de crédito cuando condition='CREDITO' (ej. 30, 15). " +
              "null si no aplica.",
          },
          term_note: {
            type: ["string", "null"],
            description:
              "Detalle del plazo o del prepago requerido en texto corto " +
              "(ej. 'prepago al confirmar', '50% al reservar, 50% a 30 días'). " +
              "null si no hay detalle.",
          },
        },
        required: ["condition", "term_days", "term_note"],
        additionalProperties: false,
      },
      confianza: {
        type: "string",
        enum: ["alta", "media", "baja"],
        description: "Confianza global de la extracción.",
      },
      campos_faltantes: {
        type: "array",
        items: { type: "string" },
        description:
          "Lista de nombres de campos que NO aparecen en el documento y NO " +
          "se pudieron inferir. Cubre tanto campos shared como de fila — " +
          "si un campo de fila está faltante en TODAS las filas, mencionarlo " +
          "una sola vez (ej: 'porcentaje_comision'). Estos se mostrarán al " +
          "usuario como 'No encontrado en el documento'.",
      },
      paginas_origen_shared: {
        type: "object",
        description:
          "Mapa de nombre_campo_shared -> número de página (o 'inferido' / " +
          "'multiple'). Anotar 'inferido' en pais, state_province, " +
          "type_of_business, tipo_moneda cuando se hayan inferido del " +
          "contexto en lugar de extraerse literalmente.",
      },
      paginas_origen_rows: {
        type: "array",
        description:
          "Mapa por fila (mismo orden que `rows`). Cada elemento es un " +
          "objeto nombre_campo_de_fila -> página/'inferido'/'multiple'. La " +
          "longitud DEBE ser igual a la de `rows`. Útil principalmente para " +
          "campos de precio que pueden venir de tablas en páginas " +
          "específicas del contrato.",
        items: {
          type: "object",
        },
      },
    },
    required: [
      "shared_fields",
      "rows",
      "bank_accounts",
      "payment_terms",
      "confianza",
      "campos_faltantes",
      "paginas_origen_shared",
      "paginas_origen_rows",
    ],
  },
};
