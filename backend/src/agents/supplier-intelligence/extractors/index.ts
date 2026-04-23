import ApiError from "../../../utils/ApiError.js";
import type { PreparedDocument, SupportedDocKind } from "../types.js";
import { prepareFromDocx } from "./docx.js";
import { prepareFromPdf } from "./pdf.js";
import { prepareFromXlsx } from "./xlsx.js";

/**
 * MIME → kind table. We prefer MIME because browsers usually set it
 * correctly; extension is only a fallback for clients that upload as
 * `application/octet-stream`.
 */
const MIME_TO_KIND: Record<string, SupportedDocKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/msword": "docx", // legacy .doc — mammoth will reject the buffer if it's really binary .doc
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xlsx", // legacy .xls — SheetJS can read it
};

const EXT_TO_KIND: Record<string, SupportedDocKind> = {
  pdf: "pdf",
  docx: "docx",
  doc: "docx",
  xlsx: "xlsx",
  xls: "xlsx",
};

/**
 * Detect the document kind from mimetype with a filename-extension fallback.
 * Returns null for anything unsupported so the caller can surface a clean
 * 415 error.
 */
export function detectDocKind(
  mimetype: string | undefined,
  originalName: string | undefined,
): SupportedDocKind | null {
  if (mimetype && MIME_TO_KIND[mimetype]) {
    return MIME_TO_KIND[mimetype];
  }
  if (originalName) {
    const ext = originalName.split(".").pop()?.toLowerCase();
    if (ext && EXT_TO_KIND[ext]) {
      return EXT_TO_KIND[ext];
    }
  }
  return null;
}

/**
 * Dispatch to the right extractor for this document kind. PDFs pass through
 * as base64 (Claude reads them natively); Word / Excel get converted to
 * plain text first.
 */
export async function prepareDocument(
  kind: SupportedDocKind,
  buffer: Buffer,
): Promise<PreparedDocument> {
  try {
    switch (kind) {
      case "pdf":
        return prepareFromPdf(buffer);
      case "docx":
        return await prepareFromDocx(buffer);
      case "xlsx":
        return prepareFromXlsx(buffer);
      default: {
        // Exhaustiveness guard — if a new kind is added above without a case
        // here, TS will complain at the assignment.
        const _exhaustive: never = kind;
        void _exhaustive;
        throw ApiError.badRequest("Tipo de documento no soportado");
      }
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw ApiError.badRequest(`No se pudo preparar el documento: ${message}`);
  }
}
