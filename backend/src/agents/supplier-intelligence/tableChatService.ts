import { APIError } from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  Tool,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages.js";
import ApiError from "../../utils/ApiError.js";
import logger from "../../config/logger.js";
import { getAnthropicClient } from "./anthropicClient.js";
import { documentBlocks } from "./chatAttachments.js";
import type { PreparedDocumentInput } from "./service.js";
import {
  CATALOG_PREFILL_COL,
  MANUAL_COL,
  ROW_CLASSIFICATION_COL,
  ROW_COL,
  SHARED_COL,
} from "./xlsxColumnMap.js";
import type {
  ContractRow,
  ManualFields,
  RowFieldKey,
  SharedFields,
} from "./types.js";

/**
 * Chat de correcciones "en caliente" del Paso 3 (Revisar información).
 *
 * El operador ya tiene la tabla completa en pantalla y quiere corregirla en
 * lenguaje natural ANTES de descargar el xlsx: "revisá los precios, no
 * agregaste el IVA", "la comisión de temporada alta es 20%", "borrá las filas
 * de la temporada PEAK". En vez de re-extraer el contrato entero (varios
 * minutos y varios dólares), le pasamos a Claude SOLO el JSON de la tabla
 * actual y le pedimos un conjunto de OPERACIONES a aplicar.
 *
 * Por qué operaciones y no "devolveme la tabla corregida":
 *   1. Costo/latencia — regenerar 100 filas × 20 campos son decenas de miles
 *      de tokens de salida por mensaje del chat. Las operaciones son ~50x más
 *      chicas.
 *   2. Integridad — el modelo no puede "perder" filas o campos que no tocó;
 *      todo lo que no menciona queda literalmente intacto.
 *   3. Aritmética exacta — `scale_rows` (ej. multiplicar por 1.13 para agregar
 *      IVA) la calcula el SERVIDOR, no el modelo. 100 multiplicaciones hechas
 *      a mano por un LLM es una fuente garantizada de errores de redondeo.
 *
 * Las operaciones se aplican acá (server-side) y devolvemos la tabla ya
 * corregida + un `row_index_map` para que el frontend re-alinee los metadatos
 * paralelos (páginas de origen) cuando se agregan o borran filas.
 */

/**
 * Modelo del chat de tabla. Sonnet 5.5: son correcciones acotadas sobre un
 * JSON que ya existe, con instrucción humana explícita, y el resultado pasa
 * por el QA determinístico del Paso 3 (aritmética neto/rack/comisión,
 * cobertura de precios) antes de llegar al xlsx. El payload incluye la
 * grilla completa, así que aquí el modelo barato sí mueve la factura. Si en
 * «Calidad del agente» las correcciones por chat empeoran, volver a Opus es
 * cambiar esta constante.
 */
export const SUPPLIER_TABLE_CHAT_MODEL = "claude-sonnet-5-5";

/** USD por millón de tokens para el modelo del chat (oct 2026). */
const TABLE_CHAT_PRICES = { input: 2, output: 10 };

/**
 * Cap de tokens de salida. Las operaciones son compactas, pero un
 * `set_cells` que toca 300 celdas necesita aire. 16k es holgado.
 */
const MAX_TOKENS = 32_000;

/** Caps defensivos — protegen costo y evitan payloads basura. */
const MAX_ROWS = 500;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_OPERATIONS = 200;
const MAX_CELLS_PER_OP = 5_000;
/** Largo máximo por celda al renderizar el snapshot para el modelo. */
const SNAPSHOT_CELL_CHARS = 220;

const TOOL_NAME = "corregir_tabla_contrato";

/* -------------------------------------------------------------------------- */
/*                        Llaves editables + metadatos                        */
/* -------------------------------------------------------------------------- */

/**
 * Campos compartidos (mismo valor en TODAS las filas del xlsx) que el chat
 * puede modificar. Se agrupan los tres orígenes que la UI del Paso 3 muestra
 * mezclados en la misma fila de la tabla:
 *   - ai      → extraídos del contrato (`shared_fields`)
 *   - catalog → del maestro lista-proveedores (`catalog_prefill`)
 *   - manual  → los llena el operador (`manual_fields`)
 *
 * `codigo_servicio` NO está acá: aunque el catálogo lo trae como hint, el
 * valor que termina en el xlsx vive por fila (`rows[i].codigo_servicio`).
 */
type SharedOrigin = "ai" | "catalog" | "manual";

interface SharedKeyMeta {
  origin: SharedOrigin;
  col: string;
  label: string;
}

const SHARED_KEYS: Record<string, SharedKeyMeta> = {
  // catálogo
  tipo_actividad: { origin: "catalog", col: CATALOG_PREFILL_COL.tipo_actividad, label: "Tipo Actividad" },
  zona_turismo: { origin: "catalog", col: CATALOG_PREFILL_COL.zona_turismo, label: "Zona Turismo" },
  proveedor_codigo: { origin: "catalog", col: CATALOG_PREFILL_COL.proveedor_codigo, label: "Proveedor (código)" },
  // extraídos por IA
  proveedor: { origin: "ai", col: SHARED_COL.proveedor ?? "D", label: "Razón Social" },
  cedula: { origin: "ai", col: SHARED_COL.cedula ?? "E", label: "Cédula Jurídica" },
  fecha: { origin: "ai", col: SHARED_COL.fecha ?? "F", label: "Contract Date (YYYY-MM-DD)" },
  nombre_comercial: { origin: "ai", col: SHARED_COL.nombre_comercial ?? "G", label: "Nombre Comercial" },
  pais: { origin: "ai", col: SHARED_COL.pais ?? "H", label: "País" },
  state_province: { origin: "ai", col: SHARED_COL.state_province ?? "I", label: "State / Province" },
  direccion: { origin: "ai", col: SHARED_COL.direccion ?? "J", label: "Location" },
  type_of_business: { origin: "ai", col: SHARED_COL.type_of_business ?? "K", label: "Type of Business" },
  contract_starts: { origin: "ai", col: SHARED_COL.contract_starts ?? "L", label: "Contract Starts (YYYY-MM-DD)" },
  contract_ends: { origin: "ai", col: SHARED_COL.contract_ends ?? "M", label: "Contract Ends (YYYY-MM-DD)" },
  others_payment_cancel: { origin: "ai", col: SHARED_COL.others_payment_cancel ?? "AK", label: "Others in Payment / Cancel" },
  reservations_email: { origin: "ai", col: SHARED_COL.reservations_email ?? "AO", label: "Reservations Email" },
  numero_cuenta: { origin: "ai", col: SHARED_COL.numero_cuenta ?? "AR", label: "Cuenta Bancaria 1" },
  banco: { origin: "ai", col: SHARED_COL.banco ?? "AS", label: "Banco 1" },
  tipo_moneda: { origin: "ai", col: SHARED_COL.tipo_moneda ?? "AT", label: "Moneda 1 (código, ej. USD)" },
  notes: { origin: "ai", col: SHARED_COL.notes ?? "BA", label: "Notas" },
  // teléfono: se extrae para validación humana pero no tiene columna xlsx
  telefono: { origin: "ai", col: "—", label: "Teléfono (sin columna en el xlsx)" },
  // manuales
  tipo_tarifa_neta: { origin: "manual", col: MANUAL_COL.tipo_tarifa_neta, label: "Tipo Tarifa Neta (1=Fija, 2=Porcentual)" },
  tipo_tarifa_mayorista: { origin: "manual", col: MANUAL_COL.tipo_tarifa_mayorista, label: "Tipo Tarifa Mayorista (1|2)" },
  tipo_tarifa_fds: { origin: "manual", col: MANUAL_COL.tipo_tarifa_fds, label: "Tipo Tarifa Fin de Semana (1|2)" },
  t_tar_neta_fds: { origin: "manual", col: MANUAL_COL.t_tar_neta_fds, label: "T.Tar Neta Fin de Semana (1|2)" },
  tipo_tarifa_mayorista_fds: { origin: "manual", col: MANUAL_COL.tipo_tarifa_mayorista_fds, label: "Tipo Tarifa Mayorista FdS (1|2)" },
  cond_credito: { origin: "manual", col: MANUAL_COL.cond_credito, label: "Condiciones Crédito (1=Contado, 2=Crédito, 3=Prepago)" },
  plazo: { origin: "manual", col: MANUAL_COL.plazo, label: "Plazo" },
  cuenta_bancaria_2: { origin: "manual", col: MANUAL_COL.cuenta_bancaria_2, label: "Cuenta Bancaria 2" },
  banco_2: { origin: "manual", col: MANUAL_COL.banco_2, label: "Banco 2" },
  moneda_2: { origin: "manual", col: MANUAL_COL.moneda_2, label: "Moneda 2" },
  cuenta_bancaria_3: { origin: "manual", col: MANUAL_COL.cuenta_bancaria_3, label: "Cuenta Bancaria 3" },
  banco_3: { origin: "manual", col: MANUAL_COL.banco_3, label: "Banco 3" },
  moneda_3: { origin: "manual", col: MANUAL_COL.moneda_3, label: "Moneda 3" },
};

