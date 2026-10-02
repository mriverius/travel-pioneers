/**
 * Thin fetch wrapper for the Travel Pioneers backend.
 *
 * - Base URL: en dev `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`).
 *   En producción el browser usa el proxy same-origin `/api/backend` (ver
 *   `src/app/api/backend/[...path]/route.ts`) para evitar CORS en extracciones
 *   largas; el proxy reenvía a `BACKEND_URL` en el servidor Next.js.
 * - Non-2xx responses are thrown as `ApiError` so callers can branch on
 *   status (409 email-taken, 400 validation, 401 bad credentials, …) and
 *   surface backend-provided messages without re-formatting them.
 * - Authenticated requests (`auth: true`) auto-attach the bearer token
 *   from localStorage. A 401 on an authenticated request clears the
 *   session so the AuthGuard kicks the user back to /login.
 */

const DEFAULT_API_URL = "http://localhost:4000";

/**
 * Base URL del backend. En el browser de producción usamos el proxy same-origin
 * (`/api/backend`) para evitar CORS y cortes de conexión cross-origin en
 * `/extract` y otros uploads largos. En localhost seguimos yendo directo al
 * puerto 4000 (CORS ya está configurado en el backend).
 */
function getApiBaseUrl(): string {
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host !== "localhost" && host !== "127.0.0.1") {
      return "/api/backend";
    }
  }
  return (
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? DEFAULT_API_URL
  );
}

export interface ValidationDetail {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly details: ValidationDetail[];
  /** Machine-readable code from the new envelope, when available. */
  readonly code: string | null;

  constructor(
    status: number,
    message: string,
    details: ValidationDetail[] = [],
    code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

interface BackendErrorShape {
  // Auth / users routes: `{ error: { message, details? } }`
  // Supplier Intelligence route: `{ success: false, error: { code, message, details? } }`
  // The `error.message` field is shared across both, so one parser handles
  // both envelopes — we just read `code` when it's present.
  success?: boolean;
  error?: {
    message?: string;
    code?: string;
    details?: unknown;
  };
}

function parseDetails(raw: unknown): ValidationDetail[] {
  if (!Array.isArray(raw)) return [];
  const out: ValidationDetail[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      "field" in item &&
      "message" in item &&
      typeof (item as { field: unknown }).field === "string" &&
      typeof (item as { message: unknown }).message === "string"
    ) {
      out.push({
        field: (item as { field: string }).field,
        message: (item as { message: string }).message,
      });
    }
  }
  return out;
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** Attach the persisted bearer token. Defaults to false. */
  auth?: boolean;
  /**
   * Client-side timeout in milliseconds. When the timer fires the underlying
   * `fetch` is aborted via `AbortController` and the promise rejects with an
   * `ApiError(408)` so callers can branch on it the same way they branch on
   * backend errors. Defaults to no timeout (long-running uploads handle this
   * per-call — e.g. `supplierIntelligence.extract` overrides to 6 minutes).
   */
  timeoutMs?: number;
}

/**
 * Default UX message for client-side timeouts. Kept in Spanish to match the
 * rest of the user-facing error copy.
 */
const CLIENT_TIMEOUT_MESSAGE =
  "La solicitud tardó demasiado. Intenta de nuevo o usa un archivo más pequeño.";

const NETWORK_FAILURE_MESSAGE =
  "La conexión con el servidor se interrumpió durante la extracción. " +
  "Los contratos extensos pueden tardar varios minutos — mantené esta pestaña abierta e intentá de nuevo.";

/**
 * Convierte errores de red (Failed to fetch, etc.) en mensajes accionables.
 * Los `ApiError` del backend pasan con su mensaje original.
 */
export function describeRequestFailure(
  err: unknown,
  fallback: string,
): string {
  if (err instanceof ApiError) return err.message;
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    if (err.name === "AbortError") return CLIENT_TIMEOUT_MESSAGE;
    if (err.name === "NotReadableError") {
      return (
        "No se pudo leer uno de los archivos cargados. " +
        "Volvé al Paso 1 y seleccioná los documentos de nuevo."
      );
    }
    if (err.message.trim()) return err.message;
    return NETWORK_FAILURE_MESSAGE;
  }
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    if (
      m.includes("failed to fetch") ||
      m.includes("networkerror") ||
      m.includes("network error") ||
      m.includes("load failed") ||
      m.includes("network request failed") ||
      m.includes("terminated") ||
      m.includes("aborted")
    ) {
      return NETWORK_FAILURE_MESSAGE;
    }
    if (m.includes("could not be read") || m.includes("notreadable")) {
      return (
        "No se pudo leer uno de los archivos cargados. " +
        "Volvé al Paso 1 y seleccioná los documentos de nuevo."
      );
    }
    if (err.message.trim()) return err.message;
  }
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}

/**
 * Wire an `AbortSignal` that fires after `timeoutMs`. Returns the signal plus
 * a cleanup function the caller must invoke once the request settles so the
 * timer is never leaked. If the caller already provided a signal, the two are
 * combined so external aborts still propagate.
 */
function makeTimeoutSignal(
  timeoutMs: number | undefined,
  external: AbortSignal | null | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void; timedOutRef: { current: boolean } } {
  const timedOutRef = { current: false };
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal: external ?? undefined, cleanup: () => {}, timedOutRef };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOutRef.current = true;
    controller.abort();
  }, timeoutMs);
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
    timedOutRef,
  };
}

async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
  const { body, headers, auth: authed = false, timeoutMs, signal: externalSignal, ...rest } = init;

  const finalHeaders: Record<string, string> = {
    Accept: "application/json",
    ...(headers as Record<string, string> | undefined),
  };
  if (body !== undefined) {
    finalHeaders["Content-Type"] = "application/json";
  }
  if (authed) {
    const token = getSession()?.token;
    if (token) {
      finalHeaders.Authorization = `Bearer ${token}`;
    }
  }

  const { signal, cleanup, timedOutRef } = makeTimeoutSignal(
    timeoutMs,
    externalSignal,
  );

  let res: Response;
  try {
    res = await fetch(`${getApiBaseUrl()}${path}`, {
      ...rest,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (timedOutRef.current) {
      throw new ApiError(408, CLIENT_TIMEOUT_MESSAGE, [], "client_timeout");
    }
    throw err;
  } finally {
    cleanup();
  }

  // 204 No Content → nothing to parse.
  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  const payload: unknown = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    // If we hit 401 on an authenticated call the token is no longer valid
    // (expired, revoked, or the user was deleted). Drop the local session
    // so AuthGuard redirects to /login.
    if (res.status === 401 && authed) {
      clearSession();
    }
    const err = (payload ?? {}) as BackendErrorShape;
    const message =
      err.error?.message ??
      (res.status >= 500
        ? "Se produjo un error en el servidor. Intenta más tarde."
        : "La solicitud no pudo completarse.");
    throw new ApiError(
      res.status,
      message,
      parseDetails(err.error?.details),
      err.error?.code ?? null,
    );
  }

  return payload as T;
}

/**
 * Multipart sibling of `request()` for uploads. Uses the same error-envelope
 * parser so both `{ error: { message } }` (auth/users) and
 * `{ success: false, error: { code, message } }` (supplier-intelligence)
 * surface as a consistent `ApiError` to callers.
 *
 * Never sets `Content-Type` manually — fetch does it automatically with the
 * right multipart boundary when given a `FormData` body.
 */
