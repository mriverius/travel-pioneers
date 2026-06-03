import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";

/**
 * Contract Brief — Fase 1 de la extracción multi-pasada.
 *
 * Motivación (post-mortem del contrato CWL de 127 filas): cuando forzamos al
 * modelo a emitir decenas/cientos de filas en una sola llamada con tool_choice
 * forzado (sin thinking), pierde de vista las REGLAS GLOBALES del documento.
 * Síntomas reales observados:
 *   - "Las tarifas NO incluyen el 13% IVA" → el modelo copió los precios sin
 *     sumar el impuesto en 127 filas.
 *   - 4 cuentas bancarias (BCR USD/CRC + LAFISE USD/CRC) → solo capturó una.
 *   - Tarifas por persona adicional por paquete/temporada → no generó triples.
 *
 * El brief es una pasada CHICA y FOCALIZADA: en vez de pedir todas las filas,
 * pide solo las reglas globales + un inventario del contrato. Al tener un
 * espacio de salida pequeño y un objetivo acotado, el modelo las captura con
 * mucha mayor fidelidad. Después inyectamos el brief como instrucciones de
 * PRIORIDAD ALTA en la pasada principal (grid fill) para que no se le olviden.
 *
 * NO pedimos precios fila-por-fila acá — eso es trabajo de la pasada principal.
 */
export const REGISTRAR_BRIEF_CONTRATO_TOOL_NAME = "registrar_brief_contrato";

