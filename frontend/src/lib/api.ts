/**
 * Thin fetch wrapper for the Travel Pioneers backend.
 *
 * - Base URL comes from `NEXT_PUBLIC_API_URL` (see `.env.example`),
 *   defaulting to `http://localhost:4000` in dev.
 * - Non-2xx responses are thrown as `ApiError` so callers can branch on
 *   status (409 email-taken, 400 validation, 401 bad credentials, …) and
 *   surface backend-provided messages without re-formatting them.
 * - Authenticated requests (`auth: true`) auto-attach the bearer token
 *   from localStorage. A 401 on an authenticated request clears the
 *   session so the AuthGuard kicks the user back to /login.
 */

const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ??
  "http://localhost:4000";

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
    res = await fetch(`${API_URL}${path}`, {
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
    res = await fetch(`${API_URL}${path}`, {
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
    res = await fetch(`${API_URL}${path}`, {
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

export interface RegisterPayload {
  name: string;
  email: string;
  password: string;
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
}

export interface ManualBankPrefill {
  cuenta_bancaria_2: string | null;
  banco_2: string | null;
  moneda_2: string | null;
  cuenta_bancaria_3: string | null;
  banco_3: string | null;
  moneda_3: string | null;
}

export interface ExtractContractResponse {
  success: true;
  data: ExtractedContract;
  validation: ExtractionValidation;
  meta: ExtractionMeta;
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
  processedBy: ContractRunUserRef;
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

export const api = {
  register(payload: RegisterPayload) {
    return request<AuthResponse>("/auth/register", {
      method: "POST",
      body: payload,
    });
  },
  login(payload: LoginPayload) {
    return request<AuthResponse>("/auth/login", {
      method: "POST",
      body: payload,
    });
  },
  /**
   * Availability pre-check used by the register form to flag taken emails
   * on blur — doesn't replace the server-side 409 handling at submit time.
   */
  checkEmailAvailability(email: string) {
    const qs = new URLSearchParams({ email });
    return request<{ email: string; available: boolean }>(
      `/auth/check-email?${qs.toString()}`,
      { method: "GET" },
    );
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
      // AI extraction is slow, and now runs in TWO sequential Anthropic
      // passes: a focused "contract brief" (global rules + inventory) followed
      // by the full grid-fill extraction. A dense contract (100+ rows) can
      // spend ~7-8 min in the main pass alone, plus ~1 min for the brief, so
      // an 8-minute ceiling now trips on exactly the documents that used to
      // just barely fit. 15 minutes covers both passes with margin while still
      // bounding a truly stuck backend.
      return requestForm<ExtractContractResponse>(
        "/api/supplier-intelligence/extract",
        form,
        { timeoutMs: 15 * 60 * 1000 },
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
    listRuns(limit?: number) {
      const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
      return request<{ runs: ContractRun[] }>(
        `/api/supplier-intelligence/contracts${qs}`,
        { method: "GET", auth: true },
      );
    },
    stats() {
      return request<{ stats: ContractStats }>(
        "/api/supplier-intelligence/contracts/stats",
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
