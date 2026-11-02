import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer, { MulterError } from "multer";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import ApiError from "../../utils/ApiError.js";
import { detectDocKind, prepareDocument } from "./extractors/index.js";
import type { PreparedDocumentInput } from "./service.js";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES } from "./uploadMiddleware.js";

/**
 * Adjuntos de los chats de corrección (Paso 2 y Paso 3).
 *
 * El operador puede soltar en el chat capturas, PDFs, Word o Excel con
 * contexto extra ("acá está la tabla de triples", un mail del proveedor…).
 * Viajan en un campo multipart propio (`attachments`) para que el backend los
 * distinga de los documentos del contrato (`files`) y se los presente al
 * modelo como "adjuntos del operador", no como parte del contrato.
 */

/** Tope de adjuntos por mensaje del chat. */
export const MAX_CHAT_ATTACHMENTS = 5;

/**
 * El Paso 3 manda la tabla (hasta 500 filas) como campo de texto `payload`
 * dentro del multipart. El default de multer para campos de texto es 1 MB;
 * lo alineamos con el cap de 4 MB del JSON de `/refine-table` (+ holgura).
 */
const MAX_FIELD_BYTES = 6 * 1024 * 1024;

const fileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  const kind = detectDocKind(file.mimetype, file.originalname);
  if (!kind) {
    cb(
      new ApiError(
        415,
        `Tipo de archivo no soportado: ${file.originalname}. ` +
          "Solo se aceptan PDF, Word (.docx, .doc), Excel (.xlsx, .xls) e " +
          "imágenes (.jpg, .jpeg, .png, .gif, .webp).",
      ),
    );
    return;
  }
  cb(null, true);
};

const uploader = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: MAX_UPLOAD_FILES + MAX_CHAT_ATTACHMENTS,
    fieldSize: MAX_FIELD_BYTES,
  },
}).fields([
  { name: "files", maxCount: MAX_UPLOAD_FILES },
  { name: "attachments", maxCount: MAX_CHAT_ATTACHMENTS },
]);

/** Adjuntos del chat que dejó `handleChatUpload` en `res.locals`. */
export function getChatAttachmentFiles(res: Response): Express.Multer.File[] {
  const v = res.locals.chatAttachments as Express.Multer.File[] | undefined;
  return Array.isArray(v) ? v : [];
}

/**
 * Multer para los endpoints de chat. Acepta `files` (documentos del
 * contrato) y `attachments` (adjuntos del operador). Para no tocar el resto
 * del pipeline, deja `req.files` como el array de `files` — la misma forma
 * que produce `handleContractUpload` — y los adjuntos en
 * `res.locals.chatAttachments`.
 */
export const handleChatUpload: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  uploader(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          next(new ApiError(413, "Cada archivo debe pesar 20 MB o menos."));
          return;
        }
        if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
          next(
            ApiError.badRequest(
              `Demasiados archivos. Máximo ${MAX_CHAT_ATTACHMENTS} adjuntos por mensaje.`,
            ),
          );
          return;
        }
        if (err.code === "LIMIT_FIELD_VALUE") {
          next(new ApiError(413, "La tabla es demasiado grande para enviarla al chat."));
          return;
        }
        next(ApiError.badRequest(err.message));
        return;
      }
      next(err);
      return;
    }
    const grouped = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    res.locals.chatAttachments = grouped.attachments ?? [];
    req.files = grouped.files ?? [];
    next();
  });
};

/** Convierte archivos subidos al formato que consumen los prompts. */
export async function prepareFiles(
  files: Express.Multer.File[],
): Promise<PreparedDocumentInput[]> {
  const out: PreparedDocumentInput[] = [];
  for (const file of files) {
    const kind = detectDocKind(file.mimetype, file.originalname);
    if (!kind) {
      throw new ApiError(
        415,
        `Tipo de archivo no soportado: ${file.originalname} (${file.mimetype ?? "desconocido"}).`,
      );
    }
    const doc = await prepareDocument(kind, file.buffer, file.mimetype, file.originalname);
    out.push({ ...doc, originalName: file.originalname });
  }
  return out;
}

/**
 * Bloques de contenido Anthropic para una lista de documentos: PDF como
 * `document`, imágenes como `image`, Word/Excel como texto. Cada uno va
 * precedido de un header con `labelPrefix` + nombre del archivo.
 */
export function documentBlocks(
  docs: PreparedDocumentInput[],
  labelPrefix: string,
): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  docs.forEach((doc, idx) => {
    const label = `${labelPrefix} ${idx + 1} de ${docs.length}: ${doc.originalName}`;
    if (doc.kind === "pdf") {
      blocks.push({ type: "text", text: label });
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: doc.mediaType, data: doc.base64 },
      });
    } else if (doc.kind === "image") {
      blocks.push({ type: "text", text: `${label} (imagen)` });
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: doc.mediaType, data: doc.base64 },
      });
    } else {
      const format = doc.sourceFormat === "docx" ? "Word" : "Excel";
      blocks.push({
        type: "text",
        text:
          `${label} (${format}, convertido a texto)\n\n` +
          `-----BEGIN DOCUMENT-----\n${doc.text}\n-----END DOCUMENT-----`,
      });
    }
  });
  return blocks;
}