export const REGISTRAR_BRIEF_CONTRATO_TOOL: Tool = {
  name: REGISTRAR_BRIEF_CONTRATO_TOOL_NAME,
  description:
    "Registra el BRIEF del contrato: las reglas globales (impuestos, " +
    "comisiones, comidas, persona adicional, periodos especiales), TODAS las " +
    "cuentas bancarias, y un inventario (categorías, temporadas, secciones, " +
    "estimado de filas). NO incluye las filas de tarifas — eso es de otra " +
    "pasada. Sé exhaustivo: estos son los datos que más se pierden cuando se " +
    "extrae todo de una sola vez.",
  input_schema: {
    type: "object",
    properties: {
      prices_include_tax: {
        type: ["boolean", "null"],
        description:
          "¿Los precios listados en el documento YA incluyen el impuesto de " +
          "ventas (IVA)? true = los precios ya traen IVA; false = hay que " +
          "sumarlo (típico: 'las tarifas NO incluyen el 13% de IVA'); null = " +
          "el contrato no lo aclara. Buscá frases como 'IVA incluido', 'más " +
          "impuestos', 'NO incluye el 13%', '+ imp', 'tax not included'.",
      },
      tax_rate_pct: {
        type: ["number", "null"],
        description:
          "Tasa del impuesto de ventas / IVA en porcentaje (ej. 13 para Costa " +
          "Rica). null si no se menciona. OJO: NO confundir con el cargo por " +
          "servicio de A&B (ej. 10%) ni con el Sustainability Fee — esos van " +
          "en tax_note, no acá.",
      },
      tax_note: {
        type: ["string", "null"],
        description:
          "Cita textual (o resumen fiel) de la regla de impuestos del " +
          "contrato, incluyendo cargos por servicio y fees que NO son IVA. " +
          "Ej: 'Las tarifas NO incluyen el 13% de impuesto de ventas. SÍ " +
          "incluyen el 10% de servicio de A&B. Sustainability Fee $35 por " +
          "persona/noche NO incluido.'",
      },
      commission_summary: {
        type: ["string", "null"],
        description:
          "Resumen de las comisiones por sección, si varían. Ej: '30% en " +
          "paquetes de hospedaje, 10% en experiencias y transfers, 0% en " +
          "amenidades'. null si el contrato usa una sola comisión global.",
      },
      meal_plan_note: {
        type: ["string", "null"],
        description:
          "Qué comidas incluyen los productos de hospedaje, traducido a la " +
          "convención del sistema (BREAKFAST, LUNCH, DINNER o combinaciones; " +
          "NONE si no incluye). Ej: 'Paquetes = pensión completa → BREAKFAST, " +
          "LUNCH, DINNER'. null si no aplica.",
      },
      bank_accounts: {
        type: "array",
        description:
          "TODAS las cuentas bancarias del contrato. Es MUY común que haya " +
          "varias (USD y CRC, banco principal y secundario, por montos). " +
          "Capturá cada una por separado — no resumas.",
        items: {
          type: "object",
          properties: {
            bank: { type: ["string", "null"] },
            account_number: {
              type: ["string", "null"],
              description: "IBAN o número de cuenta tal cual aparece.",
            },
            currency: {
              type: ["string", "null"],
              description: "Moneda de la cuenta: USD, CRC, EUR, etc.",
            },
            swift: { type: ["string", "null"] },
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
      additional_person: {
        type: "array",
        description:
          "TODAS las tarifas por persona adicional (3era/4ta persona) que " +
          "defina el contrato. Suelen variar por paquete y por temporada, y a " +
          "veces aplican solo a algunas habitaciones. Cada entrada habilita " +
          "la generación de filas de ocupación triple/cuádruple en la pasada " +
          "principal. Si el contrato no menciona persona adicional, dejá el " +
          "array vacío.",
        items: {
          type: "object",
          properties: {
            scope: {
              type: ["string", "null"],
              description:
                "A qué producto/paquete y temporada aplica esta tarifa. Ej: " +
                "'Paquete Verde 2N/3D — Temporada Media/Baja' o 'Noche " +
                "Adicional — Pico'.",
            },
            applies_to: {
              type: ["string", "null"],
              description:
                "A qué habitaciones aplica. Ej: 'solo Corcovado y Agujas', " +
                "'todas las habitaciones'.",
            },
            rack: {
              type: ["string", "null"],
              description: "Tarifa RACK por persona adicional, tal cual aparece.",
            },
            net: {
              type: ["string", "null"],
              description: "Tarifa NETA por persona adicional, tal cual aparece.",
            },
          },
          required: ["scope", "rack", "net"],
          additionalProperties: false,
        },
      },
      special_periods_note: {
        type: ["string", "null"],
        description:
          "Políticas de PERIODOS ESPECIALES (Navidad, fin de año, Semana " +
          "Santa, peak) que cambian prepago o cancelación para fechas " +
          "puntuales. Resumen fiel con fechas y plazos. null si no hay. Esto " +
          "alimenta la columna 'OTHERS IN PAYMENT OR CANCELLATION'.",
      },
      product_categories: {
        type: "array",
        items: { type: "string" },
        description:
          "Inventario de categorías de producto / tipos de habitación / " +
          "nombres de servicio que aparecen en el contrato. Ej: ['Corcovado " +
          "Garden Villas', 'Agujas Garden Villas', 'Treehouse Ocean View', " +
          "'5 Elements Ocean View'].",
      },
      seasons: {
        type: "array",
        items: { type: "string" },
        description:
          "Inventario de temporadas que aparecen en el contrato. Ej: " +
          "['Pico', 'Alta', 'Media Baja', 'Baja'].",
      },
      sections: {
        type: "array",
        items: { type: "string" },
        description:
          "Secciones de tarifas del contrato — cada una genera filas y suele " +
          "olvidarse alguna. Ej: ['Paquetes de hospedaje', 'Noche adicional', " +
          "'Experiencias', 'Transfers', 'Spa', 'Amenidades'].",
      },
      expected_row_estimate: {
        type: ["number", "null"],
        description:
          "Tu mejor estimado de CUÁNTAS filas debería producir el contrato " +
          "completo (sumando todas las secciones × categorías × temporadas × " +
          "ocupaciones). Sirve como meta de completitud para la pasada " +
          "principal. Si no podés estimarlo, null.",
      },
      notes: {
        type: ["string", "null"],
        description:
          "Cualquier otra regla global relevante que no encaje arriba " +
          "(tarifa de guía, estadía mínima, niños, recargos, etc.).",
      },
    },
    required: [
      "prices_include_tax",
      "tax_rate_pct",
      "bank_accounts",
      "additional_person",
      "product_categories",
      "seasons",
      "sections",
    ],
    additionalProperties: false,
  },
};
