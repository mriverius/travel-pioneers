import type { PreparedDocument, ImageMediaType } from "../types.js";
import ApiError from "../../../utils/ApiError.js";

/**
 * Map of MIME → Anthropic-supported `image/*` media types. We deliberately
 * mirror only what Anthropic's Messages API accepts in vision blocks; any
 * other MIME (heic, tiff, svg, etc.) is rejected at this layer so the
 * upload pipeline surfaces a clean 415 instead of letting Claude reject
 * the request 60s later.
 *
 * NOTE: `image/jpg` is not technically a MIME type but some browsers/
 * clients emit it for JPEGs anyway — map it to `image/jpeg`.
 */
const MIME_TO_MEDIA: Record<string, ImageMediaType> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

/** Filename-extension fallback for clients that upload as octet-stream. */
const EXT_TO_MEDIA: Record<string, ImageMediaType> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Resolve the `image/*` media_type for an image upload. Returns null if
 * the buffer isn't a supported image format. The caller (the upload
 * middleware / `prepareDocument`) is responsible for turning that into a
 * user-visible 415.
 */
export function resolveImageMediaType(
  mimetype: string | undefined,
  originalName: string | undefined,
): ImageMediaType | null {
  if (mimetype && MIME_TO_MEDIA[mimetype]) {
    return MIME_TO_MEDIA[mimetype];
  }
  if (originalName) {
    const ext = originalName.split(".").pop()?.toLowerCase();
    if (ext && EXT_TO_MEDIA[ext]) {
      return EXT_TO_MEDIA[ext];
    }
  }
  return null;
}

/**
 * Imágenes (JPEG / PNG / GIF / WebP) van como bloques `image` nativos a
 * Claude Opus 4.6 — el modelo tiene vision built-in, así que no necesitamos
 * pre-procesar (OCR, redimensión, etc.). Anthropic recomienda imágenes
 * ≤ ~5 MB y resolución ≤ ~1568px en el lado largo para minimizar tokens,
 * pero el SDK acepta cualquier tamaño dentro del límite global (32 MB por
 * mensaje), así que dejamos que multer (`MAX_UPLOAD_BYTES = 20 MB`) sea la
 * primera barrera.
 *
 * El media_type debe ser uno de los aceptados por Anthropic (los del
 * union `ImageMediaType`). Se resuelve en `prepareDocument` antes de
 * llamar acá; si llega vacío, lanzamos para que la capa de error mapee a
 * 415 con un mensaje claro.
 */
export function prepareFromImage(
  buffer: Buffer,
  mediaType: ImageMediaType | null,
): PreparedDocument {
  if (!mediaType) {
    throw ApiError.badRequest(
      "Formato de imagen no soportado. Acepta JPEG, PNG, GIF o WebP.",
    );
  }
  return {
    kind: "image",
    base64: buffer.toString("base64"),
    mediaType,
  };
}
