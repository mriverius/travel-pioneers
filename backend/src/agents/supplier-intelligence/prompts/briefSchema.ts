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
      shared_fields: {
        type: "object",
        description:
          "Datos del proveedor que son IGUALES en todas las filas (no varían " +
          "por habitación ni temporada): identidad, contacto y vigencia del " +
          "contrato. Llená lo que esté en el documento; null lo que no esté.",
        properties: {
          proveedor: {
            type: ["string", "null"],
            description: "Razón social / nombre legal del proveedor.",
          },
          nombre_comercial: {
            type: ["string", "null"],
            description: "Nombre comercial (marca) si difiere de la razón social.",
          },
          cedula: {
            type: ["string", "null"],
            description: "Cédula jurídica / RFC / NIT / tax ID.",
          },
          type_of_business: {
            type: ["string", "null"],
            description: "Tipo de negocio (ej. Hotel, Lodge, Tour Operator).",
          },
          direccion: { type: ["string", "null"] },
          telefono: { type: ["string", "null"] },
          pais: { type: ["string", "null"] },
          state_province: { type: ["string", "null"] },
          reservations_email: {
            type: ["string", "null"],
            description: "Email de reservas.",
          },
          fecha: {
            type: ["string", "null"],
            description: "Fecha del contrato/tarifario en YYYY-MM-DD si aparece.",
          },
          contract_starts: {
            type: ["string", "null"],
            description: "Inicio de vigencia del contrato en YYYY-MM-DD.",
          },
          contract_ends: {
            type: ["string", "null"],
            description: "Fin de vigencia del contrato en YYYY-MM-DD.",
          },
        },
        required: [
          "proveedor",
          "nombre_comercial",
          "cedula",
          "contract_starts",
          "contract_ends",
        ],
        additionalProperties: false,
      },
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
      commission_default_pct: {
        type: ["number", "null"],
        description:
          "Comisión POR DEFECTO del contrato en porcentaje, como número (ej. " +
          "20, 25, 30). Es la que aplica a la mayoría de las filas. Buscá " +
          "frases como 'Comisión 20%', 'Net rates 25%', 'comisionable al 30%'. " +
          "Si una tarifa es NETA (ya descontada), la comisión es la diferencia " +
          "implícita rack→net. null si el contrato no define una comisión.",
      },
      commission_summary: {
        type: ["string", "null"],
        description:
          "Resumen de las comisiones por sección CUANDO varían respecto a la " +
          "comisión por defecto. Ej: '30% en paquetes de hospedaje, 10% en " +
          "experiencias y transfers, 0% en amenidades'. null si el contrato " +
          "usa una sola comisión global (la de commission_default_pct).",
      },
      currency: {
        type: ["string", "null"],
        description:
          "Moneda principal en la que están expresadas las tarifas: 'USD', " +
          "'CRC' (colones), 'EUR', etc. Si el contrato mezcla monedas, indicá " +
          "la de las tarifas (no la de las cuentas bancarias).",
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
          "Inventario de NOMBRES de temporadas que aparecen en el contrato. " +
          "Ej: ['Pico', 'Alta', 'Media Baja', 'Baja']. (Las fechas van en " +
          "seasons_detail.)",
      },
      seasons_detail: {
        type: "array",
        description:
          "OBLIGATORIO: una entrada por CADA temporada del contrato, con sus " +
          "fechas. Debe contener EXACTAMENTE las mismas temporadas que el " +
          "array `seasons` (no dejes este vacío si `seasons` tiene nombres). " +
          "MUY IMPORTANTE — detección de temporadas: dos tablas de tarifas " +
          "puestas LADO A LADO, cada una con su propio rango de fechas y su " +
          "nombre (ej. 'Temporada Alta: 01 Nov 2025 - 30 Abr 2026' a la " +
          "izquierda y 'Temporada Baja: 1 May - 31 Oct 2026' a la derecha) " +
          "son DOS temporadas distintas — capturá las dos. No las colapses en " +
          "una sola. CRÍTICO con rangos partidos (ej. 'Wildlife: May 1-Jun 19 " +
          "y Aug 21-Oct 31'): poné el PRIMER tramo en starts/ends y el texto " +
          "completo en raw_range. Normalizá a YYYY-MM-DD inferiendo el año.",
        items: {
          type: "object",
          properties: {
            name: {
              type: ["string", "null"],
              description: "Nombre de la temporada (ej. 'High Season').",
            },
            starts: {
              type: ["string", "null"],
              description: "Inicio en YYYY-MM-DD (primer tramo si hay varios).",
            },
            ends: {
              type: ["string", "null"],
              description: "Fin en YYYY-MM-DD (primer tramo si hay varios).",
            },
            raw_range: {
              type: ["string", "null"],
              description:
                "Rango(s) tal cual aparecen, útil para temporadas partidas. " +
                "Ej: '1 May - 19 Jun · 21 Ago - 31 Oct'.",
            },
          },
          required: ["name", "starts", "ends"],
          additionalProperties: false,
        },
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
      tipo_unidad: {
        type: ["string", "null"],
        description:
          "N = tarifa POR NOCHE (hotel estándar). S = tarifa POR SERVICIO/PAQUETE " +
          "(Full Experience, all-inclusive, paquete 2N/3D — el precio es el total " +
          "del paquete, no una noche). null si no está claro.",
      },
      occupancy_codes: {
        type: "array",
        items: { type: "string" },
        description:
          "Unión de TODOS los códigos de ocupación que aparecen en el contrato " +
          "(referencia global). Ej: [\"SGL\",\"DBL\",\"TPL\",\"QDP\",\"QTN\",\"CHL\"]. " +
          "NO uses esta lista plana para todos los productos — completá " +
          "`occupancies_by_product` con las columnas reales de cada habitación.",
      },
      occupancies_by_product: {
        type: "array",
        items: {
          type: "object",
          properties: {
            product: {
              type: "string",
              description:
                "Nombre de la categoría/habitación (ej. \"Garden Suite\", \"Jaguar Villa\").",
            },
            occupancy_codes: {
              type: "array",
              items: { type: "string" },
              description:
                "Códigos Utopía que ESA habitación publica en el PDF. " +
                "Suites: SGL+DBL+TPL+CHL. Villas medianas: +QDP. Jaguar/large: +QTN.",
            },
          },
          required: ["product", "occupancy_codes"],
          additionalProperties: false,
        },
        description:
          "OBLIGATORIO cuando distintas habitaciones tienen columnas distintas " +
          "(ej. Pacuare: suites sin cuádruple, villas con cuádruple, Jaguar con quíntuple). " +
          "Una entrada por categoría detectada.",
      },
      max_adults_per_room: {
        type: ["number", "null"],
        description:
          "Máximo de adultos por habitación si el contrato lo limita (ej. 2). " +
          "Si es 2 o 3, NO generes cuádruple (QDP) en ninguna categoría.",
      },
      quadruple_allowed: {
        type: ["boolean", "null"],
        description:
          "false si el contrato prohíbe cuádruple en TODAS las habitaciones " +
          '(ej. "No se admiten 4 adultos en ninguna categoría"). true/null si aplica.',
      },
      logic_summary: {
        type: ["string", "null"],
        description:
          "OBLIGATORIO: resumen en ESPAÑOL con formato Markdown ESTANDARIZADO " +
          "de 10 secciones FIJAS, SIEMPRE en este orden y con estos títulos " +
          "exactos en negrita SIN EMOJIS (no los cambies ni los reordenes):\n" +
          "**Proveedor**\n**Tarifas y moneda**\n**Comisión**\n" +
          "**Temporadas**\n**Habitaciones / Servicios**\n" +
          "**Plan de filas estimado**\n**Servicios incluidos**\n" +
          "**Políticas de pago y cancelación**\n**Cuentas bancarias**\n" +
          "**Notas críticas**\n" +
          "En 'Habitaciones / Servicios' incluí SIEMPRE si hay tarifa de niño " +
          "(CHL): 'Tarifa de niño detectada: … Se generarán filas CHL.' o " +
          "'No se detectó tarifa de niño en el contrato.'\n" +
          "Bajo cada título, prosa fluida en segunda persona ('Estás " +
          "cargando…', 'El documento indica…'). Si una sección no aplica, " +
          "inclúyela igual con 'No se detectaron' o 'No aplica' — NUNCA omitas " +
          "una sección. En '📐 Plan de filas estimado' escribí la fórmula " +
          "X categorías × Y ocupaciones × Z temporadas = N filas.",
      },
      row_plan: {
        type: ["object", "null"],
        description:
          "Plan de filas estimado: categorías × ocupaciones × temporadas.",
        properties: {
          categories: {
            type: "array",
            items: { type: "string" },
            description: "Categorías / tipos de habitación detectados.",
          },
          occupancies_per_category: {
            type: ["number", "null"],
            description:
              "Cuántas ocupaciones distintas por categoría (ej. 4 = SGL+DBL+TPL+CHL " +
              "cuando la tabla tiene columnas Single/Double/Triple/Children). " +
              "Contá TPL/QDP/QTN como ocupaciones separadas si el PDF las lista " +
              "con precio propio. null si no está claro.",
          },
          seasons_count: {
            type: ["number", "null"],
            description: "Cantidad de temporadas distintas.",
          },
          expected_rows: {
            type: ["number", "null"],
            description:
              "Total estimado de filas base = categorías × ocupaciones × " +
              "temporadas (sin contar persona adicional). Debe coincidir con " +
              "expected_row_estimate.",
          },
        },
        required: ["categories"],
        additionalProperties: false,
      },
    },
    required: [
      "shared_fields",
      "prices_include_tax",
      "tax_rate_pct",
      "bank_accounts",
      "additional_person",
      "product_categories",
      "seasons",
      "seasons_detail",
      "sections",
      "logic_summary",
    ],
    additionalProperties: false,
  },
};