interface RowKeyMeta {
  col: string;
  label: string;
  /** True cuando la columna guarda un monto/porcentaje escalable. */
  numeric?: true;
}

/**
 * Campos por fila que el chat puede modificar. Coincide 1:1 con las columnas
 * "row" que la UI del Paso 3 renderiza (`ALL_COLUMNS` en workflow.tsx).
 * `tarifa_persona_adicional` queda FUERA a propósito: es un campo auxiliar
 * que el servidor consume durante la extracción y que ya está materializado
 * en filas TPL/QDP cuando llegamos al Paso 3.
 */
const ROW_KEYS: Record<string, RowKeyMeta> = {
  codigo_servicio: { col: ROW_CLASSIFICATION_COL.codigo_servicio, label: "Cod. Servicio" },
  product_name: { col: ROW_COL.product_name ?? "O", label: "Product Name" },
  tipo_unidad: { col: ROW_CLASSIFICATION_COL.tipo_unidad, label: "Tipo Unidad (N=por noche, S=por servicio)" },
  tipo_servicio: { col: ROW_CLASSIFICATION_COL.tipo_servicio, label: "Tipo Servicio (código de catálogo, ej. HO, TO)" },
  categoria: { col: ROW_COL.categoria ?? "R", label: "Categoría (código de catálogo)" },
  ocupacion: { col: ROW_COL.ocupacion ?? "S", label: "Ocupación (SGL, DBL, TPL, QDP…)" },
  season_name: { col: ROW_COL.season_name ?? "T", label: "Season Name" },
  season_starts: { col: ROW_COL.season_starts ?? "U", label: "Season Starts (YYYY-MM-DD)" },
  season_ends: { col: ROW_COL.season_ends ?? "V", label: "Season Ends (YYYY-MM-DD)" },
  meals_included: { col: ROW_COL.meals_included ?? "W", label: "Meals Included" },
  precios_neto_iva: { col: ROW_COL.precios_neto_iva ?? "Y", label: "Precio NETO con IVA", numeric: true },
  precio_rack_iva: { col: ROW_COL.precio_rack_iva ?? "Z", label: "Precio RACK con IVA", numeric: true },
  porcentaje_comision: { col: ROW_COL.porcentaje_comision ?? "AB", label: "% Comisión", numeric: true },
  precios_neto_iva_fds: { col: ROW_COL.precios_neto_iva_fds ?? "AE", label: "Precio NETO con IVA — fin de semana", numeric: true },
  precio_rack_iva_fds: { col: ROW_COL.precio_rack_iva_fds ?? "AF", label: "Precio RACK con IVA — fin de semana", numeric: true },
  porcentaje_comision_fds: { col: ROW_COL.porcentaje_comision_fds ?? "AH", label: "% Comisión fin de semana", numeric: true },
  cancellation_policy: { col: ROW_COL.cancellation_policy ?? "AI", label: "Cancelation Policy" },
  range_payment_policy: { col: ROW_COL.range_payment_policy ?? "AJ", label: "Range Payment Policy" },
  kids_policy: { col: ROW_COL.kids_policy ?? "AL", label: "Kids Policy" },
  other_included: { col: ROW_COL.other_included ?? "AM", label: "Other Included" },
  feeds_adicionales: { col: ROW_COL.feeds_adicionales ?? "AN", label: "Fees Adicionales" },
};

const SHARED_KEY_LIST = Object.keys(SHARED_KEYS);
const ROW_KEY_LIST = Object.keys(ROW_KEYS);

/* -------------------------------------------------------------------------- */
/*                              Tipos públicos                                */
/* -------------------------------------------------------------------------- */

export interface ContractTable {
  shared_fields: SharedFields;
  rows: ContractRow[];
  catalog_prefill: CatalogPrefillFields | null;
  manual_fields: ManualFields | null;
}

export interface CatalogPrefillFields {
  tipo_actividad: string | null;
  zona_turismo: string | null;
  proveedor_codigo: string | null;
  codigo_servicio: string | null;
}

export interface TableChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TableRefineResult {
  table: ContractTable;
  /**
   * Para cada fila del resultado, el índice (0-based) que tenía en la tabla
   * de entrada — o `null` si la fila es nueva. El frontend lo usa para
   * re-alinear `paginas_origen_rows` sin desfasarse cuando el chat borra o
   * agrega filas.
   */
  rowIndexMap: (number | null)[];
  /** Respuesta en lenguaje natural para mostrar en el chat. */
  reply: string;
  /** Resumen determinista de lo que el servidor efectivamente aplicó. */
  changes: string[];
  model: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

/* -------------------------------------------------------------------------- */
/*                          Snapshot para el modelo                           */
/* -------------------------------------------------------------------------- */

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  // Tabs y saltos de línea romperían el formato TSV del snapshot.
  return truncate(s.replace(/[\t\r\n]+/g, " ").trim(), SNAPSHOT_CELL_CHARS);
}

/** Valor efectivo de un shared key mirando los tres contenedores. */
function readShared(table: ContractTable, key: string): string | null {
  const meta = SHARED_KEYS[key];
  if (!meta) return null;
  if (meta.origin === "catalog") {
    return (table.catalog_prefill?.[key as keyof CatalogPrefillFields] ?? null) as
      | string
      | null;
  }
  if (meta.origin === "manual") {
    return (table.manual_fields?.[key as keyof ManualFields] ?? null) ?? null;
  }
  const v = table.shared_fields[key as keyof SharedFields];
  return typeof v === "string" ? v : v === null || v === undefined ? null : String(v);
}

/**
 * Renderiza la tabla como texto denso: bloque de campos compartidos +
 * TSV de filas con índice 1-based (el mismo número que ve el operador en la
 * columna `#` de la UI, para que "la fila 7" signifique lo mismo de los dos
 * lados).
 */
