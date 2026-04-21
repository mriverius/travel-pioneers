"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  SESSION_CHANGED_EVENT,
  clearSession,
  getSession,
  type Session,
} from "./api";

interface AuthState {
  /** The current session, or `null` if signed out. */
  session: Session | null;
  /**
   * Whether we've finished reading `localStorage`. On the server and during
   * initial hydration this is `false` — callers should render neutral
   * placeholder UI while `ready === false` to avoid flashing the wrong thing.
   */
  ready: boolean;
  /** Sign the user out and clear persisted tokens. */
  signOut: () => void;
}

/**
 * `useSyncExternalStore` requires `getSnapshot` to return a referentially
 * stable value as long as the external state hasn't changed — otherwise
 * React detects a change on every read and spins into an infinite loop.
 *
 * `getSession()` parses JSON from localStorage, so each call returns a
 * fresh object even when nothing's changed. We cache the last snapshot
 * here and only swap it out when a value actually differs.
 */
let cachedSnapshot: Session | null = null;
let hasCached = false;

function sessionsEqual(a: Session | null, b: Session | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.token === b.token &&
    a.user.id === b.user.id &&
    a.user.email === b.user.email &&
    a.user.name === b.user.name &&
    a.user.role === b.user.role &&
    a.user.updatedAt === b.user.updatedAt
  );
}

function readSession(): Session | null {
  const next = getSession();
  if (hasCached && sessionsEqual(cachedSnapshot, next)) {
    // Nothing meaningful changed — keep the prior reference so React
    // treats the snapshot as stable.
    return cachedSnapshot;
  }
  cachedSnapshot = next;
  hasCached = true;
  return cachedSnapshot;
}

/**
 * Subscribe to auth-state changes:
 * - `storage` — fires when another tab writes to localStorage.
 * - `tp:session-changed` — fires when our own `saveSession` / `clearSession`
 *   helpers run in this tab.
 */
function subscribe(notify: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (!e.key || e.key.startsWith("tp.")) notify();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(SESSION_CHANGED_EVENT, notify);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(SESSION_CHANGED_EVENT, notify);
  };
}

function getServerSnapshot(): Session | null {
  return null;
}

/**
 * React-friendly view of the persisted auth session.
 *
 * Uses `useSyncExternalStore` so the render always reflects the current
 * localStorage value and updates across tabs without needing a ref or an
 * effect to "pull" state into React.
 */
export function useAuth(): AuthState {
  const session = useSyncExternalStore(
    subscribe,
    readSession,
    getServerSnapshot,
  );

  // Until React has hydrated we can't trust `session` — return `ready: false`
  // so callers render placeholder UI instead of the signed-out view.
  const ready = typeof window !== "undefined";

  const signOut = useCallback(() => {
    clearSession();
  }, []);

  return { session, ready, signOut };
}
