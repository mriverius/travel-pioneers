import type { PreparedDocument } from "../types.js";

/**
 * PDFs are NOT pre-parsed. Claude reads the PDF natively as a `document`
 * block (base64), which preserves layout, tables and page numbering — all of
 * which matter for the paginas_origen trazabilidad requirement.
 */
export function prepareFromPdf(buffer: Buffer): PreparedDocument {
  return {
    kind: "pdf",
    base64: buffer.toString("base64"),
    mediaType: "application/pdf",
  };
}