function buildTableSnapshot(table: ContractTable): string {
  const sharedLines = SHARED_KEY_LIST.map((k) => {
    const meta = SHARED_KEYS[k]!;
    const v = cellText(readShared(table, k));
    return `${k}\t[col ${meta.col}]\t${meta.label}\t${v === "" ? "(vacío)" : v}`;
  });

  const header = ["#", ...ROW_KEY_LIST].join("\t");
  const rowLines = table.rows.map((row, i) => {
    const cells = ROW_KEY_LIST.map((k) =>
      cellText(row[k as keyof ContractRow]),
    );
    return [String(i + 1), ...cells].join("\t");
  });

  return (
    "═══ CAMPOS COMPARTIDOS (mismo valor en todas las filas) ═══\n" +
    "formato: clave\\t[columna xlsx]\\tetiqueta\\tvalor actual\n" +
    sharedLines.join("\n") +
    "\n\n═══ FILAS (" +
    table.rows.length +
    ") ═══\n" +
    "formato TSV; la primera columna `#` es el número de fila 1-based que ve el operador\n" +
    header +
    "\n" +
    rowLines.join("\n")
  );
}

/* -------------------------------------------------------------------------- */
/*                             Tool + system prompt                           */
/* -------------------------------------------------------------------------- */

const VALUE_SCHEMA = {
  type: ["string", "null"],
  description:
    "Valor nuevo como texto plano (o null para vaciar la celda). Los montos van " +
    "SIN símbolo ni código de moneda y con punto decimal: \"333.35\", no \"USD 333,35\". " +
    "Los porcentajes van sin el signo %: \"20\". Las fechas en YYYY-MM-DD.",
} as const;

const CORREGIR_TABLA_TOOL: Tool = {
  name: TOOL_NAME,
  description:
    "Aplica las correcciones del operador sobre la tabla del contrato mediante una " +
    "lista de operaciones. Devuelve SOLO lo que cambia — todo lo que no menciones " +
    "queda intacto.",
  input_schema: {
    type: "object",
    properties: {
      reply: {
        type: "string",
        description:
          "Respuesta al operador en español (2-4 frases). Explicá QUÉ cambiaste y con " +
          "qué criterio (ej. \"Multipliqué los 42 precios neto y rack por 1.13 para " +
          "agregar el IVA del 13%; dejé las comisiones sin tocar\"). Si NO vas a hacer " +
          "ningún cambio, explicá por qué y qué necesitás saber.",
      },
      operations: {
        type: "array",
        description:
          "Operaciones a aplicar, en orden. Array vacío si no hay nada que cambiar.",
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: [
                "set_shared",
                "set_rows",
                "set_cells",
                "scale_rows",
                "delete_rows",
                "add_rows",
                "duplicate_rows",
                "derive_rows",
              ],
              description:
                "set_shared: cambia un campo compartido (se replica en todas las filas). " +
                "set_rows: escribe el MISMO valor en una columna de varias filas. " +
                "set_cells: escribe valores DISTINTOS celda por celda. " +
                "scale_rows: multiplica una columna numérica por un factor (el servidor hace la aritmética). " +
                "derive_rows: calcula una columna numérica a partir de otra (destino = origen × factor). " +
                "delete_rows: elimina filas. " +
                "duplicate_rows: clona filas existentes (copiando TODAS sus columnas) y " +
                "las inserta justo debajo de cada original, con los cambios de `set`, " +
                "`per_source`, `scale` y `derive`. Es la forma correcta de agregar una " +
                "ocupación, temporada o variante nueva que se parece a filas existentes. " +
                "add_rows: agrega filas nuevas desde cero al final (solo si no hay filas " +
                "parecidas que clonar).",
            },
            key: {
              type: "string",
              description:
                "Clave del campo. Para set_shared debe ser una de las claves compartidas; " +
                "para set_rows, scale_rows y derive_rows (destino), una de las claves de fila.",
            },
            value: VALUE_SCHEMA,
            rows: {
              type: ["array", "null"],
              items: { type: "integer" },
              description:
                "Números de fila 1-based del snapshot (columna `#`). Siempre se refieren " +
                "a la numeración ORIGINAL del snapshot, aunque una operación anterior haya " +
                "borrado o insertado filas. Las filas creadas en este mismo turno no tienen " +
                "número: apuntalas con `where`. null o ausente (y sin `where`) = TODAS las filas.",
            },
            where: {
              type: "object",
              description:
                "Filtro de filas por valor EXACTO (sin distinguir mayúsculas ni espacios " +
                "extra). Clave de fila → lista de valores aceptados; AND entre claves, OR " +
                "dentro de la lista. Ej: {\"product_name\": [\"Terraza King\", \"Brisa King\"], " +
                "\"ocupacion\": [\"DBL\"]}. Se combina (intersección) con `rows` si vienen ambos. " +
                "Evaluado sobre el estado de la tabla en ESE momento, así que incluye filas " +
                "creadas por operaciones anteriores del mismo turno.",
              additionalProperties: { type: "array", items: { type: "string" } },
            },
            where_contains: {
              type: "object",
              description:
                "Como `where`, pero el valor de la celda debe CONTENER el texto (sin " +
                "distinguir mayúsculas). Ej: {\"product_name\": [\"Terraza\"]}.",
              additionalProperties: { type: "array", items: { type: "string" } },
            },
            source_key: {
              type: "string",
              description:
                "Solo para derive_rows: clave numérica de origen (ej. precios_neto_iva).",
            },
            set: {
              type: "object",
              description:
                "Solo para duplicate_rows: valores que se escriben en TODAS las copias " +
                "(ej. {\"ocupacion\": \"TPL\"}).",
              additionalProperties: { type: ["string", "null"] },
            },
            per_source: {
              type: "array",
              description:
                "Solo para duplicate_rows: valores específicos para la copia de una fila " +
                "de origen concreta (ej. el precio neto del triple de esa temporada). " +
                "Se aplican después de `set`.",
              items: {
                type: "object",
                properties: {
                  row: {
                    type: "integer",
                    description: "Número de fila 1-based (snapshot original) de la fila de origen.",
                  },
                  set: {
                    type: "object",
                    additionalProperties: { type: ["string", "null"] },
                  },
                },
                required: ["row", "set"],
              },
            },
            scale: {
              type: "object",
              description:
                "Solo para duplicate_rows: clave numérica → factor a multiplicar en las " +
                "copias (después de set/per_source). Ej: {\"precios_neto_iva\": 1.2769}.",
              additionalProperties: { type: "number" },
            },
            derive: {
              type: "array",
              description:
                "Solo para duplicate_rows: columnas calculadas en las copias, en orden, " +
                "después de `scale`. Ej: [{\"key\": \"precio_rack_iva\", \"source_key\": " +
                "\"precios_neto_iva\", \"factor\": 1.25}] para rack = neto / 0.80.",
              items: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  source_key: { type: "string" },
                  factor: { type: "number" },
                },
                required: ["key", "source_key", "factor"],
              },
            },
            cells: {
              type: "array",
              description: "Solo para set_cells: lista de celdas con su valor nuevo.",
              items: {
                type: "object",
                properties: {
                  row: {
                    type: "integer",
                    description: "Número de fila 1-based.",
                  },
                  key: { type: "string", description: "Clave del campo de fila." },
                  value: VALUE_SCHEMA,
                },
                required: ["row", "key", "value"],
              },
            },
            factor: {
              type: "number",
              description:
                "Para scale_rows y derive_rows: multiplicador. Para agregar un IVA del 13% usá " +
                "1.13; para quitarlo, 0.884956 (1/1.13). El servidor redondea a 2 " +
                "decimales y omite las celdas vacías o no numéricas.",
            },
            new_rows: {
              type: "array",
              description:
                "Solo para add_rows: cada objeto es una fila nueva con las claves de fila " +
                "que quieras poblar (las que omitas quedan vacías).",
              items: { type: "object", additionalProperties: { type: ["string", "null"] } },
            },
          },
          required: ["op"],
        },
      },
    },
    required: ["reply", "operations"],
  },
};

