import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import logger from "../../../config/logger.js";
import ApiError from "../../../utils/ApiError.js";

const execFileAsync = promisify(execFile);

/**
 * La API de Anthropic acepta ~32 MB por request y el PDF viaja en base64
 * (+33%). Un PDF de hasta 18 MB queda en ~24 MB de base64: deja margen para
 * el prompt y para un segundo documento chico. Por encima, se comprime.
 */
export const PDF_TARGET_BYTES = 18 * 1024 * 1024;

/**
 * Pasadas de Ghostscript, de mejor a peor calidad. Los manuales pesados lo
 * son por las fotos: bajar imágenes a 150 dpi suele alcanzar y las tablas
 * (texto vectorial) no se tocan. Las pasadas más agresivas sólo corren si la
 * anterior no entró — un PDF escaneado a 72 dpi todavía se lee, pero peor.
 */
const PASSES_DPI = [150, 110, 80];

/** Tiempo máximo por pasada: un PDF de ~100 MB tarda 20–60 s. */
const GS_TIMEOUT_MS = 3 * 60 * 1000;

const GS_BIN = process.env.GHOSTSCRIPT_BIN ?? "gs";

/**
 * El flujo sube los mismos archivos varias veces (pre-scan, brief, extract,
 * chat). Cache chico por hash para no recomprimir el mismo PDF en cada paso.
 */
const CACHE_MAX_ENTRIES = 8;
const cache = new Map<string, Buffer>();

function cacheGet(key: string): Buffer | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, value: Buffer): void {
  cache.set(key, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function runGhostscript(
  input: string,
  output: string,
  dpi: number,
): Promise<void> {
  await execFileAsync(
    GS_BIN,
    [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.5",
      "-dPDFSETTINGS=/ebook",
      "-dNOPAUSE",
      "-dQUIET",
      "-dBATCH",
      "-dSAFER",
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      "-dDownsampleColorImages=true",
      "-dDownsampleGrayImages=true",
      "-dDownsampleMonoImages=true",
      "-dColorImageDownsampleType=/Bicubic",
      "-dGrayImageDownsampleType=/Bicubic",
      `-dColorImageResolution=${dpi}`,
      `-dGrayImageResolution=${dpi}`,
      // Las imágenes 1-bit (escaneos B/N) necesitan más resolución para que
      // el texto siga legible.
      `-dMonoImageResolution=${Math.max(dpi * 2, 200)}`,
      `-sOutputFile=${output}`,
      input,
    ],
    { timeout: GS_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
}

/**
 * Devuelve el PDF tal cual si ya entra en `PDF_TARGET_BYTES`; si no, lo
 * recomprime con Ghostscript bajando la resolución de las imágenes hasta que
 * entre. Lanza 413 con un mensaje accionable si no hay forma de achicarlo.
 */
export async function shrinkPdfIfNeeded(
  buffer: Buffer,
  originalName = "documento.pdf",
): Promise<Buffer> {
  if (buffer.length <= PDF_TARGET_BYTES) return buffer;

  const key = createHash("sha256").update(buffer).digest("hex");
  const cached = cacheGet(key);
  if (cached) return cached;

  const dir = await mkdtemp(join(tmpdir(), "tp-pdf-"));
  const input = join(dir, "in.pdf");
  const started = Date.now();
  let best = buffer;
  try {
    await writeFile(input, buffer);
    for (const dpi of PASSES_DPI) {
      const output = join(dir, `out-${dpi}.pdf`);
      try {
        await runGhostscript(input, output, dpi);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new ApiError(
            413,
            `«${originalName}» pesa ${mb(buffer.length)} y el servidor no tiene ` +
              "Ghostscript instalado para comprimirlo. Comprimí el PDF por debajo " +
              `de ${mb(PDF_TARGET_BYTES)} o instalá Ghostscript en el servidor.`,
          );
        }
        logger.warn("pdf compression pass failed", {
          file: originalName,
          dpi,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const out = await readFile(output);
      if (out.length < best.length) best = out;
      if (out.length <= PDF_TARGET_BYTES) break;
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  logger.info("pdf compressed", {
    file: originalName,
    originalBytes: buffer.length,
    compressedBytes: best.length,
    ms: Date.now() - started,
  });

  if (best.length > PDF_TARGET_BYTES) {
    throw new ApiError(
      413,
      `«${originalName}» pesa ${mb(buffer.length)} y comprimido sigue en ` +
        `${mb(best.length)} (máximo ${mb(PDF_TARGET_BYTES)}). Dividí el PDF ` +
        "o subí solo las páginas con tarifas y políticas.",
    );
  }

  cacheSet(key, best);
  return best;
}
