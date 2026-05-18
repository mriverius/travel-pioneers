import type { Request, Response } from "express";
import logger from "../../config/logger.js";
import ApiError from "../../utils/ApiError.js";
import {
  matchSupplierWithAI,
  matchServiceWithAI,
  type MatchCandidate,
  type ServiceCandidate,
} from "./supplierMatchService.js";

const MAX_QUERY_CHARS = 500;
const MAX_CANDIDATES = 600;
const MAX_NAME_CHARS = 200;

/**
 * Validación + coerción del body. La lista de candidatos viene del frontend
 * (que es dueño del catálogo), así que aquí solo verificamos shape y caps.
 */
function parseBody(raw: unknown): { query: string; candidates: MatchCandidate[] } {
  if (!raw || typeof raw !== "object") {
    throw ApiError.badRequest("El cuerpo del request debe ser JSON.");
  }
  const body = raw as Record<string, unknown>;

  const query = body.query;
  if (typeof query !== "string" || query.trim() === "") {
    throw ApiError.badRequest("Falta el campo 'query' (string no vacío).");
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw ApiError.badRequest(
      `'query' excede el largo máximo (${MAX_QUERY_CHARS} caracteres).`,
    );
  }

  const candidates = body.candidates;
  if (!Array.isArray(candidates)) {
    throw ApiError.badRequest("Falta el campo 'candidates' (array).");
  }
  if (candidates.length === 0) {
    throw ApiError.badRequest("La lista 'candidates' está vacía.");
  }
  if (candidates.length > MAX_CANDIDATES) {
    throw ApiError.badRequest(
      `Demasiados candidatos (${candidates.length}). Máximo: ${MAX_CANDIDATES}.`,
    );
  }

  const out: MatchCandidate[] = [];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const item = c as Record<string, unknown>;
    const codigo = typeof item.codigo === "string" ? item.codigo.trim() : "";
    const nombre = typeof item.nombre === "string" ? item.nombre.trim() : "";
    if (!codigo || !nombre) continue;
    out.push({
      codigo: codigo.slice(0, 100),
      nombre: nombre.slice(0, MAX_NAME_CHARS),
    });
  }
  if (out.length === 0) {
    throw ApiError.badRequest(
      "Ninguno de los 'candidates' tiene 'codigo' y 'nombre' válidos.",
    );
  }

  return { query: query.trim(), candidates: out };
}

/**
 * POST /api/supplier-intelligence/match-supplier
 *
 * Body JSON:
 *   {
 *     "query": "HOTEL PARADOR RESORT & SPA",
 *     "candidates": [{ "codigo": "PARADOR", "nombre": "PARADOR RESORT & SPA MANUEL ANTONIO" }, …]
 *   }
 *
 * Response (200):
 *   {
 *     "success": true,
 *     "data": { "codigo": "PARADOR" | null, "confidence": "alta"|"media"|"baja", "reasoning": "…" }
 *   }
 *
 * Pensado como **fallback** del matcher local del frontend — solo se llama
 * cuando los modos exact/prefix/includes locales fallan.
 */
export async function matchSupplierHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { query, candidates } = parseBody(req.body);

  logger.info("Supplier Intelligence AI match requested", {
    requestId: req.id,
    query: query.slice(0, 100),
    candidateCount: candidates.length,
  });

  const result = await matchSupplierWithAI(query, candidates, req.id);

  logger.info("Supplier Intelligence AI match resolved", {
    requestId: req.id,
    matchedCodigo: result.codigo,
    confidence: result.confidence,
  });

  res.status(200).json({ success: true, data: result });
}

/* -------------------------------------------------------------------------- */
/*                  POST /match-service — body validation + handler           */
/* -------------------------------------------------------------------------- */

// El contexto del servicio es más rico que el query de match-supplier
// (incluye product_names, categorías, meals, currency, país). 1500 chars
// son suficientes para ~10 product_names + 6 categorías + metadatos.
const MAX_CTX_CHARS = 1500;
const MAX_SERVICE_CANDIDATES = 200;
const MAX_DESCRIPCION_CHARS = 200;

