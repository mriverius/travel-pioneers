import type { NextRequest } from "next/server";

/**
 * Proxy same-origin hacia el backend Express. En producción el browser llama
 * `/api/backend/...` en lugar de `*.railway.app` directo, evitando:
 *   - errores CORS engañosos cuando el proxy de Railway corta conexiones largas
 *   - preflight cross-origin en uploads multipart pesados
 *
 * `BACKEND_URL` (server-only) apunta al servicio Express en Railway.
 * Fallback: `NEXT_PUBLIC_API_URL` (típico en dev).
 */
const BACKEND_URL = (
  process.env.BACKEND_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:4000"
).replace(/\/$/, "");

/** Hasta 15 min — alineado con extract Opus y el timeout del backend. */
export const maxDuration = 900;

export const dynamic = "force-dynamic";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

async function proxyRequest(
  req: NextRequest,
  pathSegments: string[],
): Promise<Response> {
  const path = pathSegments.join("/");
  const search = req.nextUrl.search;
  const target = `${BACKEND_URL}/${path}${search}`;

  const headers = new Headers();
  for (const name of ["accept", "authorization", "content-type", "content-length"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
  };

  if (hasBody) {
    init.body = req.body;
    init.duplex = "half";
  }

  const upstream = await fetch(target, init);

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

type RouteContext = { params: Promise<{ path: string[] }> };

async function handle(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { path } = await ctx.params;
  return proxyRequest(req, path);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
