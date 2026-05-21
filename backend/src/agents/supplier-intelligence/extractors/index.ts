import ApiError from "../../../utils/ApiError.js";
import type { PreparedDocument, SupportedDocKind } from "../types.js";
import { prepareFromDocx } from "./docx.js";
import { prepareFromImage, resolveImageMediaType } from "./image.js";
import { prepareFromPdf } from "./pdf.js";
import { prepareFromXlsx } from "./xlsx.js";

/**
 * MIME → kind table. We prefer MIME because browsers usually set it
 * correctly; extension is only a fallback for clients that upload as
 * `application/octet-stream`.
 *
 * Las imágenes (JPEG/PNG/GIF/WebP) mapean a "image" — Claude Opus 4.6 las
 * lee nativamente como bloques `image`, sin OCR previo.
 */
const MIME_TO_KIND: Record<string, SupportedDocKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/msword": "docx", // legacy .doc — mammoth will reject the buffer if it's really binary .doc
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xlsx", // legacy .xls — SheetJS can read it
  "image/jpeg": "image",
  "image/jpg": "image", // algunos clientes emiten esto en vez del estándar image/jpeg
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
};

const EXT_TO_KIND: Record<string, SupportedDocKind> = {
  pdf: "pdf",
  docx: "docx",
  doc: "docx",
  xlsx: "xlsx",
  xls: "xlsx",
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
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
 * Dispatch to the right extractor for this document kind. PDFs e imágenes
 * van como base64 (Claude las lee nativamente — `document` block para PDF,
 * `image` block para JPEG/PNG/etc.); Word / Excel se convierten a texto
 * plano antes de pasarle a Claude.
 */
export async function prepareDocument(
  kind: SupportedDocKind,
  buffer: Buffer,
  mimetype?: string,
  originalName?: string,
): Promise<PreparedDocument> {
  try {
    switch (kind) {
      case "pdf":
        return prepareFromPdf(buffer);
      case "docx":
        return await prepareFromDocx(buffer);
      case "xlsx":
        return prepareFromXlsx(buffer);
      case "image":
        // El media_type específico (image/jpeg vs image/png …) tiene que
        // viajar al bloque `image` de Anthropic, así que se resuelve acá
        // a partir del MIME + extensión que vienen del upload.
        return prepareFromImage(
          buffer,
          resolveImageMediaType(mimetype, originalName),
        );
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