function buildSystemPrompt(): string {
  const sharedList = SHARED_KEY_LIST.map(
    (k) => `  - ${k} (col ${SHARED_KEYS[k]!.col}) — ${SHARED_KEYS[k]!.label}`,
  ).join("\n");
  const rowList = ROW_KEY_LIST.map(
    (k) =>
      `  - ${k} (col ${ROW_KEYS[k]!.col}) — ${ROW_KEYS[k]!.label}${ROW_KEYS[k]!.numeric ? " [numérico]" : ""}`,
  ).join("\n");

  return (
    "Sos el asistente de revisión del agente Supplier Intelligence de Utopía. El " +
    "operador está en el Paso 3 (Revisar información): ya tiene en pantalla la tabla " +
    "que se va a convertir en el xlsx maestro de tarifas, y te pide correcciones en " +
    "lenguaje natural antes de descargarla.\n\n" +
    "Tu única salida es una llamada a la herramienta `" +
    TOOL_NAME +
    "` con la lista de operaciones a aplicar. NO devuelvas la tabla completa: solo " +
    "lo que cambia.\n\n" +
    "CAMPOS COMPARTIDOS disponibles (un valor para todo el contrato):\n" +
    sharedList +
    "\n\nCAMPOS POR FILA disponibles:\n" +
    rowList +
    "\n\nREGLAS DURAS:\n" +
    "1. Usá EXACTAMENTE las claves listadas arriba. Una clave inventada se descarta " +
    "   en silencio y la corrección del operador se pierde.\n" +
    "2. Los números de fila son 1-based y se refieren a la columna `#` del snapshot " +
    "   ORIGINAL (no cambian aunque borres o insertes filas en el mismo turno). " +
    "   Nunca inventes números de fila que no existen. Para apuntar a muchas filas " +
    "   por producto/ocupación/temporada preferí `where` en lugar de listar números.\n" +
    "3. Para operaciones aritméticas sobre una columna entera (agregar/quitar IVA, " +
    "   aplicar un descuento, subir un 10%) usá SIEMPRE `scale_rows`. NO calcules los " +
    "   valores a mano con `set_cells`: el servidor hace la multiplicación exacta y " +
    "   evita errores de redondeo.\n" +
    "4. `set_cells` es para valores heterogéneos que NO salen de una fórmula (ej. " +
    "   corregir tres precios sueltos que el operador dicta uno por uno).\n" +
    "5. Los montos se guardan como texto sin moneda ni separador de miles: \"1234.5\". " +
    "   Los porcentajes sin `%`: \"20\". Las fechas en YYYY-MM-DD.\n" +
    "6. `tipo_unidad` solo acepta \"N\" o \"S\". Los `tipo_tarifa_*` solo \"1\" o \"2\". " +
    "   `cond_credito` solo \"1\", \"2\" o \"3\".\n" +
    "7. Si el pedido es ambiguo o te falta información del contrato para resolverlo " +
    "   (ej. \"agregá el IVA\" sin que se sepa la tasa y sin que aparezca en la tabla), " +
    "   devolvé `operations: []` y usá `reply` para preguntar lo puntual que necesitás. " +
    "   Es MUCHO mejor preguntar que adivinar una tasa: los datos que aprobás acá se " +
    "   escriben tal cual en el maestro.\n" +
    "8. Fuentes: siempre tenés la tabla. Si el mensaje incluye DOCUMENTOS DEL CONTRATO " +
    "   o ADJUNTOS DEL OPERADOR (PDF, imágenes, Word, Excel), leelos y usalos como fuente " +
    "   de verdad para los datos que falten (ej. la tarifa del triple). Si no hay " +
    "   documentos y el dato no se puede derivar de la tabla, decílo en `reply` y pedí " +
    "   que adjunte el contrato o una captura, en lugar de inventarlo.\n" +
    "9. AGREGAR FILAS: cuando el operador pide una ocupación, temporada o variante nueva " +
    "   (ej. \"falta el triple de Terraza King\"), usá `duplicate_rows` sobre las filas " +
    "   existentes más parecidas (normalmente la DBL del mismo producto en cada temporada), " +
    "   con `set` para la ocupación nueva y `per_source`/`scale`/`derive` para los precios. " +
    "   Así heredan fechas, políticas, comida y códigos sin que tengas que reescribirlos. " +
    "   NUNCA respondas que no podés agregar filas: sí podés.\n" +
    "10. Precios de filas nuevas: tomalos del contrato/adjuntos si están. Si la tabla " +
    "   revela una fórmula (ej. el operador o los cambios previos dicen \"Neta × 1.2769\" y " +
    "   \"Rack = Neta / 0.80\"), poné en `per_source` la tarifa BASE del documento y aplicá " +
    "   la fórmula con `scale` y `derive` — no hagas la aritmética a mano. Si no tenés la " +
    "   tarifa base del triple por ningún lado, creá igual las filas (con los precios " +
    "   vacíos) SOLO si el operador lo pidió así; si no, preguntá.\n\n" +
    "CONTEXTO DE NEGOCIO ÚTIL:\n" +
    "- El IVA de turismo en Costa Rica es 13%. Aun así, NO lo asumas si el operador no " +
    "  lo menciona y la tabla no lo respalda — preguntá.\n" +
    "- `precios_neto_iva` es la tarifa NETA (lo que Utopía le paga al proveedor) y " +
    "  `precio_rack_iva` la tarifa RACK (público). Si al operador le falta el IVA \"en " +
    "  los precios\" sin más detalle, normalmente aplica a AMBAS columnas y también a " +
    "  sus versiones de fin de semana (`*_fds`) cuando tienen valor.\n" +
    "- Los `porcentaje_comision*` NUNCA se escalan por IVA: son porcentajes, no montos.\n" +
    "- Un contrato mezcla a veces hospedaje (tipo_unidad \"N\") con tours o traslados " +
    "  (tipo_unidad \"S\"); no uniformes esa columna salvo que te lo pidan."
  );
}

/* -------------------------------------------------------------------------- */
/*                          Aplicación de operaciones                         */
/* -------------------------------------------------------------------------- */

const TIPO_UNIDAD_VALUES = new Set(["N", "S"]);
const TIPO_TARIFA_KEYS = new Set([
  "tipo_tarifa_neta",
  "tipo_tarifa_mayorista",
  "tipo_tarifa_fds",
  "t_tar_neta_fds",
  "tipo_tarifa_mayorista_fds",
]);

/** Normaliza el `value` que llega del modelo a `string | null`. */
function coerceValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Valida el valor contra las restricciones de dominio de su columna. Devuelve
 * `undefined` cuando el valor es inválido para esa clave — el caller lo
 * descarta y lo reporta, en lugar de escribir basura que rompa la plantilla.
 */
function validateForKey(key: string, value: string | null): string | null | undefined {
  if (value === null) return null;
  if (key === "tipo_unidad") {
    const up = value.toUpperCase();
    return TIPO_UNIDAD_VALUES.has(up) ? up : undefined;
  }
  if (TIPO_TARIFA_KEYS.has(key)) {
    return value === "1" || value === "2" ? value : undefined;
  }
  if (key === "cond_credito") {
    return value === "1" || value === "2" || value === "3" ? value : undefined;
  }
  return value;
}

/**
 * Parsea un monto guardado como texto. Tolera lo que la IA de extracción o el
 * operador pueden haber dejado: prefijo de moneda ("USD 295"), separadores de
 * miles ("1,234.50") y coma decimal ("295,50"). Devuelve `null` cuando no hay
 * un número reconocible — esas celdas se saltan en lugar de convertirse en 0.
 */
