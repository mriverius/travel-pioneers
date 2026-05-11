import { Router, json } from "express";
import rateLimit from "express-rate-limit";
import asyncHandler from "../utils/asyncHandler.js";
import { extractContractHandler } from "../agents/supplier-intelligence/controller.js";
import { matchSupplierHandler } from "../agents/supplier-intelligence/matchController.js";
import { generateXlsxHandler } from "../agents/supplier-intelligence/generateController.js";
import { supplierIntelligenceErrorHandler } from "../agents/supplier-intelligence/errorHandler.js";
import { handleContractUpload } from "../agents/supplier-intelligence/uploadMiddleware.js";

const router = Router();

/**
 * Anthropic calls cost real money and have their own rate limits, so we put
 * a conservative cap here. Tunable per-env later — keeping it inline for now
 * since the agent only has one route.
 */
const extractLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: "Demasiadas solicitudes de extracción. Intenta de nuevo en un minuto.",
    },
  },
});

/**
 * Rate limit más generoso para el matcher: la llamada es liviana (Haiku, sin
 * documentos), pero seguimos protegiendo costo y abuso.
 */
const matchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: "Demasiadas solicitudes de match. Intenta de nuevo en un minuto.",
    },
  },
});

/**
 * Generación de xlsx: no llama a Anthropic, no es costosa, pero seguimos
 * protegiendo contra abuso/payload basura.
 */
const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: "Demasiadas solicitudes de generación. Intenta de nuevo en un minuto.",
    },
  },
});

/**
 * Cap de payload: 600 candidatos × ~250 bytes + overhead. 1 MB es holgado y
 * sigue siendo un límite duro contra requests basura.
 */
const matchJsonParser = json({ limit: "1mb" });

/**
 * Cap de payload para generate-xlsx: hasta 500 filas × ~3 KB cada una +
 * shared. 4 MB es holgado para los contratos más grandes que veremos.
 */
const generateJsonParser = json({ limit: "4mb" });

/**
 * POST /api/supplier-intelligence/extract
 *
 * Order matters:
 *   1. rate limit (cheap reject)
 *   2. multer upload (parses multipart, rejects oversize / bad mime)
 *   3. controller (prepares the doc, calls Claude, validates)
 */
router.post(
  "/extract",
  extractLimiter,
  handleContractUpload,
  asyncHandler(extractContractHandler),
);

/**
 * POST /api/supplier-intelligence/match-supplier
 *
 * Fallback de IA para matching de proveedor cuando los modos locales del
 * frontend (exact / prefix / includes) fallan. JSON-only.
 */
router.post(
  "/match-supplier",
  matchLimiter,
  matchJsonParser,
  asyncHandler(matchSupplierHandler),
);

/**
 * POST /api/supplier-intelligence/generate-xlsx
 *
 * Recibe { shared_fields, rows[], catalog_prefill? } editados desde step 2 y
 * devuelve el xlsx final (clonando plantilla-agente-utopia.xlsx con N filas
 * escritas). Streaming friendly — el response es un buffer binario.
 */
router.post(
  "/generate-xlsx",
  generateLimiter,
  generateJsonParser,
  asyncHandler(generateXlsxHandler),
);

// Scoped error middleware — emits the `{ success: false, error: { code, message } }`
// envelope the product spec pins, without affecting the other routers.
router.use(supplierIntelligenceErrorHandler);

export default router;
