"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/useAuth";

/**
 * Client-side gate for authenticated routes.
 *
 * Wrapped around the portal layout: if there's no persisted session, we
 * kick the user to /login. While the auth state is still resolving (first
 * tick after mount) we render nothing to avoid leaking private UI.
 *
 * Note: this is a UX guard, not a security boundary — the real enforcement
 * lives on the backend (routes protected by the JWT middleware). Anyone
 * poking the rendered HTML won't get data back without a valid token.
 */
export default function AuthGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { session, ready } = useAuth();

  useEffect(() => {
    if (ready && !session) {
      router.replace("/login");
    }
  }, [ready, session, router]);

  if (!ready || !session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}
