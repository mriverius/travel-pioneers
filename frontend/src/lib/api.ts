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
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:4000";

export interface ValidationDetail {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly details: ValidationDetail[];

  constructor(status: number, message: string, details: ValidationDetail[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

interface BackendErrorShape {
  error?: {
    message?: string;
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
}

async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
  const { body, headers, auth: authed = false, ...rest } = init;

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

  const res = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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
    throw new ApiError(res.status, message, parseDetails(err.error?.details));
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