export function parseAmount(raw: string | null): number | null {
  if (raw === null) return null;
  let s = raw.trim();
  if (s === "") return null;
  // Quita cualquier cosa que no sea dígito, signo, punto o coma.
  s = s.replace(/[^\d.,-]/g, "");
  if (s === "") return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // Formato europeo: la coma es el separador decimal.
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // Formato anglosajón: las comas son separadores de miles.
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Formatea un monto a texto: 2 decimales como techo, sin ceros de relleno. */
function formatAmount(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

/**
 * Escribe una celda de fila cuya clave ya fue validada contra `ROW_KEYS`.
 * `Object.assign` en vez de un cast a `Record<string, unknown>`: TypeScript no
 * deja indexar `ContractRow` con un string arbitrario, y castear el objeto
 * entero perdería el chequeo de tipo del resto del archivo.
 */
function writeRowCell(row: ContractRow, key: string, value: string | null): void {
  Object.assign(row, { [key]: value });
}

function emptyRow(): ContractRow {
  return {
    product_name: null,
    categoria: null,
    tipo_servicio: null,
    tipo_unidad: null,
    codigo_servicio: null,
    ocupacion: null,
    tarifa_persona_adicional: null,
    season_name: null,
    season_starts: null,
    season_ends: null,
    meals_included: null,
    precios_neto_iva: null,
    precio_rack_iva: null,
    porcentaje_comision: null,
    precios_neto_iva_fds: null,
    precio_rack_iva_fds: null,
    porcentaje_comision_fds: null,
    cancellation_policy: null,
    range_payment_policy: null,
    kids_policy: null,
    other_included: null,
    feeds_adicionales: null,
  };
}

interface WorkingTable {
  shared: Record<string, string | null>;
  rows: ContractRow[];
  /** Índice original de cada fila (null = fila nueva creada por el chat). */
  origin: (number | null)[];
}

interface RawOperation {
  op?: unknown;
  key?: unknown;
  value?: unknown;
  rows?: unknown;
  where?: unknown;
  where_contains?: unknown;
  cells?: unknown;
  factor?: unknown;
  source_key?: unknown;
  new_rows?: unknown;
  set?: unknown;
  per_source?: unknown;
  scale?: unknown;
  derive?: unknown;
}

/** Normaliza texto para comparar valores de celda: minúsculas + espacios colapsados. */
function norm(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).toLowerCase().replace(/\s+/g, " ").trim();
}

/** Parsea un filtro `{ clave_de_fila: [valores] }`; ignora claves desconocidas. */
function parseFilter(raw: unknown): Map<string, string[]> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = new Map<string, string[]>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ROW_KEYS[k]) continue;
    const list = (Array.isArray(v) ? v : [v])
      .filter((x) => typeof x === "string" || typeof x === "number")
      .map(norm)
      .filter((x) => x !== "");
    if (list.length > 0) out.set(k, list);
  }
  return out.size > 0 ? out : null;
}

/**
 * Traduce números de fila 1-based del snapshot ORIGINAL a índices actuales
 * de `working.rows`. Así "fila 12" sigue siendo la misma fila aunque una
 * operación anterior del mismo turno haya borrado o insertado filas. Las
 * filas ya borradas o fuera de rango se cuentan en `skipped`.
 */
function originalToCurrent(
  working: WorkingTable,
  raw: unknown[],
): { indices: number[]; skipped: number } {
  const byOrigin = new Map<number, number>();
  working.origin.forEach((o, i) => {
    if (o !== null) byOrigin.set(o, i);
  });
  const seen = new Set<number>();
  let skipped = 0;
  for (const n of raw) {
    const num = typeof n === "number" ? n : Number(n);
    const cur = Number.isInteger(num) ? byOrigin.get(num - 1) : undefined;
    if (cur === undefined) {
      skipped++;
      continue;
    }
    seen.add(cur);
  }
  return { indices: [...seen].sort((a, b) => a - b), skipped };
}

/**
 * Resuelve las filas de una operación combinando `rows` (números del
 * snapshot original) con los filtros `where` / `where_contains` (evaluados
 * sobre el estado actual). Sin `rows` ni filtros = todas las filas.
 */
function resolveRowTargets(
  raw: RawOperation,
  working: WorkingTable,
): { indices: number[]; all: boolean; skipped: number } {
  const exact = parseFilter(raw.where);
  const contains = parseFilter(raw.where_contains);
  const hasRows = Array.isArray(raw.rows);
  if (!hasRows && !exact && !contains) {
    if (raw.rows !== null && raw.rows !== undefined) {
      return { indices: [], all: false, skipped: 0 };
    }
    return {
      indices: working.rows.map((_, i) => i),
      all: true,
      skipped: 0,
    };
  }
  let indices: number[];
  let skipped = 0;
  if (hasRows) {
    const r = originalToCurrent(working, raw.rows as unknown[]);
    indices = r.indices;
    skipped = r.skipped;
  } else {
    indices = working.rows.map((_, i) => i);
  }
  const matches = (i: number): boolean => {
    const row = working.rows[i];
    if (!row) return false;
    if (exact) {
      for (const [k, vals] of exact) {
        if (!vals.includes(norm(row[k as keyof ContractRow]))) return false;
      }
    }
    if (contains) {
      for (const [k, vals] of contains) {
        const cell = norm(row[k as keyof ContractRow]);
        if (!vals.some((v) => cell.includes(v))) return false;
      }
    }
    return true;
  };
  return { indices: indices.filter(matches), all: false, skipped };
}

/** Describe el alcance de una operación para el resumen de cambios. */
function scopeLabel(t: { indices: number[]; all: boolean }): string {
  return t.all ? "todas las filas" : `${t.indices.length} fila(s)`;
}

/** Lee un objeto `{ clave_de_fila: valor }` validando claves y dominio. */
function readRowValues(raw: unknown): { values: [string, string | null][]; rejected: number } {
  const values: [string, string | null][] = [];
  let rejected = 0;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { values, rejected };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ROW_KEYS[k]) {
      rejected++;
      continue;
    }
    const validated = validateForKey(k, coerceValue(v));
    if (validated === undefined) {
      rejected++;
      continue;
    }
    values.push([k, validated]);
  }
  return { values, rejected };
}

/** destino = origen × factor sobre una fila. Devuelve false si no hay número. */
function deriveCell(row: ContractRow, key: string, sourceKey: string, factor: number): boolean {
  const n = parseAmount(row[sourceKey as RowFieldKey]);
  if (n === null) return false;
  writeRowCell(row, key, formatAmount(n * factor));
  return true;
}

/**
 * Aplica las operaciones del modelo sobre una copia de la tabla. Todo lo que
 * no se pueda aplicar (clave desconocida, fila inexistente, valor fuera de
 * dominio) se descarta y se anota en `changes` para que el operador vea que
 * esa parte de su pedido NO se ejecutó.
 *
 * Exportada (junto con `materializeTable` y `parseAmount`) para poder testear
 * el motor de operaciones sin llamar a Anthropic: es la parte del flujo donde
 * un bug corrompe datos en silencio.
 */
