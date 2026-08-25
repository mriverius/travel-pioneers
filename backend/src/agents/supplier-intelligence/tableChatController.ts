import type { Request, Response } from "express";
import logger from "../../config/logger.js";
import ApiError from "../../utils/ApiError.js";
import {
  coerceCatalogPrefill,
  coerceManualFields,
  coerceRow,
  coerceSharedFields,
} from "./generateController.js";
import {
  refineContractTable,
  type CatalogPrefillFields,
  type ContractTable,
  type TableChatMessage,
} from "./tableChatService.js";

/**
 * POST /api/supplier-intelligence/refine-table
 *
 * Chat de correcciones "en caliente" del Paso 3. Recibe la MISMA envolvente
 * que `/generate-xlsx` (shared_fields + rows + catalog_prefill + manual_fields)
 * más el mensaje del operador, y devuelve la tabla ya corregida.
 *
 * A diferencia de `/refine-brief`, este endpoint es JSON puro: no re-sube los
 * documentos. El contexto es el JSON de la tabla que el operador está viendo,
 * que es exactamente lo que quiere corregir. Eso lo hace barato (un pase, sin
 * PDFs en el prompt) y rápido — el chat tiene que sentirse como un chat.
 *
 * Body JSON:
 * ```
 * {
 *   "shared_fields": {...}, "rows": [...],
 *   "catalog_prefill": {...} | null, "manual_fields": {...} | null,
 *   "message": "revisá los precios, no agregaste el IVA",
 *   "chat_history": [{ "role": "user", "content": "…" }, …],
 *   "comments": "…"            // opcional, contexto del Paso 1
 * }
 * ```
 *
 * Response 200:
 * ```
 * {
 *   "success": true,
 *   "table": { shared_fields, rows, catalog_prefill, manual_fields },
 *   "row_index_map": [0, 1, null, …],
 *   "reply": "…", "changes": ["…"],
 *   "meta": { model, processed_at, input_tokens, output_tokens, cost_usd }
 * }
 * ```
 */

const MAX_MESSAGE_CHARS = 4000;
const MAX_COMMENTS_CHARS = 5000;
const MAX_HISTORY = 20;
const MAX_ROWS = 500;

function parseMessage(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw ApiError.badRequest(
      "Falta el campo 'message' con la corrección del operador.",
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    throw ApiError.badRequest(
      `El mensaje excede el máximo (${MAX_MESSAGE_CHARS} caracteres).`,
    );
  }
  return trimmed;
}

function parseHistory(raw: unknown): TableChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: TableChatMessage[] = [];
  for (const item of raw.slice(-MAX_HISTORY)) {
    if (!item || typeof item !== "object") continue;
    const m = item as { role?: unknown; content?: unknown };
    if (
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      m.content.trim() !== ""
    ) {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function parseComments(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, MAX_COMMENTS_CHARS);
}

function parseTable(body: Record<string, unknown>): ContractTable {
  const shared_fields = coerceSharedFields(body.shared_fields);

  if (!Array.isArray(body.rows)) {
    throw ApiError.badRequest("`rows` debe ser un array.");
  }
  if (body.rows.length === 0) {
    throw ApiError.badRequest("`rows` no puede estar vacío.");
  }
  if (body.rows.length > MAX_ROWS) {
    throw ApiError.badRequest(
      `Demasiadas filas (${body.rows.length}). El máximo permitido es ${MAX_ROWS}.`,
    );
  }
  // Sin `expandRowsBySeasonPeriods`: el chat trabaja sobre las filas TAL CUAL
  // las ve el operador en la grilla. La expansión por tramos de temporada es
  // un paso de escritura del xlsx y correrla acá desalinearía los índices de
  // fila entre el snapshot y la UI.
  const rows = body.rows.map(coerceRow);

  const catalog_prefill = coerceCatalogPrefill(
    body.catalog_prefill,
  ) as CatalogPrefillFields | null;
  const manual_fields = coerceManualFields(body.manual_fields);

  return { shared_fields, rows, catalog_prefill, manual_fields };
}

export async function refineTableHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.body || typeof req.body !== "object") {
    throw ApiError.badRequest("El body debe ser un objeto JSON.");
  }
  const body = req.body as Record<string, unknown>;

  const table = parseTable(body);
  const message = parseMessage(body.message);
  const history = parseHistory(body.chat_history);
  const comments = parseComments(body.comments);

  logger.info("Supplier Intelligence table refine started", {
    requestId: req.id,
    rowCount: table.rows.length,
    messageLength: message.length,
    historyLength: history.length,
  });

  const result = await refineContractTable({
    table,
    message,
    history,
    comments,
    requestId: req.id,
  });

  res.status(200).json({
    success: true,
    table: {
      shared_fields: result.table.shared_fields,
      rows: result.table.rows,
      catalog_prefill: result.table.catalog_prefill,
      manual_fields: result.table.manual_fields,
    },
    row_index_map: result.rowIndexMap,
    reply: result.reply,
    changes: result.changes,
    meta: {
      model: result.model,
      processed_at: new Date().toISOString(),
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cost_usd: result.usage.costUsd,
    },
  });
}
