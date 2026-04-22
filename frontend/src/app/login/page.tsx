"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Eye,
  EyeOff,
  LineChart,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { ApiError, api, saveSession } from "@/lib/api";
import GuestGuard from "@/components/guest-guard";

export default function LoginPage() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!email.trim() || !password) {
      setFormError("Ingresa tu correo y contraseña.");
      return;
    }

    setLoading(true);
    try {
      const result = await api.login({
        email: email.trim().toLowerCase(),
        password,
      });
      // Play the fade-out BEFORE writing the session. Otherwise
      // `saveSession` dispatches SESSION_CHANGED_EVENT, `useAuth` re-renders,
      // and `GuestGuard` immediately swaps this form for its spinner —
      // which would yank the login card out from under the animation.
      setLeaving(true);
      await new Promise((resolve) => setTimeout(resolve, 380));
      saveSession(result);
      router.replace("/agent/supplier-intelligence");
    } catch (err) {
      if (err instanceof ApiError) {
        // Backend returns a generic "Invalid email or password" on 401 —
        // surface it as-is so we never leak whether the email is registered.
        setFormError(err.message);
      } else if (err instanceof TypeError) {
        setFormError(
          "No se pudo conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo.",
        );
      } else {
        setFormError("Se produjo un error inesperado. Inténtalo de nuevo.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <GuestGuard>
      <div
        className="min-h-screen flex bg-background"
        style={{
          transition:
            "opacity 380ms cubic-bezier(0.4, 0, 0.2, 1), transform 380ms cubic-bezier(0.4, 0, 0.2, 1), filter 380ms cubic-bezier(0.4, 0, 0.2, 1)",
          opacity: leaving ? 0 : 1,
          transform: leaving ? "translateY(-6px)" : "translateY(0)",
          filter: leaving ? "blur(4px)" : "blur(0)",
          pointerEvents: leaving ? "none" : "auto",
        }}
      >
        {/* Left panel - branding */}
        <div className="hidden lg:flex lg:w-1/2 relative auth-brand-panel items-center justify-center p-12 overflow-hidden">
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative z-10 max-w-md text-white">
            <div className="flex items-center gap-3 mb-10">
              <div className="w-12 h-12 rounded-xl bg-white/15 backdrop-blur-sm border border-white/20 flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-emerald-300" />
              </div>
              <div>
                <h1 className="text-[22px] font-semibold tracking-tight">
                  Travel Pioneers
                </h1>
                <p className="text-[12.5px] text-white/60 -mt-0.5">
                  Powered by Destiny Media
                </p>
              </div>
            </div>
            <h2 className="text-[40px] font-semibold tracking-tight leading-[1.1] mb-5">
              AI Supplier
              <br />
              <span className="text-emerald-300">Intelligence Agent</span>
            </h2>
            <p className="text-[15.5px] text-white/75 leading-relaxed">
              Optimiza tu cadena de suministro con inteligencia artificial
              avanzada. Analiza proveedores, predice tendencias y toma
              decisiones informadas.
            </p>
            <ul className="mt-10 space-y-3.5 text-[14px] text-white/80">
              <li className="flex items-center gap-3">
                <span className="w-8 h-8 rounded-lg bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center shrink-0">
                  <LineChart className="w-4 h-4 text-emerald-300" />
                </span>
                <span>Analítica predictiva en tiempo real</span>
              </li>
              <li className="flex items-center gap-3">
                <span className="w-8 h-8 rounded-lg bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-4 h-4 text-emerald-300" />
                </span>
                <span>Seguridad empresarial con cifrado end-to-end</span>
              </li>
              <li className="flex items-center gap-3">
                <span className="w-8 h-8 rounded-lg bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4 text-emerald-300" />
                </span>
                <span>Impulsado por modelos de IA de última generación</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Right panel - form */}
        <div className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-background">
          <div className="w-full max-w-[420px] auth-surface rounded-2xl px-7 py-9 sm:px-9 sm:py-10 animate-auth-enter">
            <div className="lg:hidden flex items-center gap-3 mb-8">
              <div className="w-10 h-10 rounded-xl gradient-primary flex items-center justify-center shadow-[0_6px_20px_-6px_hsl(157_100%_45%/0.6)]">
                <Sparkles className="w-5 h-5 text-[#04150f]" />
              </div>
              <span className="text-xl font-semibold tracking-tight">
                Travel Pioneers
              </span>
            </div>

            <div className="mb-7">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-emerald-400/25 bg-emerald-400/10 text-emerald-300 text-[11px] font-medium tracking-wide uppercase">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
                Acceso seguro
              </span>
              <h2 className="text-[26px] font-semibold tracking-tight mt-4">
                Bienvenido de vuelta
              </h2>
              <p className="text-[14px] text-muted-foreground mt-1.5">
                Ingresa tus credenciales para acceder a la plataforma.
              </p>
            </div>

            {formError && (
              <div
                role="alert"
                className="mb-5 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
              >
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} noValidate className="space-y-5">
              <div>
                <label
                  htmlFor="email"
                  className="block text-[12.5px] font-medium text-foreground/90 mb-1.5"
                >
                  Correo Electrónico
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="tu@empresa.com"
                  autoComplete="email"
                  required
                  className="field-premium w-full h-11 px-4 rounded-lg text-[14px] text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="block text-[12.5px] font-medium text-foreground/90 mb-1.5"
                >
                  Contraseña
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    required
                    className="field-premium w-full h-11 px-4 pr-11 rounded-lg text-[14px] text-foreground placeholder:text-muted-foreground"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={
                      showPassword ? "Ocultar contraseña" : "Mostrar contraseña"
                    }
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-end text-[13px]">
                <button
                  type="button"
                  className="text-emerald-400 hover:text-emerald-300 transition-colors font-medium"
                >
                  ¿Olvidaste tu contraseña?
                </button>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="btn-premium w-full h-11 rounded-lg flex items-center justify-center gap-2"
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-[#04150f]/40 border-t-[#04150f] rounded-full animate-spin" />
                ) : (
                  "Iniciar Sesión"
                )}
              </button>
            </form>

            <p className="mt-7 text-center text-[13.5px] text-muted-foreground">
              ¿No tienes una cuenta?{" "}
              <Link
                href="/register"
                className="text-emerald-400 hover:text-emerald-300 transition-colors font-semibold"
              >
                Regístrate aquí
              </Link>
            </p>
          </div>
        </div>
      </div>
    </GuestGuard>
  );
}