export function applyOperations(
  table: ContractTable,
  operations: RawOperation[],
): { working: WorkingTable; changes: string[] } {
  const shared: Record<string, string | null> = {};
  for (const k of SHARED_KEY_LIST) shared[k] = readShared(table, k);

  const working: WorkingTable = {
    shared,
    rows: table.rows.map((r) => ({ ...r })),
    origin: table.rows.map((_, i) => i),
  };
  const changes: string[] = [];

  for (const raw of operations) {
    const op = typeof raw.op === "string" ? raw.op : "";

    if (op === "set_shared") {
      const key = typeof raw.key === "string" ? raw.key : "";
      if (!SHARED_KEYS[key]) {
        changes.push(`⚠️ Ignorado: "${key}" no es un campo compartido válido.`);
        continue;
      }
      const validated = validateForKey(key, coerceValue(raw.value));
      if (validated === undefined) {
        changes.push(
          `⚠️ Ignorado: valor inválido para ${SHARED_KEYS[key]!.label}.`,
        );
        continue;
      }
      working.shared[key] = validated;
      changes.push(
        `${SHARED_KEYS[key]!.label} (col ${SHARED_KEYS[key]!.col}) → ${validated ?? "(vacío)"}`,
      );
      continue;
    }

    if (op === "set_rows") {
      const key = typeof raw.key === "string" ? raw.key : "";
      if (!ROW_KEYS[key]) {
        changes.push(`⚠️ Ignorado: "${key}" no es un campo de fila válido.`);
        continue;
      }
      const validated = validateForKey(key, coerceValue(raw.value));
      if (validated === undefined) {
        changes.push(`⚠️ Ignorado: valor inválido para ${ROW_KEYS[key]!.label}.`);
        continue;
      }
      const target = resolveRowTargets(raw, working);
      for (const i of target.indices) {
        const row = working.rows[i];
        if (row) writeRowCell(row, key, validated);
      }
      changes.push(
        `${ROW_KEYS[key]!.label} (col ${ROW_KEYS[key]!.col}) → ${validated ?? "(vacío)"} en ${scopeLabel(target)}`,
      );
      continue;
    }

    if (op === "set_cells") {
      if (!Array.isArray(raw.cells)) {
        changes.push("⚠️ Ignorado: set_cells sin lista de celdas.");
        continue;
      }
      if (raw.cells.length > MAX_CELLS_PER_OP) {
        changes.push(
          `⚠️ Ignorado: set_cells con demasiadas celdas (${raw.cells.length}).`,
        );
        continue;
      }
      let applied = 0;
      let rejected = 0;
      const touchedKeys = new Set<string>();
      const byOrigin = new Map<number, number>();
      working.origin.forEach((o, i) => {
        if (o !== null) byOrigin.set(o, i);
      });
      for (const c of raw.cells) {
        if (!c || typeof c !== "object") {
          rejected++;
          continue;
        }
        const cell = c as { row?: unknown; key?: unknown; value?: unknown };
        const key = typeof cell.key === "string" ? cell.key : "";
        const rowNum = typeof cell.row === "number" ? cell.row : Number(cell.row);
        const current = Number.isInteger(rowNum) ? byOrigin.get(rowNum - 1) : undefined;
        if (!ROW_KEYS[key] || current === undefined) {
          rejected++;
          continue;
        }
        const validated = validateForKey(key, coerceValue(cell.value));
        if (validated === undefined) {
          rejected++;
          continue;
        }
        const target = working.rows[current];
        if (!target) {
          rejected++;
          continue;
        }
        writeRowCell(target, key, validated);
        touchedKeys.add(key);
        applied++;
      }
      if (applied > 0) {
        const labels = [...touchedKeys]
          .map((k) => ROW_KEYS[k]!.label)
          .join(", ");
        changes.push(`${applied} celda(s) actualizada(s) — ${labels}`);
      }
      if (rejected > 0) {
        changes.push(`⚠️ ${rejected} celda(s) descartada(s) por clave/fila/valor inválido.`);
      }
      continue;
    }

    if (op === "scale_rows") {
      const key = typeof raw.key === "string" ? raw.key : "";
      const meta = ROW_KEYS[key];
      if (!meta) {
        changes.push(`⚠️ Ignorado: "${key}" no es un campo de fila válido.`);
        continue;
      }
      if (!meta.numeric) {
        changes.push(
          `⚠️ Ignorado: ${meta.label} no es una columna numérica; no se puede escalar.`,
        );
        continue;
      }
      const factor =
        typeof raw.factor === "number" ? raw.factor : Number(raw.factor);
      if (!Number.isFinite(factor) || factor <= 0) {
        changes.push(`⚠️ Ignorado: factor inválido para ${meta.label}.`);
        continue;
      }
      const target = resolveRowTargets(raw, working);
      const { indices, all } = target;
      let applied = 0;
      let skippedEmpty = 0;
      for (const i of indices) {
        const row = working.rows[i];
        if (!row) continue;
        const n = parseAmount(row[key as RowFieldKey]);
        if (n === null) {
          skippedEmpty++;
          continue;
        }
        writeRowCell(row, key, formatAmount(n * factor));
        applied++;
      }
      changes.push(
        `${meta.label} (col ${meta.col}) × ${factor} en ${applied} fila(s)${
          all ? " (todas)" : ""
        }${skippedEmpty > 0 ? ` — ${skippedEmpty} sin valor numérico, sin tocar` : ""}`,
      );
      continue;
    }

    if (op === "delete_rows") {
      if (!Array.isArray(raw.rows) && !raw.where && !raw.where_contains) {
        changes.push("⚠️ Ignorado: delete_rows necesita `rows` o un filtro `where`.");
        continue;
      }
      const { indices } = resolveRowTargets(raw, working);
      if (indices.length === 0) {
        changes.push("⚠️ Ignorado: delete_rows sin filas válidas.");
        continue;
      }
      if (indices.length >= working.rows.length) {
        changes.push(
          "⚠️ Ignorado: no se pueden borrar todas las filas — el xlsx necesita al menos una.",
        );
        continue;
      }
      const drop = new Set(indices);
      working.rows = working.rows.filter((_, i) => !drop.has(i));
      working.origin = working.origin.filter((_, i) => !drop.has(i));
      changes.push(`${indices.length} fila(s) eliminada(s).`);
      continue;
    }

    if (op === "derive_rows") {
      const key = typeof raw.key === "string" ? raw.key : "";
      const sourceKey = typeof raw.source_key === "string" ? raw.source_key : "";
      const meta = ROW_KEYS[key];
      const srcMeta = ROW_KEYS[sourceKey];
      if (!meta?.numeric || !srcMeta?.numeric) {
        changes.push(
          `⚠️ Ignorado: derive_rows necesita columnas numéricas válidas ("${key}" ← "${sourceKey}").`,
        );
        continue;
      }
      const factor = typeof raw.factor === "number" ? raw.factor : Number(raw.factor);
      if (!Number.isFinite(factor) || factor <= 0) {
        changes.push(`⚠️ Ignorado: factor inválido para ${meta.label}.`);
        continue;
      }
      const target = resolveRowTargets(raw, working);
      let applied = 0;
      let skippedEmpty = 0;
      for (const i of target.indices) {
        const row = working.rows[i];
        if (!row) continue;
        if (deriveCell(row, key, sourceKey, factor)) applied++;
        else skippedEmpty++;
      }
      changes.push(
        `${meta.label} (col ${meta.col}) = ${srcMeta.label} × ${factor} en ${applied} fila(s)${
          skippedEmpty > 0 ? ` — ${skippedEmpty} sin valor de origen, sin tocar` : ""
        }`,
      );
      continue;
    }

    if (op === "duplicate_rows") {
      if (!Array.isArray(raw.rows) && !raw.where && !raw.where_contains) {
        changes.push("⚠️ Ignorado: duplicate_rows necesita `rows` o un filtro `where`.");
        continue;
      }
      const target = resolveRowTargets(raw, working);
      if (target.indices.length === 0) {
        changes.push("⚠️ Ignorado: duplicate_rows no encontró filas de origen con ese filtro.");
        continue;
      }
      if (working.rows.length + target.indices.length > MAX_ROWS) {
        changes.push(`⚠️ Ignorado: duplicate_rows superaría el máximo de ${MAX_ROWS} filas.`);
        continue;
      }

      const common = readRowValues(raw.set);
      let rejected = common.rejected;

      // Overrides por fila de origen (número del snapshot original → valores).
      const perSource = new Map<number, [string, string | null][]>();
      if (Array.isArray(raw.per_source)) {
        for (const ps of raw.per_source) {
          if (!ps || typeof ps !== "object") continue;
          const entry = ps as { row?: unknown; set?: unknown };
          const num = typeof entry.row === "number" ? entry.row : Number(entry.row);
          if (!Number.isInteger(num)) {
            rejected++;
            continue;
          }
          const vals = readRowValues(entry.set);
          rejected += vals.rejected;
          perSource.set(num - 1, [...(perSource.get(num - 1) ?? []), ...vals.values]);
        }
      }

      const scale: [string, number][] = [];
      if (raw.scale && typeof raw.scale === "object" && !Array.isArray(raw.scale)) {
        for (const [k, f] of Object.entries(raw.scale as Record<string, unknown>)) {
          const factor = typeof f === "number" ? f : Number(f);
          if (ROW_KEYS[k]?.numeric && Number.isFinite(factor) && factor > 0) {
            scale.push([k, factor]);
          } else {
            rejected++;
          }
        }
      }

      const derive: { key: string; source: string; factor: number }[] = [];
      if (Array.isArray(raw.derive)) {
        for (const d of raw.derive) {
          const e = (d ?? {}) as { key?: unknown; source_key?: unknown; factor?: unknown };
          const key = typeof e.key === "string" ? e.key : "";
          const source = typeof e.source_key === "string" ? e.source_key : "";
          const factor = typeof e.factor === "number" ? e.factor : Number(e.factor);
          if (
            ROW_KEYS[key]?.numeric &&
            ROW_KEYS[source]?.numeric &&
            Number.isFinite(factor) &&
            factor > 0
          ) {
            derive.push({ key, source, factor });
          } else {
            rejected++;
          }
        }
      }

      // Insertamos de abajo hacia arriba para que los índices de las filas
      // de origen que faltan procesar no se corran.
      const sources = [...target.indices].sort((a, b) => b - a);
      let created = 0;
      let missingNumbers = 0;
      for (const i of sources) {
        const src = working.rows[i];
        if (!src) continue;
        const copy: ContractRow = { ...src };
        for (const [k, v] of common.values) writeRowCell(copy, k, v);
        const originIdx = working.origin[i];
        if (originIdx !== null && originIdx !== undefined) {
          for (const [k, v] of perSource.get(originIdx) ?? []) writeRowCell(copy, k, v);
        }
        for (const [k, factor] of scale) {
          const n = parseAmount(copy[k as RowFieldKey]);
          if (n === null) {
            missingNumbers++;
            continue;
          }
          writeRowCell(copy, k, formatAmount(n * factor));
        }
        for (const d of derive) {
          if (!deriveCell(copy, d.key, d.source, d.factor)) missingNumbers++;
        }
        working.rows.splice(i + 1, 0, copy);
        working.origin.splice(i + 1, 0, null);
        created++;
      }

      const setDesc = common.values
        .map(([k, v]) => `${ROW_KEYS[k]!.label} = ${v ?? "(vacío)"}`)
        .join(", ");
      changes.push(
        `${created} fila(s) nueva(s) creada(s) a partir de filas existentes` +
          (setDesc ? ` (${setDesc})` : "") +
          (perSource.size > 0 ? `, ${perSource.size} con valores propios` : "") +
          (scale.length > 0
            ? `, ${scale.map(([k, f]) => `${ROW_KEYS[k]!.label} × ${f}`).join(", ")}`
            : "") +
          (derive.length > 0
            ? `, ${derive.map((d) => `${ROW_KEYS[d.key]!.label} = ${ROW_KEYS[d.source]!.label} × ${d.factor}`).join(", ")}`
            : "") +
          ". Insertadas debajo de cada fila original.",
      );
      if (missingNumbers > 0) {
        changes.push(`⚠️ ${missingNumbers} cálculo(s) omitido(s) por celdas sin valor numérico.`);
      }
      if (rejected > 0) {
        changes.push(`⚠️ ${rejected} valor(es) descartado(s) por clave o valor inválido.`);
      }
      continue;
    }

    if (op === "add_rows") {
      if (!Array.isArray(raw.new_rows) || raw.new_rows.length === 0) {
        changes.push("⚠️ Ignorado: add_rows sin filas nuevas.");
        continue;
      }
      if (working.rows.length + raw.new_rows.length > MAX_ROWS) {
        changes.push(
          `⚠️ Ignorado: add_rows superaría el máximo de ${MAX_ROWS} filas.`,
        );
        continue;
      }
      let added = 0;
      for (const nr of raw.new_rows) {
        if (!nr || typeof nr !== "object") continue;
        const row = emptyRow();
        for (const [k, v] of Object.entries(nr as Record<string, unknown>)) {
          if (!ROW_KEYS[k]) continue;
          const validated = validateForKey(k, coerceValue(v));
          if (validated === undefined) continue;
          writeRowCell(row, k, validated);
        }
        working.rows.push(row);
        working.origin.push(null);
        added++;
      }
      if (added > 0) changes.push(`${added} fila(s) agregada(s) al final.`);
      continue;
    }

    changes.push(`⚠️ Ignorado: operación desconocida "${op}".`);
  }

  return { working, changes };
}

