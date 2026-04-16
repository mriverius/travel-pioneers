"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Bot, Sparkles } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    // Simulate auth
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
            AI Supplier Intelligence Agent
          </h2>
          <p className="text-lg text-white/80 leading-relaxed">
            Optimiza tu cadena de suministro con inteligencia artificial
            avanzada. Analiza proveedores, predice tendencias y toma decisiones
            informadas.
          </p>
          <div className="mt-10 flex items-center gap-2 text-white/60 text-sm">
            <Sparkles className="w-4 h-4" />
            <span>Impulsado por modelos de IA de última generación</span>
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

          <h2 className="text-2xl font-bold mb-2">Iniciar Sesión</h2>
          <p className="text-muted-foreground mb-8">
            Ingresa tus credenciales para acceder a la plataforma
          </p>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium mb-2">
                Correo Electrónico
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
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
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
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

            <div className="flex items-center justify-between text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-border bg-secondary accent-emerald-500"
                />
                <span className="text-muted-foreground">Recordarme</span>
              </label>
              <button
                type="button"
                className="text-emerald-400 hover:text-emerald-300 transition-colors"
              >
                ¿Olvidaste tu contraseña?
              </button>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 rounded-lg gradient-primary text-white font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                "Iniciar Sesión"
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            ¿No tienes una cuenta?{" "}
            <Link
              href="/registro"
              className="text-emerald-400 hover:text-emerald-300 transition-colors font-medium"
            >
              Regístrate aquí
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
