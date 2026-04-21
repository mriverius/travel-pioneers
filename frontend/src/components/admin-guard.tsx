"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "@/lib/useAuth";

/**
 * Client-side gate for admin-only pages.
 *
 * Non-admins are redirected to the default agent screen. While the auth
 * state is still resolving we render a neutral spinner so we never flash
 * the protected UI before the redirect lands.
 *
 * Like `AuthGuard`, this is a UX affordance — the real enforcement is the
 * backend's `requireAdmin` middleware. Anyone poking the rendered HTML
 * without an admin token won't get data back.
 */
export default function AdminGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { session, ready } = useAuth();
  const isAdmin = session?.user.role === "admin";

  useEffect(() => {
    if (!ready) return;
    if (!session) {
      // AuthGuard will handle this case, but belt-and-braces: if this
      // component somehow renders without a session, bounce to login.
      router.replace("/login");
      return;
    }
    if (!isAdmin) {
      router.replace("/module/supplier-intelligence");
    }
  }, [ready, session, isAdmin, router]);

  if (!ready || !session) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-[40vh] flex flex-col items-center justify-center gap-3 text-center">
        <div className="w-12 h-12 rounded-full bg-destructive/10 border border-destructive/30 flex items-center justify-center">
          <ShieldAlert className="w-5 h-5 text-destructive" />
        </div>
        <div>
          <p className="text-[14px] font-semibold text-foreground">
            Acceso restringido
          </p>
          <p className="text-[12.5px] text-muted-foreground mt-0.5">
            Redirigiendo…
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
