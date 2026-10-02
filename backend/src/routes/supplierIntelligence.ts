import { Router, json } from "express";
import rateLimit from "express-rate-limit";
import asyncHandler from "../utils/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";
import {
  analyzeBriefHandler,
  extractContractHandler,
  getExtractionStatusHandler,
  refineBriefHandler,
} from "../agents/supplier-intelligence/controller.js";
import {
  matchSupplierHandler,
  matchServiceHandler,
} from "../agents/supplier-intelligence/matchController.js";
import { generateXlsxHandler } from "../agents/supplier-intelligence/generateController.js";
import { refineTableHandler } from "../agents/supplier-intelligence/tableChatController.js";
import {
  contractRunQualityHandler,
  contractRunStatsHandler,
  lastContractRunForSupplierHandler,
  listContractRunsHandler,
  saveContractRunHandler,
} from "../agents/supplier-intelligence/contractsController.js";
import { supplierIntelligenceErrorHandler } from "../agents/supplier-intelligence/errorHandler.js";
import { handleContractUpload } from "../agents/supplier-intelligence/uploadMiddleware.js";
import { preScanHandler } from "../agents/supplier-intelligence/preScanController.js";
import {
  createEvalCaseHandler,
  deleteEvalCaseHandler,
  listEvalCasesHandler,
  runEvalsHandler,
} from "../agents/supplier-intelligence/evalController.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();

// Todas las rutas que llaman a Anthropic (o devuelven su resultado) exigen
// sesión: cada request cuesta dinero real. Antes sólo /contracts lo pedía.

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
/**
 * Polling de estado de extracción: el frontend encuesta cada ~3s mientras el
 * job corre (hasta 15 min), así que el cap debe holgar ese ritmo. 120/min deja
 * margen incluso con varios tabs.
 */
const extractStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: "Demasiadas consultas de estado. Intenta de nuevo en un minuto.",
    },
  },
});

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
 * Chat de correcciones del Paso 3: el body es la misma tabla que manda
 * `/generate-xlsx` (hasta 500 filas) más el mensaje del operador — mismo
 * cap de 4 MB.
 */
const refineTableJsonParser = json({ limit: "4mb" });

/**
 * Rate limit del chat de la tabla. Cada mensaje es una llamada a Opus, así
 * que es más estrecho que el de generate-xlsx (que no toca Anthropic) pero
 * suficiente para una conversación fluida: ~1 mensaje cada 2 segundos.
 */
const refineTableLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message:
        "Demasiadas correcciones seguidas. Esperá un minuto e intentá de nuevo.",
    },
  },
});

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
 * Pre-scan: barato (sin IA, ~ms), pero recibe el archivo completo, así que
 * lo limitamos por si alguien lo martilla.
 */
const preScanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: "RATE_LIMITED", message: "Demasiados análisis previos. Espera un momento." },
  },
});

/**
 * POST /api/supplier-intelligence/pre-scan
 *
 * Detección determinística del proveedor + datos regex + historial, sin
 * IA. Corre al soltar el archivo en el Paso 1. Ver `preScanService.ts`.
 */
router.post(
  "/pre-scan",
  requireAuth,
  preScanLimiter,
  handleContractUpload,
  asyncHandler(preScanHandler),
);

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
  requireAuth,
  extractLimiter,
  handleContractUpload,
  asyncHandler(extractContractHandler),
);

/**
 * GET /api/supplier-intelligence/extract/:jobId
 *
 * Encuesta el estado de un job de extracción arrancado por POST /extract.
 * Peticiones cortas → no dependen de timeouts de proxy para requests largas.
 */
router.get(
  "/extract/:jobId",
  requireAuth,
  extractStatusLimiter,
  asyncHandler(getExtractionStatusHandler),
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
  requireAuth,
  extractLimiter,
  handleContractUpload,
  asyncHandler(analyzeBriefHandler),
);

/**
 * POST /api/supplier-intelligence/refine-brief
 *
 * Re-análisis del brief tras correcciones en lenguaje natural (Paso 2).
 */
router.post(
  "/refine-brief",
  requireAuth,
  extractLimiter,
  handleContractUpload,
  asyncHandler(refineBriefHandler),
);

/**
 * POST /api/supplier-intelligence/match-supplier
 *
 * Fallback de IA para matching de proveedor cuando los modos locales del
 * frontend (exact / prefix / includes) fallan. JSON-only.
 */
router.post(
  "/match-supplier",
  requireAuth,
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
  requireAuth,
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
  requireAuth,
  generateLimiter,
  generateJsonParser,
  asyncHandler(generateXlsxHandler),
);

/**
 * POST /api/supplier-intelligence/refine-table
 *
 * Chat de correcciones "en caliente" del Paso 3. Recibe la tabla que el
 * operador está revisando + su pedido en lenguaje natural, y devuelve la
 * tabla corregida. JSON puro — a diferencia de `/refine-brief` NO re-sube los
 * documentos: el contexto es el JSON de la grilla, que es justo lo que el
 * operador quiere corregir.
 */
router.post(
  "/refine-table",
  requireAuth,
  refineTableLimiter,
  refineTableJsonParser,
  asyncHandler(refineTableHandler),
);

/**
 * POST /api/supplier-intelligence/contracts
 *
 * Persiste un run completo (tras una generación de xlsx exitosa). Auth
 * requerida — guardamos `processedById` para auditoría aunque la lectura
 * sea global. Idempotente por `extraction_id`: el frontend puede disparar
 * este POST en cada descarga del xlsx (Paso 3 y Paso 4) y el backend
 * hace upsert, así una extracción es exactamente un run.
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
  "/contracts/last",
  requireAuth,
  contractsReadLimiter,
  asyncHandler(lastContractRunForSupplierHandler),
);

router.get(
  "/contracts/stats",
  requireAuth,
  contractsReadLimiter,
  asyncHandler(contractRunStatsHandler),
);

router.get(
  "/contracts/quality",
  requireAuth,
  contractsReadLimiter,
  asyncHandler(contractRunQualityHandler),
);

/**
 * Casos de prueba del pre-scan (regresión determinística, sin IA).
 * Lectura para cualquier usuario autenticado; alta/baja/correr sólo admins.
 */
router.get("/evals", requireAuth, contractsReadLimiter, asyncHandler(listEvalCasesHandler));
router.post("/evals", requireAuth, requireAdmin, contractsWriteLimiter, handleContractUpload, asyncHandler(createEvalCaseHandler));
router.delete("/evals/:id", requireAuth, requireAdmin, contractsWriteLimiter, asyncHandler(deleteEvalCaseHandler));
router.post("/evals/run", requireAuth, requireAdmin, contractsWriteLimiter, contractsJsonParser, asyncHandler(runEvalsHandler));

// Scoped error middleware — emits the `{ success: false, error: { code, message } }`
// envelope the product spec pins, without affecting the other routers.
router.use(supplierIntelligenceErrorHandler);

export default router;
