import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";

/**
 * JSON Schema for the single tool this agent forces Claude to call. Using
 * `tool_choice: { type: "tool", name: "extraer_datos_contrato" }` is what
 * guarantees we get structured JSON back instead of free-form text.
 *
 * Field descriptions double as in-context hints for the model — keep them
 * aligned with the system prompt (especially the proveedor vs nombre_comercial
 * distinction and the IBAN preference on numero_cuenta).
 */
export const EXTRAER_DATOS_CONTRATO_TOOL_NAME = "extraer_datos_contrato" as const;

export const EXTRAER_DATOS_CONTRATO_TOOL: Tool = {
  name: EXTRAER_DATOS_CONTRATO_TOOL_NAME,
  description:
    "Extrae los 9 campos identificativos y bancarios de un contrato comercial.",
  input_schema: {
    type: "object",
    properties: {
      fecha: {
        type: ["string", "null"],
        description:
          "Fecha de firma en formato YYYY-MM-DD. Si hay varias firmas, la más reciente.",
      },
      proveedor: {
        type: ["string", "null"],
        description: "Razón social / nombre legal del proveedor.",
      },
      nombre_comercial: {
        type: ["string", "null"],
        description: "Nombre comercial / marca del proveedor.",
      },
      cedula: {
        type: ["string", "null"],
        description: "Cédula jurídica / RFC / NIT, formato original.",
      },
      direccion: {
        type: ["string", "null"],
        description:
          "Dirección física completa, compuesta si está fragmentada.",
      },
      telefono: {
        type: ["string", "null"],
        description: "Teléfono con código de país cuando sea posible.",
      },
      tipo_moneda: {
        type: ["string", "null"],
        description: "Código ISO 4217 (USD, CRC, MXN, EUR, etc.).",
      },
      numero_cuenta: {
        type: ["string", "null"],
        description: "Cuenta bancaria. Preferir IBAN si existe.",
      },
      banco: {
        type: ["string", "null"],
        description: "Nombre del banco.",
      },
      confianza: {
        type: "string",
        enum: ["alta", "media", "baja"],
        description: "Confianza global de la extracción.",
      },
      campos_faltantes: {
        type: "array",
        items: { type: "string" },
        description: "Campos que no se pudieron encontrar.",
      },
      paginas_origen: {
        type: "object",
        description:
          "Mapa de campo -> número de página o 'inferido'/'multiple'.",
      },
    },
    required: [
      "fecha",
      "proveedor",
      "nombre_comercial",
      "cedula",
      "direccion",
      "telefono",
      "tipo_moneda",
      "numero_cuenta",
      "banco",
      "confianza",
      "campos_faltantes",
      "paginas_origen",
    ],
  },
};