/** Reconstruye los tres contenedores del payload a partir del estado plano. */
export function materializeTable(
  base: ContractTable,
  working: WorkingTable,
): ContractTable {
  const shared_fields: SharedFields = { ...base.shared_fields };
  const catalog: CatalogPrefillFields = {
    tipo_actividad: null,
    zona_turismo: null,
    proveedor_codigo: null,
    // codigo_servicio vive por fila; se preserva tal cual venía.
    codigo_servicio: base.catalog_prefill?.codigo_servicio ?? null,
  };
  const manual: ManualFields = {
    tipo_tarifa_neta: null,
    tipo_tarifa_mayorista: null,
    tipo_tarifa_fds: null,
    t_tar_neta_fds: null,
    tipo_tarifa_mayorista_fds: null,
    cond_credito: null,
    plazo: null,
    cuenta_bancaria_2: null,
    banco_2: null,
    moneda_2: null,
    cuenta_bancaria_3: null,
    banco_3: null,
    moneda_3: null,
  };

  for (const k of SHARED_KEY_LIST) {
    const meta = SHARED_KEYS[k]!;
    const v = working.shared[k] ?? null;
    if (meta.origin === "catalog") {
      Object.assign(catalog, { [k]: v });
    } else if (meta.origin === "manual") {
      Object.assign(manual, { [k]: v });
    } else {
      Object.assign(shared_fields, { [k]: v });
    }
  }

  return {
    shared_fields,
    rows: working.rows,
    catalog_prefill: catalog,
    manual_fields: manual,
  };
}

/* -------------------------------------------------------------------------- */
/*                                 Entry point                                */
/* -------------------------------------------------------------------------- */

export interface RefineTableInput {
  table: ContractTable;
  message: string;
  history?: TableChatMessage[];
  /** Contexto libre del contrato (comentarios del Paso 1), si existe. */
  comments?: string | null;
  /**
   * Documentos originales del contrato (los del Paso 1). Opcionales: el
   * operador los incluye cuando la corrección necesita datos que no están en
   * la tabla (ej. la tarifa del triple).
   */
  documents?: PreparedDocumentInput[];
  /** Adjuntos que el operador soltó en este mensaje del chat. */
  attachments?: PreparedDocumentInput[];
  requestId?: string;
}

