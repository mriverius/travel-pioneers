"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Bot, Sparkles } from "lucide-react";

export default function RegistroPage() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    company: "",
    password: "",
    confirmPassword: "",
  });

  const update = (field: string, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirmPassword) return;
    setLoading(true);
    await new Promise((r) => setTimeout(r, 800));
    setLoading(false);
    router.push("/agentes");
  };

  return (
    <div className="min-h-screen flex">
      {/* Left panel - branding */}
      <div className="hidden lg:flex lg:w-1/2 relative gradient-primary items-center justify-center p-12">
        <div className="absolute inset-0 bg-black/20" />
        <div className="relative z-10 max-w-md text-white">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center">
              <Bot className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Travel Pioneers</h1>
              <p className="text-sm text-white/70">Powered by Destiny Media</p>
            </div>
          </div>
          <h2 className="text-4xl font-bold leading-tight mb-4">
            Únete a la revolución de IA
          </h2>
          <p className="text-lg text-white/80 leading-relaxed">
            Crea tu cuenta y comienza a transformar la gestión de proveedores
            con inteligencia artificial avanzada.
          </p>
          <div className="mt-10 space-y-3 text-white/70 text-sm">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              <span>Análisis predictivo de proveedores</span>
            </div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              <span>Agentes de IA personalizados</span>
            </div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              <span>Informes y dashboards en tiempo real</span>
            </div>
          </div>
        </div>
      </div>

      {/* Right panel - form */}
      <div className="flex-1 flex items-center justify-center p-8 bg-background">
        <div className="w-full max-w-md animate-fade-in">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl gradient-primary flex items-center justify-center">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-bold">Travel Pioneers</span>
          </div>

          <h2 className="text-2xl font-bold mb-2">Crear Cuenta</h2>
          <p className="text-muted-foreground mb-8">
            Completa el formulario para registrarte en la plataforma
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">
                  Nombre Completo
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => update("name", e.target.value)}
                  placeholder="Juan Pérez"
                  required
                  className="w-full h-11 px-4 rounded-lg bg-secondary border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  Empresa
                </label>
                <input
                  type="text"
                  value={form.company}
                  onChange={(e) => update("company", e.target.value)}
                  placeholder="Mi Empresa S.A."
                  className="w-full h-11 px-4 rounded-lg bg-secondary border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                Correo Electrónico
              </label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => update("email", e.target.value)}
                placeholder="tu@empresa.com"
                required
                className="w-full h-11 px-4 rounded-lg bg-secondary border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
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
                  className="w-full h-11 px-4 pr-11 rounded-lg bg-secondary border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
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

            <div>
              <label className="block text-sm font-medium mb-2">
                Confirmar Contraseña
              </label>
              <input
                type="password"
                value={form.confirmPassword}
                onChange={(e) => update("confirmPassword", e.target.value)}
                placeholder="••••••••"
                required
                minLength={8}
                className="w-full h-11 px-4 rounded-lg bg-secondary border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
              />
              {form.confirmPassword &&
                form.password !== form.confirmPassword && (
                  <p className="mt-1 text-xs text-destructive">
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
              <span className="text-sm text-muted-foreground">
                Acepto los{" "}
                <button
                  type="button"
                  className="text-emerald-400 hover:text-emerald-300 transition-colors"
                >
                  Términos y Condiciones
                </button>{" "}
                y la{" "}
                <button
                  type="button"
                  className="text-emerald-400 hover:text-emerald-300 transition-colors"
                >
                  Política de Privacidad
                </button>
              </span>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 rounded-lg gradient-primary text-white font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                "Crear Cuenta"
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            ¿Ya tienes una cuenta?{" "}
            <Link
              href="/login"
              className="text-emerald-400 hover:text-emerald-300 transition-colors font-medium"
            >
              Inicia sesión
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
