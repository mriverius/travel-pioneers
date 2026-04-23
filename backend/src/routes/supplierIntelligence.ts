import { Router } from "express";
import rateLimit from "express-rate-limit";
import asyncHandler from "../utils/asyncHandler.js";
import { extractContractHandler } from "../agents/supplier-intelligence/controller.js";
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

// Scoped error middleware — emits the `{ success: false, error: { code, message } }`
// envelope the product spec pins, without affecting the other routers.
router.use(supplierIntelligenceErrorHandler);

export default router;
