"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Compass, Home, Sparkles } from "lucide-react";
import { useAuth } from "@/lib/useAuth";

/**
 * Global 404 handler. Styled to match the auth screens — same frosted
 * `auth-surface`, same emerald accents, same `btn-premium` CTA — so it
 * never feels like a framework-default error page.
 *
 * The primary CTA is context-aware: signed-in users go back to the agent
 * screen, guests go to /login. While auth state is resolving we keep the
 * label neutral ("Ir al inicio") and point at the root, which itself
 * redirects to the right place.
 */
export default function NotFound() {
  const router = useRouter();
  const { session, ready } = useAuth();

  const home = ready
    ? session
      ? "/agent/supplier-intelligence"
      : "/login"
    : "/";
  const homeLabel = ready
    ? session
      ? "Volver al agente"
      : "Ir a iniciar sesión"
    : "Ir al inicio";

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-6 py-10 overflow-hidden relative">
      {/* Ambient background glow — same palette as the auth-brand-panel */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(900px 500px at 20% 10%, hsl(157 95% 50% / 0.18) 0%, transparent 60%), radial-gradient(700px 400px at 80% 80%, hsl(165 85% 40% / 0.14) 0%, transparent 60%)",
        }}
      />

      <div className="relative z-10 w-full max-w-[520px] auth-surface rounded-2xl px-7 py-9 sm:px-10 sm:py-11 text-center animate-auth-enter">
        {/* Brand mark */}
        <div className="flex justify-center mb-7">
          <div className="w-14 h-14 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center animate-pulse-glow">
            <Compass className="w-6 h-6 text-primary" />
          </div>
        </div>

        {/* Gradient 404 */}
        <p className="text-[88px] sm:text-[104px] font-bold leading-none tracking-tight text-gradient-primary select-none">
          404
        </p>

        <span className="inline-flex items-center gap-1.5 mt-3 px-2.5 py-1 rounded-full border border-emerald-400/25 bg-emerald-400/10 text-emerald-300 text-[11px] font-medium tracking-wide uppercase">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
          Página no encontrada
        </span>

        <h1 className="text-[24px] sm:text-[26px] font-semibold tracking-tight mt-5">
          Parece que te desviaste de la ruta
        </h1>
        <p className="text-[14px] text-muted-foreground mt-2 leading-relaxed max-w-[400px] mx-auto">
          La página que buscas no existe o fue movida. Revisa la URL o vuelve
          al inicio para continuar.
        </p>

        <div className="mt-8 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-center gap-2.5">
          <button
            type="button"
            onClick={() => router.back()}
            className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-border text-[13.5px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Volver atrás
          </button>
          <Link
            href={home}
            className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
          >
            <Home className="w-4 h-4" />
            {homeLabel}
          </Link>
        </div>

        <div className="mt-9 pt-6 border-t border-border/60 flex items-center justify-center gap-2 text-[11.5px] text-muted-foreground/70">
          <Sparkles className="w-3 h-3 text-primary/70" />
          Travel Pioneers · Powered by Destiny Media
        </div>
      </div>
    </main>
  );
}