/**
 * Valida y coacciona el body de `/match-service`. Igual que `parseBody` para
 * `/match-supplier` pero con dos diferencias:
 *   - El query se llama `contractContext` (es texto rico, no un nombre).
 *   - Cada candidato tiene `{ codigo, descripcion: string | null }` — la
 *     descripción es opcional (algunos servicios del maestro no la traen).
 */
function parseServiceBody(raw: unknown): {
  contractContext: string;
  candidates: ServiceCandidate[];
} {
  if (!raw || typeof raw !== "object") {
    throw ApiError.badRequest("El cuerpo del request debe ser JSON.");
  }
  const body = raw as Record<string, unknown>;

  const contractContext = body.contractContext;
  if (typeof contractContext !== "string" || contractContext.trim() === "") {
    throw ApiError.badRequest(
      "Falta el campo 'contractContext' (string no vacío).",
    );
  }
  if (contractContext.length > MAX_CTX_CHARS) {
    throw ApiError.badRequest(
      `'contractContext' excede el largo máximo (${MAX_CTX_CHARS} caracteres).`,
    );
  }

  const candidates = body.candidates;
  if (!Array.isArray(candidates)) {
    throw ApiError.badRequest("Falta el campo 'candidates' (array).");
  }
  if (candidates.length === 0) {
    throw ApiError.badRequest("La lista 'candidates' está vacía.");
  }
  if (candidates.length > MAX_SERVICE_CANDIDATES) {
    throw ApiError.badRequest(
      `Demasiados candidatos (${candidates.length}). Máximo: ${MAX_SERVICE_CANDIDATES}.`,
    );
  }

  const out: ServiceCandidate[] = [];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const item = c as Record<string, unknown>;
    const codigo = typeof item.codigo === "string" ? item.codigo.trim() : "";
    if (!codigo) continue;
    const rawDesc = item.descripcion;
    const descripcion =
      typeof rawDesc === "string" && rawDesc.trim() !== ""
        ? rawDesc.trim().slice(0, MAX_DESCRIPCION_CHARS)
        : null;
    out.push({
      codigo: codigo.slice(0, 100),
      descripcion,
    });
  }
  if (out.length === 0) {
    throw ApiError.badRequest(
      "Ninguno de los 'candidates' tiene 'codigo' válido.",
    );
  }

  return { contractContext: contractContext.trim(), candidates: out };
}

/**
 * POST /api/supplier-intelligence/match-service
 *
 * Body JSON:
 *   {
 *     "contractContext": "Tipo: Hospedaje · Hotel Parador · Tipo Unidad: N",
 *     "candidates": [
 *       { "codigo": "PARADOR-HO", "descripcion": "HOSPEDAJE" },
 *       { "codigo": "PARADOR-TR", "descripcion": "TRANSPORTE" }
 *     ]
 *   }
 *
 * Response (200):
 *   {
 *     "success": true,
 *     "data": { "codigo": "PARADOR-HO" | null, "confidence": "alta"|"media"|"baja", "reasoning": "…" }
 *   }
 *
 * Se invoca solo cuando el matcher local del frontend (`findServiceForSupplier`)
 * devuelve null y el proveedor tiene >1 servicio en lista-proveedores. Para
 * proveedores con 1 solo servicio nunca se llama (el local ya elige).
 */
export async function matchServiceHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { contractContext, candidates } = parseServiceBody(req.body);

  logger.info("Supplier Intelligence AI service match requested", {
    requestId: req.id,
    contextPreview: contractContext.slice(0, 100),
    candidateCount: candidates.length,
  });

  const result = await matchServiceWithAI(contractContext, candidates, req.id);

  logger.info("Supplier Intelligence AI service match resolved", {
    requestId: req.id,
    matchedCodigo: result.codigo,
    confidence: result.confidence,
  });

  res.status(200).json({ success: true, data: result });
}
