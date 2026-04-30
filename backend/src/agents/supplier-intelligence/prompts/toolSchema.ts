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
 * Field descriptions double as in-context hints for the model — keep them
 * aligned with the system prompt (especially the proveedor vs nombre_comercial
 * distinction and the IBAN preference on numero_cuenta).
 *
 * Los 3 campos del maestro Utopía (tipo_unidad, tipo_servicio, categoria) son
 * de **clasificación**: sus enums se generan desde el xlsx
 * (`generated/serviceTypesData.ts`), no se hardcodean acá. Para `categoria`
 * no podemos restringir con enum porque el conjunto válido depende del
 * tipo_servicio elegido — lo validamos post-hoc en `validators.ts`.
 */
export const EXTRAER_DATOS_CONTRATO_TOOL_NAME = "extraer_datos_contrato" as const;

export const EXTRAER_DATOS_CONTRATO_TOOL: Tool = {
  name: EXTRAER_DATOS_CONTRATO_TOOL_NAME,
  description:
    "Extrae datos del contrato comercial siguiendo el formato del maestro " +
    "Utopía. Cubre identidad, contacto, vigencia, servicio principal, " +
    "temporada, tarifas, políticas y datos bancarios. Para campos que no " +
    "aparecen en el contrato, devolver null y agregarlos a campos_faltantes.",
  input_schema: {
    type: "object",
    properties: {
      // --- Identidad / contacto / legal ---
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
          "como 'inferido' en paginas_origen cuando se infiera.",
      },
      state_province: {
        type: ["string", "null"],
        description:
          "Provincia/estado. INFERIBLE desde geografía conocida: Quepos / " +
          "Manuel Antonio / Jacó → 'Puntarenas'. La Fortuna / Arenal → " +
          "'Alajuela'. Monteverde → 'Puntarenas'. Tamarindo / Liberia → " +
          "'Guanacaste'. San José ciudad → 'San José'. Marcar 'inferido' " +
          "en paginas_origen.",
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

      // --- Servicio (1 representativo si el contrato cubre múltiples) ---
      product_name: {
        type: ["string", "null"],
        description:
          "Nombre del producto/servicio principal o más representativo. Si " +
          "el contrato lista varios (ej: 7 categorías de habitación), elegir " +
          "la más estándar / la primera en orden de presentación. Ejemplos: " +
          "'COTINGA', 'Garden', 'Standard Double'.",
      },
      ocupacion: {
        type: ["string", "null"],
        description:
          "Código corto de ocupación. Convención del maestro: 'DBL' = " +
          "doble, 'SGL' = single, 'TPL' = triple, 'CPL' = cuádruple, 'FAM' " +
          "= familiar. Si el contrato dice 'sencilla o doble', devolver 'DBL'.",
      },

      // --- Clasificación catálogo Utopía ---
      tipo_unidad: {
        type: ["string", "null"],
        enum: [...TIPO_UNIDAD_CODES, null],
        description:
          "Tipo de unidad (columna P). 'N' si la tarifa contractual es POR " +
          "NOCHE — típico en hoteles, lodges, B&B. 'S' si es POR SERVICIO " +
          "— tours, canopy, transfers, comidas. null si no se puede inferir.",
      },
      tipo_servicio: {
        type: ["string", "null"],
        enum: [...TIPO_SERVICIO_CODES, null],
        description:
          "Código de Tipo de Servicio (columna Q). Debe ser uno de los " +
          "códigos listados en el system prompt — los más comunes son HO " +
          "(HOTEL), TO (TOURS), TR (TRANSFER), RE (RENT A CAR), AL (MEAL).",
      },
      categoria: {
        type: ["string", "null"],
        description:
          "Código de Categoría (columna R). Debe pertenecer al tipo_servicio " +
          "elegido. Para hospedajes: STD, OCV (Ocean View), DLX, SUI, etc. " +
          "Para tipos sin categoría específica usar 'UNI'. null si tipo_servicio " +
          "es null.",
      },

      // --- Temporada ---
      season_name: {
        type: ["string", "null"],
        description:
          "Nombre de la temporada principal. Si el contrato distingue " +
          "varias (Peak / Alta / Baja), elegir la temporada principal o la " +
          "más larga en duración. Ejemplos: 'GREEN SEASON', 'ALTA', " +
          "'TEMPORADA BAJA'. Mantener el nombre como aparece en el documento.",
      },
      season_starts: {
        type: ["string", "null"],
        description: "Fecha de inicio de la temporada elegida (YYYY-MM-DD).",
      },
      season_ends: {
        type: ["string", "null"],
        description: "Fecha de fin de la temporada elegida (YYYY-MM-DD).",
      },
      meals_included: {
        type: ["string", "null"],
        description:
          "Comidas incluidas en la tarifa. Convención del maestro (en " +
          "MAYÚSCULAS): 'BREAKFAST', 'MAP' (modified american plan), 'AP' " +
          "(american plan), 'ALL INCLUSIVE', 'NONE'. Si el contrato dice " +
          "'tarifas incluyen desayuno' → 'BREAKFAST'.",
      },

      // --- Tarifas estándar ---
      precios_neto_iva: {
        type: ["string", "null"],
        description:
          "Precio neto con IVA incluido. Número en formato del documento. " +
          "Si el contrato lista tarifas por habitación × temporada, elegir " +
          "la del producto y temporada principales (consistente con " +
          "product_name + season_name). Ejemplo del maestro: '276.75'.",
      },
      precio_rack_iva: {
        type: ["string", "null"],
        description:
          "Precio rack/público con IVA incluido. Misma habitación/temporada " +
          "que precios_neto_iva. Ejemplo del maestro: '369'.",
      },
      porcentaje_comision: {
        type: ["string", "null"],
        description:
          "Porcentaje de comisión. Mantener formato del documento (puede " +
          "venir como '25', '25%', '0.25'). Si el contrato dice 'NETAS, NO " +
          "COMISIONABLES' o 'sin comisión', devolver '0'.",
      },

      // --- Tarifas fin de semana ---
      precios_neto_iva_fds: {
        type: ["string", "null"],
        description:
          "Precio neto con IVA — fin de semana. Si el contrato NO distingue " +
          "tarifas weekday/weekend, copiar el mismo valor que precios_neto_iva " +
          "(convención del maestro Utopía). Solo dejar null si claramente " +
          "no aplica.",
      },
      precio_rack_iva_fds: {
        type: ["string", "null"],
        description:
          "Precio rack con IVA — fin de semana. Mismo criterio: si no hay " +
          "distinción, copiar precio_rack_iva.",
      },
      porcentaje_comision_fds: {
        type: ["string", "null"],
        description:
          "Porcentaje de comisión — fin de semana. Mismo criterio que el " +
          "weekday: copiar porcentaje_comision si no hay distinción.",
      },

      // --- Políticas (texto libre) ---
      cancellation_policy: {
        type: ["string", "null"],
        description:
          "Política de cancelación, resumida a 1-2 oraciones clave. Si hay " +
          "varias por temporada, elegir la principal. Ejemplo del maestro: " +
          "'Full penalty for cancellations 15 days or less before arrival'.",
      },
      range_payment_policy: {
        type: ["string", "null"],
        description:
          "Política de pago — plazo y método. Resumir a 1 oración. Ejemplo: " +
          "'Payment due 15 days before arrival'.",
      },
      kids_policy: {
        type: ["string", "null"],
        description:
          "Política de niños tal como aparece en el contrato. Ejemplo: " +
          "'KIDS FROM 0 TO 11 YEARS OLD ARE FREE WHEN THERE ARE 2 ADULTS IN " +
          "THE ROOM. Maximum 2 kids per room.'",
      },
      other_included: {
        type: ["string", "null"],
        description:
          "Otros servicios/amenidades incluidos en la tarifa que no sean " +
          "comidas (eso va en meals_included). Ejemplo: 'use of self-guided " +
          "trails and pool'.",
      },
      feeds_adicionales: {
        type: ["string", "null"],
        description:
          "Cargos adicionales no incluidos en la tarifa base (resort fee, " +
          "conservation fee, IVA externo, etc.). Ejemplo: '$10 per person " +
          "per stay Conservation Fee', '$15 resort fee per room per night'.",
      },

      // --- Datos bancarios ---
      tipo_moneda: {
        type: ["string", "null"],
        description:
          "Código ISO 4217 de la moneda principal de las tarifas (USD, " +
          "CRC, MXN, EUR). Si el contrato usa '$' y el contexto es " +
          "Costa Rica para tarifas turísticas, normalmente es 'USD'. Marcar " +
          "'inferido' en paginas_origen cuando no esté explícita.",
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

      // --- Metadatos ---
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
          "se pudieron inferir. Estos serán mostrados al usuario como 'No " +
          "encontrado en el documento' para que llene manual.",
      },
      paginas_origen: {
        type: "object",
        description:
          "Mapa de nombre_de_campo -> número de página (o 'inferido' / " +
          "'multiple'). Anotar 'inferido' en pais, state_province, " +
          "type_of_business, tipo_moneda cuando se hayan inferido del " +
          "contexto en lugar de extraerse literalmente.",
      },
    },
    required: [
      // identidad
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
      // servicio
      "product_name",
      "ocupacion",
      // clasificación
      "tipo_unidad",
      "tipo_servicio",
      "categoria",
      // temporada
      "season_name",
      "season_starts",
      "season_ends",
      "meals_included",
      // tarifas
      "precios_neto_iva",
      "precio_rack_iva",
      "porcentaje_comision",
      "precios_neto_iva_fds",
      "precio_rack_iva_fds",
      "porcentaje_comision_fds",
      // políticas
      "cancellation_policy",
      "range_payment_policy",
      "kids_policy",
      "other_included",
      "feeds_adicionales",
      // bancarios
      "tipo_moneda",
      "numero_cuenta",
      "banco",
      // metadatos
      "confianza",
      "campos_faltantes",
      "paginas_origen",
    ],
  },
};
