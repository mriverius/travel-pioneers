import { Router, json } from "express";
import rateLimit from "express-rate-limit";
import asyncHandler from "../utils/asyncHandler.js";
import { extractContractHandler } from "../agents/supplier-intelligence/controller.js";
import { matchSupplierHandler } from "../agents/supplier-intelligence/matchController.js";
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
 * Cap de payload: 600 candidatos × ~250 bytes + overhead. 1 MB es holgado y
 * sigue siendo un límite duro contra requests basura.
 */
const matchJsonParser = json({ limit: "1mb" });

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

// Scoped error middleware — emits the `{ success: false, error: { code, message } }`
// envelope the product spec pins, without affecting the other routers.
router.use(supplierIntelligenceErrorHandler);

export default router;
