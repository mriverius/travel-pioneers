import mammoth from "mammoth";
import type { PreparedDocument } from "../types.js";

/**
 * Convert a .docx buffer to plain text via mammoth. We ask for raw text (not
 * HTML) because the downstream consumer is Claude — it doesn't benefit from
 * `<p>` tags and the raw text keeps token counts lower.
 *
 * Note: mammoth cannot read the older binary .doc format. The upload filter
 * accepts `.doc` for convenience (many people conflate the two in the
 * browser's file picker), but if the actual bytes are .doc we surface a
 * clear 415-style error from the caller.
 */
export async function prepareFromDocx(
  buffer: Buffer,
): Promise<PreparedDocument> {
  const result = await mammoth.extractRawText({ buffer });
  const text = (result.value ?? "").trim();

  if (!text) {
    throw new Error(
      "El documento Word parece estar vacío o no se pudo extraer texto. " +
        "Confirma que es un .docx válido (mammoth no soporta el formato .doc binario).",
    );
  }

  return { kind: "text", text, sourceFormat: "docx" };
}