async function requestForm<T>(
  path: string,
  form: FormData,
  init: Omit<RequestInit, "body" | "method"> & {
    auth?: boolean;
    /** See `RequestOptions.timeoutMs`. */
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const {
    headers,
    auth: authed = false,
    timeoutMs,
    signal: externalSignal,
    ...rest
  } = init;

  const finalHeaders: Record<string, string> = {
    Accept: "application/json",
    ...(headers as Record<string, string> | undefined),
  };
  if (authed) {
    const token = getSession()?.token;
    if (token) {
      finalHeaders.Authorization = `Bearer ${token}`;
    }
  }

  const { signal, cleanup, timedOutRef } = makeTimeoutSignal(
    timeoutMs,
    externalSignal,
  );

  let res: Response;
  try {
    res = await fetch(`${getApiBaseUrl()}${path}`, {
      ...rest,
      method: "POST",
      headers: finalHeaders,
      body: form,
      signal,
    });
  } catch (err) {
    if (timedOutRef.current) {
      throw new ApiError(408, CLIENT_TIMEOUT_MESSAGE, [], "client_timeout");
    }
    throw err;
  } finally {
    cleanup();
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  const payload: unknown = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    if (res.status === 401 && authed) {
      clearSession();
    }
    const err = (payload ?? {}) as BackendErrorShape;
    const message =
      err.error?.message ??
      (res.status >= 500
        ? "Se produjo un error en el servidor. Intenta más tarde."
        : "La solicitud no pudo completarse.");
    throw new ApiError(
      res.status,
      message,
      parseDetails(err.error?.details),
      err.error?.code ?? null,
    );
  }

  return payload as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Variante de `request()` para endpoints que devuelven binario (xlsx, pdf,
 * zip). Mismo manejo de errores (lee el body como JSON cuando 4xx/5xx para
 * extraer el message del envelope), pero el success path devuelve
 * `{ blob, filename }` — filename viene del header Content-Disposition
 * cuando está presente, sino del fallback que pasa el caller.
 */
async function requestBlob(
  path: string,
  init: RequestOptions,
  fallbackFilename: string,
): Promise<{ blob: Blob; filename: string }> {
  const {
    body,
    headers,
    auth: authed = false,
    timeoutMs,
    signal: externalSignal,
    ...rest
  } = init;

  const finalHeaders: Record<string, string> = {
    Accept: "application/octet-stream, */*",
    ...(headers as Record<string, string> | undefined),
  };
  if (body !== undefined) {
    finalHeaders["Content-Type"] = "application/json";
  }
  if (authed) {
    const token = getSession()?.token;
    if (token) {
      finalHeaders.Authorization = `Bearer ${token}`;
    }
  }

  const { signal, cleanup, timedOutRef } = makeTimeoutSignal(
    timeoutMs,
    externalSignal,
  );

  let res: Response;
  try {
    res = await fetch(`${getApiBaseUrl()}${path}`, {
      ...rest,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (timedOutRef.current) {
      throw new ApiError(408, CLIENT_TIMEOUT_MESSAGE, [], "client_timeout");
    }
    throw err;
  } finally {
    cleanup();
  }

  if (!res.ok) {
    if (res.status === 401 && authed) clearSession();
    // Error responses están en JSON — leer el text y parsear normal.
    const text = await res.text();
    const payload = text ? (safeJsonParse(text) as BackendErrorShape) : null;
    const message =
      payload?.error?.message ??
      (res.status >= 500
        ? "Se produjo un error en el servidor. Intenta más tarde."
        : "La descarga no pudo completarse.");
    throw new ApiError(
      res.status,
      message,
      parseDetails(payload?.error?.details),
      payload?.error?.code ?? null,
    );
  }

  const blob = await res.blob();

  // Content-Disposition: attachment; filename="..."
  const disposition = res.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
  const filename = filenameMatch?.[1]?.trim() ?? fallbackFilename;

  return { blob, filename };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Arranca la extracción como job asíncrono y encuesta su estado hasta que
 * termina. Cada request es corto, así que NINGUNA conexión queda abierta los
 * varios minutos que tarda la extracción Opus — eso evita que los proxies
 * intermedios (edge de Railway, Next.js) corten la conexión y devuelvan
 * errores engañosos (CORS / 5xx) en medio de una extracción que en realidad
 * sigue corriendo bien en el backend.
 *
 * Devuelve exactamente la misma forma que la antigua llamada síncrona
 * (`ExtractContractResponse`), así el resto del flujo no cambia.
 */
async function startAndPollExtraction(
  form: FormData,
): Promise<ExtractContractResponse> {
  // 1) Arranca el job. Es solo el upload + arranque → 3 min holgan de sobra.
  const start = await requestForm<ExtractJobStartResponse>(
    "/api/supplier-intelligence/extract",
    form,
    { auth: true, timeoutMs: 3 * 60 * 1000 },
  );
  const jobId = start.job_id;
  if (!jobId) {
    throw new ApiError(
      500,
      "El servidor no devolvió un identificador de extracción. Intenta de nuevo.",
      [],
      "no_job_id",
    );
  }

  // 2) Encuesta el estado cada POLL_INTERVAL_MS hasta done/error o deadline.
  // MAX_WAIT_MS tiene que ser MAYOR que el techo del backend (25 min por
  // pasada del SDK de Anthropic — ver `anthropicClient.ts`): si el cliente
  // se rinde antes que el backend, el job puede terminar bien en el servidor
  // y el usuario ver un timeout falso. Contratos muy grandes (60+ páginas,
  // decenas de filas) pueden tardar 15-25 min de streaming Opus.
  const POLL_INTERVAL_MS = 3000;
  const MAX_WAIT_MS = 30 * 60 * 1000;
  const MAX_CONSECUTIVE_FAILURES = 6;
  const deadline = Date.now() + MAX_WAIT_MS;
  let consecutiveFailures = 0;

  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    if (Date.now() > deadline) {
      throw new ApiError(408, CLIENT_TIMEOUT_MESSAGE, [], "client_timeout");
    }

    let status: ExtractStatusResponse;
    try {
      status = await request<ExtractStatusResponse>(
        `/api/supplier-intelligence/extract/${encodeURIComponent(jobId)}`,
        { timeoutMs: 30 * 1000, auth: true },
      );
      consecutiveFailures = 0;
    } catch (err) {
      // Un error con `code` del backend (job falló, 404 expirado, etc.) es
      // terminal → propaga. Los blips de red / timeouts del propio poll /
      // 5xx de proxy (sin envolvente) son transitorios → reintenta unas
      // cuantas veces antes de rendirse.
      const isTerminal =
        err instanceof ApiError &&
        err.code !== null &&
        err.code !== "client_timeout";
      if (isTerminal) throw err;
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw err;
      continue;
    }

    if (status.status === "done") {
      if (!status.data || !status.validation || !status.meta) {
        throw new ApiError(
          500,
          "La extracción terminó pero el servidor devolvió una respuesta incompleta. Intenta de nuevo.",
          [],
          "incomplete_result",
        );
      }
      return {
        success: true,
        data: status.data,
        validation: status.validation,
        meta: status.meta,
      };
    }
    // status === "processing" → seguir encuestando.
  }
}

/* ------------------------------ auth endpoints ---------------------------- */

export type Role = "admin" | "member";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  views: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AuthResponse {
  user: AuthUser;
  token: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

/* ------------------------------ users endpoints --------------------------- */

export interface ManagedUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  views: string[];
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserPayload {
  name: string;
  email: string;
  role?: Role;
  views?: string[];
}

export interface UpdateUserPayload {
  name?: string;
  role?: Role;
  views?: string[];
}

export interface CreateUserResponse {
  user: ManagedUser;
  /** One-time generated password. Show once and discard. */
  tempPassword: string;
}

/* ------------------------------ suppliers ------------------------------- */

/**
 * Maestro de proveedores ("lista-proveedores"), servido por el backend desde
 * la DB. Antes era un .ts generado en build desde un xlsx; ahora los admins
 * lo administran desde /suppliers y el agente lo consume vía
 * `supplierLookup.ts` (cache en memoria por sesión).
 */
export interface CatalogService {
  id?: string;
  /** Código de servicio del maestro (columna "Servicio"). */
  codigo: string;
  /** Descripción libre del servicio (columna "Descripción"). */
  descripcion: string | null;
  /**
   * Actividad / zona propias del servicio (en el xlsx vienen por fila).
   * `null` → usar las del proveedor. Prefill: servicio ?? proveedor.
   */
  actividad?: string | null;
  zona?: string | null;
}

export interface CatalogSupplier {
  id: string;
  /** Código corto del proveedor en el maestro (columna "proveedor"). */
  codigo: string;
  /** Nombre comercial visible (columna "Nombre"). */
  nombre: string | null;
  /** Tipo de actividad (columna "Actividad"). */
  actividad: string | null;
  /** Zona/destino turístico (columna "Zona"). */
  zona: string | null;
  /**
   * Servicios del proveedor — un proveedor tiene N servicios. Vacío cuando
   * el proveedor viene de `list({ summary: true })`; usa `serviceCount` para
   * el conteo y `api.suppliers.get(id)` para traerlos.
   */
  servicios: CatalogService[];
  serviceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierServiceInput {
  codigo: string;
  descripcion?: string | null;
  actividad?: string | null;
  zona?: string | null;
}

export interface CreateSupplierPayload {
  codigo: string;
  nombre?: string | null;
  actividad?: string | null;
  zona?: string | null;
  servicios?: SupplierServiceInput[];
}

export type UpdateSupplierPayload = Partial<
  Pick<CreateSupplierPayload, "codigo" | "nombre" | "actividad" | "zona">
>;

/* ------------------------------- pre-scan -------------------------------- */

/**
 * Resultado de `POST /api/supplier-intelligence/pre-scan`: análisis
 * determinístico (sin IA) del contrato recién subido. Ver backend
 * `preScanService.ts` para el detalle de cada señal.
 */
export type PreScanConfidence = "alta" | "media" | "ninguna";

export interface PreScanCandidate {
  id: string;
  codigo: string;
  nombre: string | null;
  actividad: string | null;
  zona: string | null;
  serviceCount: number;
  score: number;
  reasons: string[];
}

export interface PreScanFacts {
  cedulas: string[];
  ibans: string[];
  emails: string[];
  phones: string[];
  currencies: string[];
  /** ISO YYYY-MM-DD, en orden de aparición. */
  dates: string[];
  yearRange: { min: number; max: number } | null;
}

export interface PreScanPreviousRun {
  id: string;
  processedAt: string;
  filename: string;
  cedula: string | null;
  numero_cuenta: string | null;
  banco: string | null;
  tipo_moneda: string | null;
  contract_starts: string | null;
  contract_ends: string | null;
  reservations_email: string | null;
}

export interface PreScanSeason {
  name: string | null;
  /** MM-DD, sin año. */
  ranges: { start: string; end: string }[];
}

export interface PreScanBankAccount {
  bank: string | null;
  currency: string | null;
  accountNumber: string | null;
  iban: string | null;
}

export interface PreScanTerm {
  daysBefore: number | null;
  percent: number | null;
  season: string | null;
  sentence: string;
}

export interface PreScanSection {
  key: string;
  title: string;
  text: string;
}

export interface PreScanInferences {
  legalName: string | null;
  address: string | null;
  website: string | null;
  checkIn: string | null;
  checkOut: string | null;
  meals: string[];
  paymentTerms: PreScanTerm[];
  cancellationTerms: PreScanTerm[];
  childTerms: string[];
  bankAccounts: PreScanBankAccount[];
  sections: PreScanSection[];
  estimatedProducts: number | null;
  country: { value: string; reasons: string[] } | null;
  validity: { start: string; end: string; source: "explicit" | "year" } | null;
  taxes: { included: boolean | null; percent: number | null; snippet: string } | null;
  commission: { net: boolean; percent: number | null; snippet: string } | null;
  rateBasis: string[];
  occupancies: string[];
  seasons: PreScanSeason[];
  minNights: number | null;
  childPolicy: string | null;
  cancellationPolicy: string | null;
  paymentPolicy: string | null;
  prices: number[];
  priceMentions: number;
  productHints: string[];
}

export interface PreScanDocument {
  filename: string;
  kind: ContractFileKind;
  role: "primary" | "secondary";
  textAvailable: boolean;
  pages: { scanned: number; total: number } | null;
  chars: number;
  /** "72 precios", "2 temporadas", "cancelación", "IBAN"… */
  contributes: string[];
  /** Temporadas leídas en ESTE documento (para resolver conflictos entre documentos). */
  seasons: PreScanSeason[];
  /**
   * Mapa de páginas: dónde están tarifas, políticas, bancos… Se envía al
   * modelo (lectura dirigida) y lo usa el revisor.
   */
  pageMap: PreScanPage[];
  supplierHint: { codigo: string; nombre: string | null; confidence: PreScanConfidence } | null;
}

export interface PreScanPage {
  page: number;
  /** Montos con símbolo de moneda en la página. */
  prices: number;
  /** tarifas, temporadas, cancelación, pago, banco, niños, contacto, check-in/out, legal, políticas. */
  topics: string[];
}

export interface PreScanResult {
  filename: string;
  kind: ContractFileKind;
  /** false para imágenes y PDFs escaneados (sin capa de texto). */
  textAvailable: boolean;
  pages: { scanned: number; total: number } | null;
  chars: number;
  /** Todos los adjuntos (primario primero) y qué aportó cada uno. */
  documents: PreScanDocument[];
  crossDocumentWarnings: string[];
  supplier: { confidence: PreScanConfidence; candidates: PreScanCandidate[] };
  facts: PreScanFacts;
  inferences: PreScanInferences;
  previous: { runs: PreScanPreviousRun[]; warnings: string[] } | null;
  durationMs: number;
}

/* ---------------------------- supplier memory ----------------------------- */

/**
 * Memoria explícita del proveedor: lo que el revisor humano APROBÓ la última
 * vez que se procesó un contrato de este proveedor (Paso 3 → `POST
 * /contracts`). No es "lo que dijo el pre-scan" ni "lo que dijo la IA": son
 * valores confirmados. Se muestra en el Paso 2 como referencia y viaja al
 * modelo como contexto de PRIORIDAD MEDIA (el documento actual manda).
 */
export interface SupplierMemory {
  runId: string;
  processedAt: string;
  filename: string;
  shared: Record<string, string | null>;
  manual: Record<string, unknown> | null;
  products: string[];
  seasons: { name: string | null; starts: string | null; ends: string | null }[];
  occupancies: string[];
  codigosServicio: string[];
  rowCount: number;
}

/* ------------------------------ agent rules ------------------------------- */

/**
 * Reglas permanentes de la agencia ("memoria curada"). Texto libre que se
 * inyecta en CADA extracción con PRIORIDAD ALTA (debajo de los comentarios
 * del run, encima del documento). Las administran los admins en /agent-rules.
 */
export interface AgentRule {
  id: string;
  text: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Sugerencia de regla derivada de correcciones recurrentes (misma
 * corrección en ≥2 contratos de proveedores distintos). El sistema propone;
 * un admin acepta (crea la regla) o descarta.
 */
export interface AgentRuleSuggestion {
  id: string;
  field: string;
  before: string | null;
  after: string | null;
  occurrences: number;
  evidence: { suppliers: string[]; runs: number };
  proposedText: string;
  status: "pending" | "accepted" | "dismissed" | string;
  ruleId: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------ run feedback ------------------------------ */

/**
 * Señal de aprendizaje del run — mirrors backend `feedback.ts`. La construye
 * el frontend al aprobar: diferencia entre lo propuesto (pre-scan, IA) y lo
 * aprobado por la persona, más los hallazgos del QA y las respuestas.
 */
export interface RunCorrection {
  scope: "brief" | "shared" | "row";
  field: string;
  row?: number;
  before: string | null;
  after: string | null;
  source: "user" | "prescan";
}

export interface RunFeedback {
  version: 1;
  pre_scan: {
    ran: boolean;
    text_available: boolean;
    documents: number;
    detected: { codigo: string; confidence: PreScanConfidence } | null;
    chosen: string | null;
    supplier_hit: boolean | null;
  } | null;
  brief: {
    corrections: RunCorrection[];
    prescan_filled: string[];
    qa_findings: { id: string; severity: "error" | "warning" | "info"; topic: string }[];
    questions: { id: string; topic: string; required: boolean; answer: string }[];
    chat_messages: number;
  } | null;
  rows: {
    total: number;
    added: number;
    removed: number;
    corrections: RunCorrection[];
    qa_findings: { id: string; severity: "error" | "warning" | "info"; topic: string }[];
    acknowledged_errors: boolean;
    chat_messages: number;
  };
  comments_chars: number;
  agency_rules: number;
}

/** Agregado del panel de calidad — mirrors backend `QualityReport`. */
export interface QualityReport {
  range: string;
  runs: number;
  runs_with_feedback: number;
  pre_scan: {
    with_text: number;
    comparable: number;
    supplier_hits: number;
    by_confidence: Record<string, { hits: number; total: number }>;
  };
  brief: {
    runs: number;
    user_corrections: number;
    prescan_fills: number;
    questions_asked: number;
    answered_doc: number;
    answered_ai: number;
    answered_other: number;
    skipped: number;
    chat_messages: number;
    top_fields: { field: string; count: number }[];
    top_findings: { id: string; severity: string; count: number }[];
  };
  rows: {
    runs: number;
    total_rows: number;
    corrected_cells: number;
    rows_added: number;
    rows_removed: number;
    runs_with_errors_acknowledged: number;
    chat_messages: number;
    top_fields: { field: string; count: number }[];
    top_findings: { id: string; severity: string; count: number }[];
  };
  recurring: {
    scope: "brief" | "shared" | "row";
    field: string;
    before: string | null;
    after: string | null;
    runs: number;
    suppliers: string[];
  }[];
}

/* ------------------------------- eval cases ------------------------------- */

export interface EvalCheck {
  name: string;
  ok: boolean;
  expected: unknown;
  actual: unknown;
}

export interface EvalCaseResult {
  slug: string;
  title: string;
  source: "repo" | "db";
  checks: EvalCheck[];
  ms: number;
  error?: string;
}

export interface EvalCase {
  id: string | null;
  slug: string;
  title: string;
  source: "repo" | "db";
  supplierCodigo: string | null;
  layoutFamily: string | null;
  notes: string | null;
  files: { filename: string; kind: string; size: number }[];
  expected: Record<string, unknown>;
  createdAt: string | null;
  lastResult: { ok: boolean; passed: number; failed: number; ranAt: string; error?: string } | null;
}

export interface EvalRunSummary {
  id: string;
  ranAt: string;
  totalCases: number;
  totalChecks: number;
  failedChecks: number;
  ms?: number;
}

export interface CreateEvalCaseInput {
  title: string;
  supplierCodigo?: string | null;
  layoutFamily?: string | null;
  notes?: string | null;
  expected: Record<string, unknown>;
}

/* --------------------- supplier-intelligence endpoints -------------------- */

export type ExtractionConfianza = "alta" | "media" | "baja";

export type ExtractionTipoUnidad = "N" | "S";

/** Source page for an extracted field: page number, "inferido", or "multiple". */
export type ExtractionSourcePage = string | number;

/**
 * Datos que aparecen una sola vez en el contrato (proveedor, vigencia,
 * clasificación de catálogo, bancos). Se replican en cada fila del xlsx.
 * Mirrors the backend `SharedFields` interface one-to-one.
 */
export interface ExtractedSharedFields {
  fecha: string | null;
  proveedor: string | null;
  nombre_comercial: string | null;
  cedula: string | null;
  direccion: string | null;
  telefono: string | null;
  pais: string | null;
  state_province: string | null;
  type_of_business: string | null;
  contract_starts: string | null;
  contract_ends: string | null;
  reservations_email: string | null;
  tipo_unidad: ExtractionTipoUnidad | null;
  tipo_servicio: string | null;
  tipo_moneda: string | null;
  numero_cuenta: string | null;
  banco: string | null;
  /**
   * Columna AK — "OTHERS IN PAYMENT OR CANCELLATION". Reglas de pago/
   * cancelación de PERIODOS ESPECIALES (Navidad, Semana Santa, fechas pico).
   * Antes era manual; ahora la IA la extrae y el writer la replica en cada
   * fila (columna AK).
   */
  others_payment_cancel: string | null;
  /**
   * Columna BA — "NOTAS". Cláusulas globales del contrato que no
   * encajan en ninguna otra columna (restricciones de edad, requisitos
   * de booking, alérgenos, condiciones especiales, etc.). El backend
   * la trata como shared (mismo valor en cada fila) y la escribe a la
   * columna BA del xlsx.
   */
  notes: string | null;
}

/**
 * Una fila del xlsx — una combinación product × season. Las políticas viven
 * aquí porque pueden variar por temporada; cuando no varían, la UI las
 * colapsa visualmente en "Igual en todas las filas".
 */
export interface ExtractedContractRow {
  product_name: string | null;
  categoria: string | null;
  /**
   * Override por fila del tipo_servicio shared (Bug #1 / #5). Permite
   * que un mismo contrato mezcle hotel + tours en filas distintas.
   */
  tipo_servicio: string | null;
  /** Override por fila del tipo_unidad shared. */
  tipo_unidad: ExtractionTipoUnidad | null;
  /**
   * Código corto por fila para columna N (Bug #2). Antes era único por
   * contrato y producía "MASTER" para todo; ahora la IA lo deriva del
   * nombre del producto de cada fila.
   */
  codigo_servicio: string | null;
  ocupacion: string | null;
  season_name: string | null;
  season_starts: string | null;
  season_ends: string | null;
  meals_included: string | null;
  precios_neto_iva: string | null;
  precio_rack_iva: string | null;
  porcentaje_comision: string | null;
  precios_neto_iva_fds: string | null;
  precio_rack_iva_fds: string | null;
  porcentaje_comision_fds: string | null;
  cancellation_policy: string | null;
  range_payment_policy: string | null;
  kids_policy: string | null;
  other_included: string | null;
  feeds_adicionales: string | null;
}

export type ExtractedSharedFieldKey = keyof ExtractedSharedFields;
export type ExtractedRowFieldKey = keyof ExtractedContractRow;

/**
 * Resultado de la extracción IA. Mirrors backend `ExtractedContract`.
 * Calibrated contra Parador 2026 con 21 filas (7 categorías × 3 temporadas).
 */
export interface ExtractedContract {
  shared_fields: ExtractedSharedFields;
  rows: ExtractedContractRow[];
  confianza: ExtractionConfianza;
  campos_faltantes: string[];
  /** Map of shared-field key -> source page. */
  paginas_origen_shared: Record<string, ExtractionSourcePage>;
  /** Per-row source pages, parallel to `rows`. */
  paginas_origen_rows: Record<string, ExtractionSourcePage>[];
}

export interface ExtractionValidation {
  valid: boolean;
  warnings: string[];
}

export interface ExtractionMeta {
  filename: string;
  size_bytes: number;
  model: string;
  processed_at: string;
  /**
   * Whether the user marked this as an existing supplier in step 1. Echoed
   * back from the request so the UI can keep the flag visible alongside the
   * extracted data.
   */
  is_existing_supplier?: boolean;
  /**
   * Token usage real reportado por Anthropic + costo estimado en USD a
   * los precios actuales del modelo. El frontend reenvía estos valores en
   * el `saveRun` para que queden en el historial.
   * Opcionales por compat con backends viejos que aún no los emitan.
   */
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  /**
   * Prefill de cuentas bancarias 2 y 3 derivado del brief (Fase 1). La cuenta
   * primaria ya viene en `data.shared_fields`; estas son las extra que el
   * frontend usa para pre-llenar los campos manuales de Step 2. `null` cuando
   * el contrato tiene una sola cuenta.
   */
  manual_prefill?: ManualBankPrefill | null;
  /**
   * Idempotency key for this extraction, generated client-side the moment
   * the extract response lands (one UUID per Paso 3 result). Every xlsx
   * download of this extraction sends it in `saveRun`, and the backend
   * upserts on it — so one extraction is exactly one history row no matter
   * how many times it is downloaded.
   */
  extraction_id?: string;
}

export interface ManualBankPrefill {
  cuenta_bancaria_2: string | null;
  banco_2: string | null;
  moneda_2: string | null;
  cuenta_bancaria_3: string | null;
  banco_3: string | null;
  moneda_3: string | null;
  /** cond_credito (col AP): "1"=CONTADO, "2"=CRÉDITO, "3"=PREPAGO. */
  cond_credito: string | null;
  /** plazo (col AQ): días de crédito o detalle del prepago. */
  plazo: string | null;
}

export interface ExtractContractResponse {
  success: true;
  data: ExtractedContract;
  validation: ExtractionValidation;
  meta: ExtractionMeta;
}

/** Respuesta de POST /extract: arranca el job y devuelve su id. */
interface ExtractJobStartResponse {
  success: true;
  job_id: string;
}

/** Respuesta de GET /extract/:jobId mientras el job corre o al terminar. */
interface ExtractStatusResponse {
  success?: boolean;
  status: "processing" | "done";
  data?: ExtractedContract;
  validation?: ExtractionValidation;
  meta?: ExtractionMeta;
}

export interface ExtractContractInput {
  /**
   * Optional free-form context the user pastes from the email body — extra
   * info that may not be in the document itself. Forwarded to Claude as
   * additional context.
   */
  comments?: string;
  /** Required toggle from step 1 — `true` if the supplier already exists. */
  isExistingSupplier: boolean;
  /**
   * Hechos verificados (pre-scan sin IA + proveedor confirmado) que el
   * backend inyecta en el prompt como anclas. Ver `buildPreScanHints`.
   */
  preScanHints?: Record<string, unknown> | null;
  /**
   * Variables de Configuración confirmadas por el usuario en el step gated
   * (entre upload y review). Cuando vienen, el backend SALTA la Fase 1 y usa
   * estas reglas globales (IVA, comisión, temporadas, bancos) para la
   * extracción — así una corrección del usuario se propaga a todas las filas.
   */
  confirmedConfig?: ContractConfigVariables | null;
  /**
   * Variables de Configuración confirmadas, UNA por documento (flujo
   * multi-documento). Cuando viene con >1 entrada, el backend renderiza un
   * brief por documento e instruye al modelo a consolidarlos en un solo
   * conjunto de filas. Tiene prioridad sobre `confirmedConfig`.
   */
  confirmedConfigs?: ContractConfigVariables[] | null;
}

/* --- analyze-brief (Fase 1 gated — Variables de Configuración) --- */

/** Una cuenta bancaria del contrato. Mirrors backend ContractBriefBankAccount. */
export interface ConfigBankAccount {
  bank: string | null;
  account_number: string | null;
  currency: string | null;
  swift: string | null;
  note: string | null;
}

/** Tarifa por persona adicional. Mirrors backend ContractBriefAdditionalPerson. */
export interface ConfigAdditionalPerson {
  scope: string | null;
  applies_to: string | null;
  rack: string | null;
  net: string | null;
}

/** Temporada con fechas. Mirrors backend ContractBriefSeason. */
export interface ConfigSeason {
  name: string | null;
  starts: string | null;
  ends: string | null;
  raw_range: string | null;
}

/** Plan de filas estimado. Mirrors backend ContractBriefRowPlan. */
export interface ConfigRowPlan {
  categories: string[];
  occupancies_per_category: number | null;
  seasons_count: number | null;
  expected_rows: number | null;
}

/** Mensaje del chat de refinamiento del brief. */
export interface BriefChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Identidad / vigencia del proveedor — datos IGUALES en todas las filas.
 * Mirrors backend ContractBriefSharedFields. El usuario los confirma en Step 2
 * y sobreescriben lo que la extracción infiera.
 */
export interface ConfigSharedFields {
  proveedor: string | null;
  nombre_comercial: string | null;
  cedula: string | null;
  type_of_business: string | null;
  direccion: string | null;
  telefono: string | null;
  pais: string | null;
  state_province: string | null;
  reservations_email: string | null;
  fecha: string | null;
  contract_starts: string | null;
  contract_ends: string | null;
}

/**
 * Variables de Configuración del contrato — las reglas GLOBALES que el usuario
 * revisa/corrige en el step intermedio antes de la extracción. Mirrors backend
 * `ContractBrief` one-to-one. Un valor mal acá (ej. "los precios no incluyen
 * IVA") envenena TODAS las filas, por eso este gate es el de mayor impacto.
 */
export interface ContractConfigVariables {
  shared_fields: ConfigSharedFields;
  prices_include_tax: boolean | null;
  tax_rate_pct: number | null;
  tax_note: string | null;
  commission_default_pct: number | null;
  commission_summary: string | null;
  meal_plan_note: string | null;
  currency: string | null;
  bank_accounts: ConfigBankAccount[];
  additional_person: ConfigAdditionalPerson[];
  special_periods_note: string | null;
  product_categories: string[];
  seasons: string[];
  seasons_detail: ConfigSeason[];
  sections: string[];
  expected_row_estimate: number | null;
  notes: string | null;
  /** Resumen narrativo en español para el operador (Paso 2). */
  logic_summary: string | null;
  /** Inventario estructurado de filas estimadas. */
  row_plan: ConfigRowPlan | null;
  /** N = por noche, S = por servicio/paquete (Full Experience, etc.). */
  tipo_unidad?: "N" | "S" | null;
  /** Códigos de ocupación del catálogo Utopía (referencia global). */
  occupancy_codes?: string[];
  /** Ocupaciones por producto cuando el PDF las publica distinto. */
  occupancies_by_product?: Array<{
    product: string;
    occupancy_codes: string[];
  }>;
  max_adults_per_room?: number | null;
  quadruple_allowed?: boolean | null;
}

export interface AnalyzeBriefMeta {
  filename: string;
  size_bytes: number;
  model: string;
  processed_at: string;
  is_existing_supplier?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

export interface AnalyzeBriefResponse {
  success: true;
  brief: ContractConfigVariables;
  meta: AnalyzeBriefMeta;
}

export interface RefineBriefInput {
  previousBrief: ContractConfigVariables;
  feedbackMessage: string;
  chatHistory?: BriefChatMessage[];
}

export interface RefineBriefResponse {
  success: true;
  brief: ContractConfigVariables;
  meta: AnalyzeBriefMeta;
}

/* --- generate-xlsx (genera el xlsx final con los datos editados) --- */

/**
 * Catalog prefill input — datos del maestro lista-proveedores que se escriben
 * en las columnas A, B, C, N del xlsx. null cuando el proveedor es nuevo.
 */
export interface GenerateXlsxCatalogPrefill {
  tipo_actividad: string | null;
  zona_turismo: string | null;
  /** Código corto del proveedor en el maestro (columna C). */
  proveedor_codigo: string | null;
  codigo_servicio: string | null;
}

/**
 * Campos "manuales" — columnas que existen en la plantilla pero NO extrae la
 * IA. El usuario los llena en step 2 (X, AA, AC, AD, AG, AK, AP, AQ, AU..AZ).
 * Se replican en cada fila del xlsx igual que shared_fields.
 */
export interface GenerateXlsxManualFields {
  tipo_tarifa_neta: string | null;
  tipo_tarifa_mayorista: string | null;
  tipo_tarifa_fds: string | null;
  t_tar_neta_fds: string | null;
  tipo_tarifa_mayorista_fds: string | null;
  cond_credito: string | null;
  plazo: string | null;
  cuenta_bancaria_2: string | null;
  banco_2: string | null;
  moneda_2: string | null;
  cuenta_bancaria_3: string | null;
  banco_3: string | null;
  moneda_3: string | null;
}

export interface GenerateXlsxInput {
  shared_fields: ExtractedSharedFields;
  rows: ExtractedContractRow[];
  catalog_prefill?: GenerateXlsxCatalogPrefill | null;
  manual_fields?: GenerateXlsxManualFields | null;
}

/* --- refine-table (chat de correcciones del Paso 3) --- */

/** Mensaje del mini chat de correcciones de la tabla (Paso 3). */
export interface TableChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Envolvente de la tabla que viaja al chat de correcciones y vuelve
 * corregida. Es exactamente la misma forma que `GenerateXlsxInput` — el
 * asistente trabaja sobre lo que se va a escribir en el xlsx, ni más ni menos.
 */
export interface RefineTableInput {
  shared_fields: ExtractedSharedFields;
  rows: ExtractedContractRow[];
  catalog_prefill: GenerateXlsxCatalogPrefill | null;
  manual_fields: GenerateXlsxManualFields | null;
  /** Pedido del operador en lenguaje natural. */
  message: string;
  /** Historial del chat para que el asistente no repita lo ya resuelto. */
  chat_history?: TableChatMessage[];
  /** Comentarios que el operador dio al subir el contrato (Paso 1). */
  comments?: string | null;
}

export interface RefineTableResponse {
  success: true;
  table: {
    shared_fields: ExtractedSharedFields;
    rows: ExtractedContractRow[];
    catalog_prefill: GenerateXlsxCatalogPrefill | null;
    manual_fields: GenerateXlsxManualFields | null;
  };
  /**
   * Para cada fila devuelta, el índice 0-based que tenía en la tabla enviada
   * (o `null` si el asistente la creó). Permite re-alinear los metadatos
   * paralelos de la grilla (páginas de origen) cuando se agregan o borran
   * filas.
   */
  row_index_map: (number | null)[];
  /** Respuesta en lenguaje natural para el hilo del chat. */
  reply: string;
  /** Resumen determinista de lo que el backend efectivamente aplicó. */
  changes: string[];
  meta: {
    model: string;
    processed_at: string;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
  };
}

/* --- match-supplier (fallback IA del lookup contra el catálogo) --- */

export type MatchSupplierConfidence = "alta" | "media" | "baja";

export interface MatchSupplierCandidate {
  codigo: string;
  nombre: string;
}

export interface MatchSupplierInput {
  /** Nombre extraído del contrato (ej: "HOTEL PARADOR RESORT & SPA"). */
  query: string;
  /** Lista de candidatos del catálogo. El backend tiene cap de ~600. */
  candidates: MatchSupplierCandidate[];
}

export interface MatchSupplierData {
  /** Código elegido por la IA, o null si ningún candidato es razonable. */
  codigo: string | null;
  confidence: MatchSupplierConfidence;
  reasoning: string;
}

export interface MatchSupplierResponse {
  success: true;
  data: MatchSupplierData;
}

/* --- match-service (fallback IA para codigo_servicio dentro de un proveedor) --- */

export interface MatchServiceCandidate {
  codigo: string;
  /** Descripción libre del servicio. Puede ser null. */
  descripcion: string | null;
}

export interface MatchServiceInput {
  /**
   * Contexto del contrato — texto corto que incluye tipo_servicio,
   * nombre_comercial, tipo_unidad, comentarios del usuario, etc.
   * El backend lo usa como prompt para que la IA elija el mejor servicio.
   */
  contractContext: string;
  /** Servicios disponibles para el proveedor matcheado. Cap ~200. */
  candidates: MatchServiceCandidate[];
}

export interface MatchServiceData {
  /** Código del servicio elegido por la IA, o null si nada matcheó. */
  codigo: string | null;
  /** Misma escala que `MatchSupplierConfidence` (alta/media/baja). */
  confidence: MatchSupplierConfidence;
  reasoning: string;
}

export interface MatchServiceResponse {
  success: true;
  data: MatchServiceData;
}

/* --- contract runs (persistencia de step 3) --- */

export type ContractFileKind = "pdf" | "docx" | "xlsx" | "image";

/**
 * Lo que el frontend envía a `POST /contracts` cuando un run llega a
 * `phase = "ready"`. Mismas tres estructuras que generate-xlsx + meta.
 */
export interface SaveContractRunInput {
  filename: string;
  file_kind: ContractFileKind;
  file_size: number;
  ai_model: string;
  shared_fields: ExtractedSharedFields;
  rows: ExtractedContractRow[];
  catalog_prefill?: GenerateXlsxCatalogPrefill | null;
  manual_fields?: GenerateXlsxManualFields | null;
  /**
   * Telemetría opcional reenviada desde `meta` del extract. Si el extract
   * no las trae (compat con backends viejos), se omiten y el backend las
   * persiste como null — el historial sigue siendo válido.
   */
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  /** See `ExtractionMeta.extraction_id`. Makes the save an upsert. */
  extraction_id?: string;
  /** Señal de aprendizaje (ver `RunFeedback`). Opcional; nunca bloquea el save. */
  feedback?: RunFeedback | null;
}

export interface ContractRunUserRef {
  id: string;
  name: string;
  email: string;
}

export interface ContractRun {
  id: string;
  /** ISO timestamp. */
  processedAt: string;
  /** Null when the user that processed the run has since been deleted. */
  processedBy: ContractRunUserRef | null;
  filename: string;
  fileKind: ContractFileKind;
  fileSize: number;
  sharedFields: ExtractedSharedFields;
  rows: ExtractedContractRow[];
  catalogPrefill: GenerateXlsxCatalogPrefill | null;
  manualFields: GenerateXlsxManualFields | null;
  aiModel: string;
  /**
   * Token usage + costo USD del run. Nullables porque los runs persistidos
   * antes de esta feature no tienen estos valores.
   */
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

/**
 * Per-range counters. Drives:
 *   - "Contratos procesados" → `stats.contracts[range]`
 *   - "Minutos ahorrados"    → `stats.lines[range] * MINUTES_SAVED_PER_LINE`
 *
 * `lines` cuenta filas xlsx (sum de `rows.length` por contrato del rango).
 * Es mejor proxy que el conteo de contratos: un contrato con 20 filas
 * ahorra mucho más trabajo manual que uno con 1. El multiplicador vive en
 * el frontend para poder ajustarlo sin redeploy.
 */
export interface ContractStatsBuckets {
  today: number;
  week: number;
  month: number;
  quarter: number;
  all: number;
}

export interface ContractStats {
  contracts: ContractStatsBuckets;
  lines: ContractStatsBuckets;
}

/** Time ranges understood by both `/contracts` and `/contracts/stats`. */
export type ContractRangeKey = keyof ContractStatsBuckets;

export interface ListContractRunsParams {
  /** Only runs inside this range (same cutoffs the stats card uses). */
  range?: ContractRangeKey;
  limit?: number;
  offset?: number;
}

export interface ListContractRunsResponse {
  runs: ContractRun[];
  /** Runs matching `range` regardless of pagination — equals the stats card. */
  total: number;
  range: ContractRangeKey;
  tz: string;
  limit: number;
  offset: number;
}

/**
 * IANA zone of the browser, sent as `?tz=` so the backend computes "hoy"
 * in the user's calendar day instead of the server's. Falls back to UTC
 * when `Intl` can't resolve one (very old browsers).
 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const api = {
  login(payload: LoginPayload) {
    return request<AuthResponse>("/auth/login", {
      method: "POST",
      body: payload,
    });
  },
  users: {
    list() {
      return request<{ users: ManagedUser[] }>("/users", {
        method: "GET",
        auth: true,
      });
    },
    create(payload: CreateUserPayload) {
      return request<CreateUserResponse>("/users", {
        method: "POST",
        body: payload,
        auth: true,
      });
    },
    update(id: string, payload: UpdateUserPayload) {
      return request<{ user: ManagedUser }>(
        `/users/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: payload,
          auth: true,
        },
      );
    },
    remove(id: string) {
      return request<void>(`/users/${encodeURIComponent(id)}`, {
        method: "DELETE",
        auth: true,
      });
    },
  },
  suppliers: {
    /**
     * `summary: true` → sin servicios (~60 KB en vez de ~2.7 MB). Es lo que
     * usa el agente; la pantalla de administración pide el catálogo completo.
     */
    list(opts: { summary?: boolean } = {}) {
      const qs = opts.summary ? "?summary=1" : "";
      return request<{ suppliers: CatalogSupplier[]; summary: boolean }>(
        `/suppliers${qs}`,
        { method: "GET", auth: true },
      );
    },
    get(id: string) {
      return request<{ supplier: CatalogSupplier }>(
        `/suppliers/${encodeURIComponent(id)}`,
        { method: "GET", auth: true },
      );
    },
    create(payload: CreateSupplierPayload) {
      return request<{ supplier: CatalogSupplier }>("/suppliers", {
        method: "POST",
        body: payload,
        auth: true,
      });
    },
    update(id: string, payload: UpdateSupplierPayload) {
      return request<{ supplier: CatalogSupplier }>(
        `/suppliers/${encodeURIComponent(id)}`,
        { method: "PATCH", body: payload, auth: true },
      );
    },
    /** Replaces the whole services list of a supplier. */
    replaceServices(id: string, servicios: SupplierServiceInput[]) {
      return request<{ supplier: CatalogSupplier }>(
        `/suppliers/${encodeURIComponent(id)}/servicios`,
        { method: "PUT", body: { servicios }, auth: true },
      );
    },
    remove(id: string) {
      return request<void>(`/suppliers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        auth: true,
      });
    },
  },
  agentRules: {
    list() {
      return request<{ rules: AgentRule[] }>("/agent-rules", { method: "GET", auth: true });
    },
    create(text: string) {
      return request<{ rule: AgentRule }>("/agent-rules", {
        method: "POST",
        body: { text },
        auth: true,
      });
    },
    update(id: string, patch: { text?: string; enabled?: boolean }) {
      return request<{ rule: AgentRule }>(`/agent-rules/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: patch,
        auth: true,
      });
    },
    remove(id: string) {
      return request<void>(`/agent-rules/${encodeURIComponent(id)}`, {
        method: "DELETE",
        auth: true,
      });
    },
    suggestions() {
      return request<{ suggestions: AgentRuleSuggestion[]; thresholds: { runs: number; suppliers: number } }>(
        "/agent-rules/suggestions",
        { method: "GET", auth: true },
      );
    },
    acceptSuggestion(id: string, text?: string) {
      return request<{ suggestion: AgentRuleSuggestion; rule: AgentRule }>(
        `/agent-rules/suggestions/${encodeURIComponent(id)}/accept`,
        { method: "POST", body: text ? { text } : {}, auth: true },
      );
    },
    dismissSuggestion(id: string) {
      return request<{ suggestion: AgentRuleSuggestion }>(
        `/agent-rules/suggestions/${encodeURIComponent(id)}/dismiss`,
        { method: "POST", body: {}, auth: true },
      );
    },
  },
  evals: {
    list() {
      return request<{ cases: EvalCase[]; runs: EvalRunSummary[]; limits: { maxDbCases: number; maxFiles: number; maxFileBytes: number } }>(
        "/api/supplier-intelligence/evals",
        { method: "GET", auth: true },
      );
    },
    create(files: File[], input: CreateEvalCaseInput) {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      form.append("title", input.title);
      if (input.supplierCodigo) form.append("supplier_codigo", input.supplierCodigo);
      if (input.layoutFamily) form.append("layout_family", input.layoutFamily);
      if (input.notes) form.append("notes", input.notes);
      form.append("expected", JSON.stringify(input.expected));
      return requestForm<{ case: EvalCase }>("/api/supplier-intelligence/evals", form, {
        auth: true,
        timeoutMs: 2 * 60 * 1000,
      });
    },
    remove(id: string) {
      return request<void>(`/api/supplier-intelligence/evals/${encodeURIComponent(id)}`, {
        method: "DELETE",
        auth: true,
      });
    },
    /** Corre todos los casos (sin IA). Puede tardar ~1-2 s por caso. */
    run() {
      return request<{ run: EvalRunSummary; results: EvalCaseResult[] }>(
        "/api/supplier-intelligence/evals/run",
        { method: "POST", body: {}, auth: true, timeoutMs: 5 * 60 * 1000 },
      );
    },
  },
  supplierIntelligence: {
    /**
     * Upload one or more contract documents (PDF / Word / Excel) and get a
     * single merged extraction back. Each file ≤ 20 MB; backend caps the
     * number of files per request (currently 10) so the combined Claude
     * payload stays within token + size limits.
     *
     * All files are sent under the same `files` multipart field name so the
     * backend's `multer.array("files")` parses them as an ordered list.
     *
     * Not authenticated in the backend yet — keeping `auth: false` here so
     * the scoped error handler's 401 shape doesn't matter. Flip to
     * `auth: true` when the backend adds a guard.
     */
    extract(files: File[], input: ExtractContractInput) {
      if (files.length === 0) {
        throw new ApiError(
          400,
          "Adjunta al menos un documento antes de continuar.",
        );
      }
      const form = new FormData();
      // Multer's `.array("files")` expects every file under the same field
      // name; the backend reads `req.files` as an array preserving order.
      for (const f of files) {
        form.append("files", f);
      }
      // Backend expects snake_case form fields. Comments are optional; the
      // existing-supplier flag is required and serialized as "true" / "false".
      form.append("is_existing_supplier", input.isExistingSupplier ? "true" : "false");
      const trimmed = input.comments?.trim();
      if (trimmed) {
        form.append("comments", trimmed);
      }
      if (input.preScanHints && Object.keys(input.preScanHints).length > 0) {
        form.append("pre_scan_hints", JSON.stringify(input.preScanHints));
      }
      // Variables de Configuración confirmadas en el step gated. Cuando vienen,
      // el backend salta la Fase 1 y usa estas reglas globales tal cual.
      // `briefs` (array, uno por documento) tiene prioridad; `brief` es
      // back-compat para el flujo de un solo documento.
      if (input.confirmedConfigs && input.confirmedConfigs.length > 0) {
        form.append("briefs", JSON.stringify(input.confirmedConfigs));
      } else if (input.confirmedConfig) {
        form.append("brief", JSON.stringify(input.confirmedConfig));
      }
      // La extracción Opus tarda varios minutos (un contrato denso de 100+
      // filas puede gastar ~7-8 min en el pase principal). Mantener una sola
      // conexión HTTP abierta tanto tiempo se cae en los proxies intermedios
      // (edge de Railway, Next.js). Por eso el backend ahora corre el trabajo
      // como JOB ASÍNCRONO: arrancamos el job y encuestamos su estado con
      // peticiones cortas hasta que termina. El retorno es el mismo
      // `ExtractContractResponse`, así el flujo de los 4 pasos no cambia.
      return startAndPollExtraction(form);
    },
    /**
     * Fase 1 del flujo gated: sube los documentos y devuelve las Variables de
     * Configuración (reglas globales: IVA, comisión, temporadas, bancos) para
     * que el usuario las confirme/corrija antes de la extracción completa.
     * Mucho más rápido que `extract` (un solo pase de Sonnet, sin filas), así
     * que un timeout de 3 minutos es holgado.
     */
    /**
     * Pre-scan determinístico de TODOS los adjuntos (sin IA): proveedor
     * detectado, datos regex por documento y contratos anteriores del mismo
     * proveedor. El primario va primero. Corre cada vez que cambia el
     * conjunto de archivos en el Paso 1; `signal` cancela el anterior.
     */
    preScan(files: File[], opts: { signal?: AbortSignal } = {}) {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      return requestForm<{ success: true; scan: PreScanResult }>(
        "/api/supplier-intelligence/pre-scan",
        form,
        { auth: true, timeoutMs: 60 * 1000, signal: opts.signal },
      );
    },
    analyzeBrief(files: File[], input: ExtractContractInput) {
      if (files.length === 0) {
        throw new ApiError(
          400,
          "Adjunta al menos un documento antes de continuar.",
        );
      }
      const form = new FormData();
      for (const f of files) {
        form.append("files", f);
      }
      form.append(
        "is_existing_supplier",
        input.isExistingSupplier ? "true" : "false",
      );
      const trimmed = input.comments?.trim();
      if (trimmed) {
        form.append("comments", trimmed);
      }
      if (input.preScanHints && Object.keys(input.preScanHints).length > 0) {
        form.append("pre_scan_hints", JSON.stringify(input.preScanHints));
      }
      return requestForm<AnalyzeBriefResponse>(
        "/api/supplier-intelligence/analyze-brief",
        form,
        { auth: true, timeoutMs: 3 * 60 * 1000 },
      );
    },
    /**
     * Re-analiza el brief tras correcciones en lenguaje natural (Paso 2).
     */
    refineBrief(
      files: File[],
      input: ExtractContractInput & RefineBriefInput,
    ) {
      if (files.length === 0) {
        throw new ApiError(
          400,
          "Adjunta al menos un documento antes de continuar.",
        );
      }
      const form = new FormData();
      for (const f of files) {
        form.append("files", f);
      }
      form.append(
        "is_existing_supplier",
        input.isExistingSupplier ? "true" : "false",
      );
      const trimmed = input.comments?.trim();
      if (trimmed) {
        form.append("comments", trimmed);
      }
      if (input.preScanHints && Object.keys(input.preScanHints).length > 0) {
        form.append("pre_scan_hints", JSON.stringify(input.preScanHints));
      }
      form.append("brief", JSON.stringify(input.previousBrief));
      form.append("feedback_message", input.feedbackMessage.trim());
      if (input.chatHistory && input.chatHistory.length > 0) {
        form.append("chat_history", JSON.stringify(input.chatHistory));
      }
      return requestForm<RefineBriefResponse>(
        "/api/supplier-intelligence/refine-brief",
        form,
        { auth: true, timeoutMs: 3 * 60 * 1000 },
      );
    },
    /**
     * Fallback IA para el lookup contra el catálogo lista-proveedores. Solo se usa
     * cuando el matching local del frontend (exact / prefix / includes)
     * falla — el backend cobra Anthropic en cada llamada, así que no abuses.
     */
    matchSupplier(input: MatchSupplierInput) {
      return request<MatchSupplierResponse>(
        "/api/supplier-intelligence/match-supplier",
        {
          method: "POST",
          body: input,
          auth: true,
        },
      );
    },
    /**
     * Fallback IA para elegir el `codigo_servicio` de un proveedor cuando
     * el matcher local (`findServiceForSupplier`) no resuelve por ambigüedad
     * (el proveedor tiene >1 servicio y el hint no apunta a uno solo). Mismo
     * tradeoff de costo que `matchSupplier` — solo llamarlo cuando ya
     * agotamos las opciones locales.
     */
    matchService(input: MatchServiceInput) {
      return request<MatchServiceResponse>(
        "/api/supplier-intelligence/match-service",
        {
          method: "POST",
          body: input,
          auth: true,
        },
      );
    },
    /**
     * Genera y descarga el xlsx final con los datos editados de step 2.
     * Devuelve `{ blob, filename }` — el caller hace el download con
     * `URL.createObjectURL(blob)` + un `<a download>` programático.
     *
     * El filename viene del header Content-Disposition del backend (formato
     * `${proveedor}-${year}.xlsx`); el fallback solo se usa si el backend no
     * envía el header.
     */
    generateXlsx(input: GenerateXlsxInput) {
      return requestBlob(
        "/api/supplier-intelligence/generate-xlsx",
        { method: "POST", body: input },
        "contrato.xlsx",
      );
    },
    /**
     * Chat de correcciones "en caliente" del Paso 3. Manda la tabla que el
     * operador está revisando + su pedido en lenguaje natural, y devuelve la
     * tabla ya corregida.
     *
     * No re-sube los documentos: el contexto es el JSON de la grilla. Eso lo
     * hace barato y rápido comparado con `refineBrief` (que sí manda los
     * archivos) — el chat tiene que sentirse como un chat. La contrapartida es
     * que el asistente solo puede razonar sobre lo que está en la tabla; si le
     * piden un dato que no está, responde pidiéndolo en lugar de inventarlo.
     *
     * Timeout de 3 minutos: es un solo pase de Opus sobre un payload chico,
     * pero una tabla de 300+ filas con muchas celdas a reescribir puede
     * acercarse al minuto.
     */
    refineTable(input: RefineTableInput) {
      return request<RefineTableResponse>(
        "/api/supplier-intelligence/refine-table",
        { method: "POST", body: input, timeoutMs: 3 * 60 * 1000 },
      );
    },
    /**
     * Persiste un run completo después de que generateXlsx devolvió OK.
     * Fire-and-forget desde el caller — un fallo aquí no debe bloquear la
     * descarga del usuario.
     */
    saveRun(input: SaveContractRunInput) {
      return request<{ run: ContractRun }>(
        "/api/supplier-intelligence/contracts",
        {
          method: "POST",
          body: input,
          auth: true,
        },
      );
    },
    listRuns(params: ListContractRunsParams = {}) {
      const qs = new URLSearchParams({ tz: browserTimeZone() });
      if (params.range) qs.set("range", params.range);
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.offset) qs.set("offset", String(params.offset));
      return request<ListContractRunsResponse>(
        `/api/supplier-intelligence/contracts?${qs.toString()}`,
        { method: "GET", auth: true },
      );
    },
    stats() {
      const qs = new URLSearchParams({ tz: browserTimeZone() });
      return request<{ stats: ContractStats; tz: string }>(
        `/api/supplier-intelligence/contracts/stats?${qs.toString()}`,
        { method: "GET", auth: true },
      );
    },
    /** Panel de calidad: agregado del feedback de los runs del rango. */
    quality(range: ContractRangeKey = "quarter") {
      const qs = new URLSearchParams({ tz: browserTimeZone(), range });
      return request<{ quality: QualityReport; tz: string }>(
        `/api/supplier-intelligence/contracts/quality?${qs.toString()}`,
        { method: "GET", auth: true },
      );
    },
    /**
     * Último run APROBADO de un proveedor del maestro (memoria del
     * proveedor). `null` cuando nunca se procesó un contrato suyo.
     */
    lastRun(supplierCodigo: string) {
      const qs = new URLSearchParams({ supplier: supplierCodigo });
      return request<{ memory: SupplierMemory | null }>(
        `/api/supplier-intelligence/contracts/last?${qs.toString()}`,
        { method: "GET", auth: true },
      );
    },
  },
};

/* --------------------------- session persistence -------------------------- */

const TOKEN_KEY = "tp.authToken";
const USER_KEY = "tp.authUser";
export const SESSION_CHANGED_EVENT = "tp:session-changed";

export interface Session {
  token: string;
  user: AuthUser;
}

function emitSessionChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
}

export function saveSession(auth: AuthResponse) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOKEN_KEY, auth.token);
    window.localStorage.setItem(USER_KEY, JSON.stringify(auth.user));
    emitSessionChange();
  } catch {
    // localStorage may be unavailable (private mode, SSR); silently ignore.
  }
}

export function clearSession() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
    emitSessionChange();
  } catch {
    // ignore
  }
}

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const token = window.localStorage.getItem(TOKEN_KEY);
    const rawUser = window.localStorage.getItem(USER_KEY);
    if (!token || !rawUser) return null;
    const user = JSON.parse(rawUser) as AuthUser;
    if (!user || typeof user !== "object" || !user.id || !user.email) {
      return null;
    }
    return { token, user };
  } catch {
    return null;
  }
}
