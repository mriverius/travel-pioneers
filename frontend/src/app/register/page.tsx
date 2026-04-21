"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Check,
  Eye,
  EyeOff,
  LineChart,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  ApiError,
  api,
  saveSession,
  type ValidationDetail,
} from "@/lib/api";
import {
  PASSWORD_RULES,
  evaluatePassword,
  isPasswordValid,
} from "@/lib/passwordRules";
import GuestGuard from "@/components/guest-guard";

type FieldErrors = Partial<Record<"name" | "email" | "password", string>>;

export default function RegisterPage() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const update = (field: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (field in fieldErrors) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[field as keyof FieldErrors];
        return next;
      });
    }
    if (formError) setFormError(null);
  };

  const passwordChecks = useMemo(
    () => evaluatePassword(form.password),
    [form.password],
  );
  const passwordsMatch =
    form.confirmPassword.length === 0 ||
    form.password === form.confirmPassword;
  const passwordValid = isPasswordValid(form.password);
  const canSubmit =
    form.name.trim().length >= 2 &&
    form.email.trim().length > 0 &&
    passwordValid &&
    form.password === form.confirmPassword &&
    !loading;

  const applyBackendDetails = (details: ValidationDetail[]) => {
    if (details.length === 0) return;
    const next: FieldErrors = {};
    for (const d of details) {
      if (d.field === "name" || d.field === "email" || d.field === "password") {
        if (!next[d.field]) next[d.field] = d.message;
      }
    }
    setFieldErrors(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFieldErrors({});

    if (!passwordValid) {
      setFieldErrors({
        password: "La contraseña no cumple con todos los requisitos",
      });
      return;
    }
    if (form.password !== form.confirmPassword) {
      setFieldErrors({
        password: "Las contraseñas no coinciden",
      });
      return;
    }

    setLoading(true);
    try {
      const result = await api.register({
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        password: form.password,
      });
      saveSession(result);
      router.replace("/module/supplier-intelligence");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setFieldErrors({ email: "Ya existe una cuenta con ese correo" });
        } else if (err.status === 400) {
          applyBackendDetails(err.details);
          setFormError(err.details.length ? null : err.message);
        } else {
          setFormError(err.message);
        }
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
      <div className="min-h-screen flex bg-background">
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
              Únete a la revolución
              <br />
              <span className="text-emerald-300">de la IA</span>
            </h2>
            <p className="text-[15.5px] text-white/75 leading-relaxed">
              Crea tu cuenta y comienza a transformar la gestión de proveedores
              con inteligencia artificial avanzada.
            </p>
            <ul className="mt-10 space-y-3.5 text-[14px] text-white/80">
              <li className="flex items-center gap-3">
                <span className="w-8 h-8 rounded-lg bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center shrink-0">
                  <LineChart className="w-4 h-4 text-emerald-300" />
                </span>
                <span>Análisis predictivo de proveedores</span>
              </li>
              <li className="flex items-center gap-3">
                <span className="w-8 h-8 rounded-lg bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4 text-emerald-300" />
                </span>
                <span>Agentes de IA personalizados</span>
              </li>
              <li className="flex items-center gap-3">
                <span className="w-8 h-8 rounded-lg bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-4 h-4 text-emerald-300" />
                </span>
                <span>Seguridad empresarial con cifrado end-to-end</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Right panel - form */}
        <div className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-background">
          <div className="w-full max-w-[440px] auth-surface rounded-2xl px-7 py-8 sm:px-9 sm:py-9 animate-fade-up">
            <div className="lg:hidden flex items-center gap-3 mb-7">
              <div className="w-10 h-10 rounded-xl gradient-primary flex items-center justify-center shadow-[0_6px_20px_-6px_hsl(157_100%_45%/0.6)]">
                <Sparkles className="w-5 h-5 text-[#04150f]" />
              </div>
              <span className="text-xl font-semibold tracking-tight">
                Travel Pioneers
              </span>
            </div>

            <div className="mb-6">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-emerald-400/25 bg-emerald-400/10 text-emerald-300 text-[11px] font-medium tracking-wide uppercase">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
                Crear cuenta
              </span>
              <h2 className="text-[26px] font-semibold tracking-tight mt-4">
                Comienza en minutos
              </h2>
              <p className="text-[14px] text-muted-foreground mt-1.5">
                Completa el formulario para registrarte en la plataforma.
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

            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div>
                <label className="block text-[12.5px] font-medium text-foreground/90 mb-1.5">
                  Nombre Completo
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => update("name", e.target.value)}
                  placeholder="Juan Pérez"
                  required
                  minLength={2}
                  maxLength={120}
                  aria-invalid={Boolean(fieldErrors.name)}
                  className="field-premium w-full h-11 px-4 rounded-lg text-[14px] text-foreground placeholder:text-muted-foreground"
                />
                {fieldErrors.name && (
                  <p className="mt-1.5 text-xs text-destructive">
                    {fieldErrors.name}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-[12.5px] font-medium text-foreground/90 mb-1.5">
                  Correo Electrónico
                </label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => update("email", e.target.value)}
                  placeholder="tu@empresa.com"
                  required
                  autoComplete="email"
                  aria-invalid={Boolean(fieldErrors.email)}
                  className="field-premium w-full h-11 px-4 rounded-lg text-[14px] text-foreground placeholder:text-muted-foreground"
                />
                {fieldErrors.email && (
                  <p className="mt-1.5 text-xs text-destructive">
                    {fieldErrors.email}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-[12.5px] font-medium text-foreground/90 mb-1.5">
                  Contraseña
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={form.password}
                    onChange={(e) => update("password", e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    aria-invalid={Boolean(fieldErrors.password)}
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

                {(form.password.length > 0 || fieldErrors.password) && (
                  <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
                    {passwordChecks.map((rule) => (
                      <li
                        key={rule.id}
                        className={`flex items-center gap-1.5 text-[11.5px] ${
                          rule.passed
                            ? "text-emerald-300"
                            : "text-muted-foreground"
                        }`}
                      >
                        {rule.passed ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : (
                          <X className="w-3.5 h-3.5" />
                        )}
                        <span>
                          {PASSWORD_RULES.find((r) => r.id === rule.id)?.label}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {fieldErrors.password && (
                  <p className="mt-1.5 text-xs text-destructive">
                    {fieldErrors.password}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-[12.5px] font-medium text-foreground/90 mb-1.5">
                  Confirmar Contraseña
                </label>
                <input
                  type="password"
                  value={form.confirmPassword}
                  onChange={(e) => update("confirmPassword", e.target.value)}
                  placeholder="••••••••"
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  className="field-premium w-full h-11 px-4 rounded-lg text-[14px] text-foreground placeholder:text-muted-foreground"
                />
                {!passwordsMatch && (
                  <p className="mt-1.5 text-xs text-destructive">
                    Las contraseñas no coinciden
                  </p>
                )}
              </div>

              <div className="flex items-start gap-2 pt-1">
                <input
                  type="checkbox"
                  required
                  className="mt-1 w-4 h-4 rounded border-border bg-secondary accent-emerald-500"
                />
                <span className="text-[13px] text-muted-foreground">
                  Acepto los{" "}
                  <button
                    type="button"
                    className="text-emerald-400 hover:text-emerald-300 transition-colors font-medium"
                  >
                    Términos y Condiciones
                  </button>{" "}
                  y la{" "}
                  <button
                    type="button"
                    className="text-emerald-400 hover:text-emerald-300 transition-colors font-medium"
                  >
                    Política de Privacidad
                  </button>
                </span>
              </div>

              <button
                type="submit"
                disabled={!canSubmit}
                className="btn-premium w-full h-11 rounded-lg flex items-center justify-center gap-2 mt-1"
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-[#04150f]/40 border-t-[#04150f] rounded-full animate-spin" />
                ) : (
                  "Crear Cuenta"
                )}
              </button>
            </form>

            <p className="mt-6 text-center text-[13.5px] text-muted-foreground">
              ¿Ya tienes una cuenta?{" "}
              <Link
                href="/login"
                className="text-emerald-400 hover:text-emerald-300 transition-colors font-semibold"
              >
                Inicia sesión
              </Link>
            </p>
          </div>
        </div>
      </div>
    </GuestGuard>
  );
}
