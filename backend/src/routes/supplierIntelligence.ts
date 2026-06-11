import { Router, json } from "express";
import rateLimit from "express-rate-limit";
import asyncHandler from "../utils/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";
import {
  analyzeBriefHandler,
  extractContractHandler,
} from "../agents/supplier-intelligence/controller.js";
import {
  matchSupplierHandler,
  matchServiceHandler,
} from "../agents/supplier-intelligence/matchController.js";
import { generateXlsxHandler } from "../agents/supplier-intelligence/generateController.js";
import {
  contractRunStatsHandler,
  listContractRunsHandler,
  saveContractRunHandler,
} from "../agents/supplier-intelligence/contractsController.js";
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
 * Persistencia: misma envolvente que generate-xlsx (mismo payload + meta),
 * así que reutilizamos el mismo límite de 4 MB.
 */
const contractsJsonParser = json({ limit: "4mb" });

/**
 * Rate limit para escritura de runs: cada step 3 exitoso del usuario emite
 * exactamente uno; 60/min es holgado pero protege contra retries en bucle
 * si el frontend pierde la respuesta.
 */
const contractsWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { message: "Demasiadas escrituras de contratos. Intenta de nuevo en un minuto." },
  },
});

/**
 * Rate limit para lecturas (lista + stats): la pantalla de historial y los
 * widgets de la home pueden refrescar varias veces al minuto sin abusar.
 */
const contractsReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { message: "Demasiadas lecturas. Intenta de nuevo en un minuto." },
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

/**
 * POST /api/supplier-intelligence/analyze-brief
 *
 * Fase 1 standalone del flujo gated — corre solo el pre-análisis y devuelve
 * las Variables de Configuración para que el usuario las confirme antes de la
 * extracción completa. Mismo upload middleware y rate limit que /extract
 * (llama a Anthropic, aunque mucho más barato).
 */
router.post(
  "/analyze-brief",
  extractLimiter,
  handleContractUpload,
  asyncHandler(analyzeBriefHandler),
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
 * POST /api/supplier-intelligence/match-service
 *
 * Fallback de IA para elegir el `codigo_servicio` de un proveedor cuando el
 * matcher local del frontend (`findServiceForSupplier`) no resuelve por
 * ambigüedad. Reusa el mismo limiter y parser que `match-supplier` — son
 * llamadas equivalentes en costo y tamaño de payload.
 */
router.post(
  "/match-service",
  matchLimiter,
  matchJsonParser,
  asyncHandler(matchServiceHandler),
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

/**
 * POST /api/supplier-intelligence/contracts
 *
 * Persiste un run completo (tras una generación de xlsx exitosa). Auth
 * requerida — guardamos `processedById` para auditoría aunque la lectura
 * sea global. Idempotencia es responsabilidad del cliente: el frontend
 * dispara este POST una sola vez cuando el step 3 entra a phase="ready".
 *
 * GET  /api/supplier-intelligence/contracts
 * GET  /api/supplier-intelligence/contracts/stats
 *
 * Lectura global — cualquier usuario autenticado ve todos los runs y todos
 * los counters. El producto eligió este modelo explícitamente; revisar
 * antes de cambiarlo.
 */
router.post(
  "/contracts",
  requireAuth,
  contractsWriteLimiter,
  contractsJsonParser,
  asyncHandler(saveContractRunHandler),
);

router.get(
  "/contracts",
  requireAuth,
  contractsReadLimiter,
  asyncHandler(listContractRunsHandler),
);

router.get(
  "/contracts/stats",
  requireAuth,
  contractsReadLimiter,
  asyncHandler(contractRunStatsHandler),
);

// Scoped error middleware — emits the `{ success: false, error: { code, message } }`
// envelope the product spec pins, without affecting the other routers.
router.use(supplierIntelligenceErrorHandler);

export default router;