export async function refineContractTable(
  input: RefineTableInput,
): Promise<TableRefineResult> {
  const { table, requestId } = input;

  if (!Array.isArray(table.rows) || table.rows.length === 0) {
    throw ApiError.badRequest("La tabla no tiene filas para corregir.");
  }
  if (table.rows.length > MAX_ROWS) {
    throw ApiError.badRequest(
      `Demasiadas filas (${table.rows.length}). El máximo permitido es ${MAX_ROWS}.`,
    );
  }
  const message = input.message.trim();
  if (!message) {
    throw ApiError.badRequest("El mensaje de corrección no puede estar vacío.");
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    throw ApiError.badRequest(
      `El mensaje excede el máximo (${MAX_MESSAGE_CHARS} caracteres).`,
    );
  }

  const history = (input.history ?? []).slice(-MAX_HISTORY_MESSAGES);
  const historyBlock =
    history.length > 0
      ? "\n\n═══ CORRECCIONES PREVIAS EN ESTA SESIÓN ═══\n" +
        history
          .map(
            (m) =>
              `${m.role === "user" ? "Operador" : "Asistente"}: ${truncate(m.content, 1200)}`,
          )
          .join("\n\n")
      : "";

  const commentsBlock =
    input.comments && input.comments.trim()
      ? "\n\n═══ CONTEXTO QUE EL OPERADOR DIO AL SUBIR EL CONTRATO ═══\n" +
        truncate(input.comments.trim(), 2000)
      : "";

  const documents = input.documents ?? [];
  const attachments = input.attachments ?? [];

  const userText =
    buildTableSnapshot(table) +
    commentsBlock +
    historyBlock +
    "\n\n═══ PEDIDO DEL OPERADOR ═══\n" +
    message +
    (attachments.length > 0
      ? `\n\n(El operador adjuntó ${attachments.length} archivo(s) a este mensaje — ` +
        "están arriba como ADJUNTOS DEL OPERADOR.)"
      : "") +
    `\n\nRespondé con la herramienta "${TOOL_NAME}".`;

  // Documentos primero (prefijo estable → cacheable entre mensajes del chat),
  // después los adjuntos de este turno y al final la tabla + el pedido.
  const userContent: ContentBlockParam[] = [];
  if (documents.length > 0) {
    userContent.push({
      type: "text",
      text: "═══ DOCUMENTOS DEL CONTRATO (los originales del Paso 1) ═══",
    });
    userContent.push(...documentBlocks(documents, "Documento del contrato"));
    const last = userContent[userContent.length - 1] as ContentBlockParam & {
      cache_control?: { type: "ephemeral" };
    };
    last.cache_control = { type: "ephemeral" };
  }
  if (attachments.length > 0) {
    userContent.push({
      type: "text",
      text: "═══ ADJUNTOS DEL OPERADOR (contexto extra para este pedido) ═══",
    });
    userContent.push(...documentBlocks(attachments, "Adjunto"));
  }
  userContent.push({ type: "text", text: userText });

  const client = getAnthropicClient();
  let response;
  try {
    // Los modelos 5.5 no aceptan tool_choice "tool": usamos "auto" con
    // instrucción explícita y un reintento si contesta en texto.
    const system =
      buildSystemPrompt() +
      `\n\nFORMATO DE RESPUESTA (obligatorio): respondé ÚNICAMENTE llamando a la herramienta "${TOOL_NAME}". Sin texto fuera de la herramienta.`;
    const baseMessages: MessageParam[] = [{ role: "user", content: userContent }];
    const call = (messages: MessageParam[]) =>
      client.messages.create({
        model: SUPPLIER_TABLE_CHAT_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools: [CORREGIR_TABLA_TOOL],
        tool_choice: { type: "auto" },
        messages,
      });
    response = await call(baseMessages);
    if (!response.content.some((b) => b.type === "tool_use" && b.name === TOOL_NAME) && response.stop_reason !== "max_tokens") {
      logger.warn("Table refine answered in text — nudging to tool", { requestId });
      const text = response.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      response = await call([
        ...baseMessages,
        { role: "assistant", content: text || "(sin respuesta)" },
        { role: "user", content: `Llamá AHORA a la herramienta "${TOOL_NAME}" con las operaciones. No respondas con texto.` },
      ]);
    }
  } catch (err) {
    if (err instanceof APIError) {
      logger.error("Anthropic API error during table refine", {
        requestId,
        status: err.status,
        message: err.message,
      });
      throw new ApiError(
        502,
        "El asistente de correcciones no está disponible en este momento. Intentá de nuevo.",
      );
    }
    logger.error("Unexpected error calling Anthropic for table refine", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ApiError(502, "Error al invocar al asistente de correcciones.");
  }

  const toolUse = response.content.find(
    (block): block is ToolUseBlock =>
      block.type === "tool_use" && block.name === TOOL_NAME,
  );
  if (response.stop_reason === "max_tokens") {
    // Con la respuesta cortada, el input del tool llega truncado o vacío:
    // aplicar "lo que haya" daría una corrección a medias sin aviso.
    logger.warn("Table refine hit max_tokens", { requestId });
    throw new ApiError(
      422,
      "El pedido generó demasiados cambios para una sola respuesta. Dividilo en partes " +
        "más chicas (por ejemplo, un producto o una temporada por mensaje).",
    );
  }

  if (!toolUse) {
    logger.error("Table refine response missing tool_use block", {
      requestId,
      stopReason: response.stop_reason,
    });
    throw new ApiError(
      502,
      "El asistente no devolvió correcciones estructuradas. Intentá de nuevo.",
    );
  }

  const parsed = toolUse.input as { reply?: unknown; operations?: unknown };
  const rawOps = Array.isArray(parsed.operations)
    ? (parsed.operations.slice(0, MAX_OPERATIONS) as RawOperation[])
    : [];
  if (Array.isArray(parsed.operations) && parsed.operations.length > MAX_OPERATIONS) {
    logger.warn("Table refine returned too many operations — truncated", {
      requestId,
      returned: parsed.operations.length,
      cap: MAX_OPERATIONS,
    });
  }

  const { working, changes } = applyOperations(table, rawOps);
  const nextTable = materializeTable(table, working);

  const reply =
    typeof parsed.reply === "string" && parsed.reply.trim()
      ? parsed.reply.trim()
      : changes.length > 0
        ? "Apliqué las correcciones sobre la tabla."
        : "No encontré nada que cambiar con ese pedido.";

  const u = response.usage;
  const inputTokens =
    (u?.input_tokens ?? 0) +
    (u?.cache_creation_input_tokens ?? 0) +
    (u?.cache_read_input_tokens ?? 0);
  const outputTokens = u?.output_tokens ?? 0;
  const costUsd = Number(
    (
      (inputTokens / 1_000_000) * TABLE_CHAT_PRICES.input +
      (outputTokens / 1_000_000) * TABLE_CHAT_PRICES.output
    ).toFixed(6),
  );

  logger.info("Supplier Intelligence table refine finished", {
    requestId,
    operations: rawOps.length,
    changes: changes.length,
    rowsBefore: table.rows.length,
    rowsAfter: nextTable.rows.length,
    documents: documents.length,
    attachments: attachments.length,
    inputTokens,
    outputTokens,
    costUsd,
  });

  return {
    table: nextTable,
    rowIndexMap: working.origin,
    reply,
    changes,
    model: SUPPLIER_TABLE_CHAT_MODEL,
    usage: { inputTokens, outputTokens, costUsd },
  };
}
