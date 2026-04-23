import * as XLSX from "xlsx";
import type { PreparedDocument } from "../types.js";

/**
 * Convert an Excel workbook to a single concatenated plain-text string with
 * one CSV block per sheet. Sheet names are included as headers so Claude can
 * tell which tab it is reading — contracts sometimes split contact info and
 * banking info across multiple tabs.
 *
 * We use CSV rather than markdown tables because SheetJS produces valid CSV
 * trivially, and CSV is unambiguous for numeric / date cells.
 */
export function prepareFromXlsx(buffer: Buffer): PreparedDocument {
  const workbook = XLSX.read(buffer, { type: "buffer" });

  if (!workbook.SheetNames.length) {
    throw new Error("El archivo de Excel no contiene hojas legibles.");
  }

  const blocks: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // `raw: false` tells SheetJS to emit the formatted cell string (dates as
    // locale strings, numbers with thousand separators) rather than the raw
    // serial value — much more useful for a human-oriented model.
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    const trimmed = csv.trim();
    if (!trimmed) continue;

    blocks.push(`### Hoja: ${sheetName}\n${trimmed}`);
  }

  if (!blocks.length) {
    throw new Error(
      "El archivo de Excel no contiene datos legibles en ninguna hoja.",
    );
  }

  return {
    kind: "text",
    text: blocks.join("\n\n"),
    sourceFormat: "xlsx",
  };
}
