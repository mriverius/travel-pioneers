import type { Request, Response } from "express";
import logger from "../../config/logger.js";
import ApiError from "../../utils/ApiError.js";
import {
  matchSupplierWithAI,
  type MatchCandidate,
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
