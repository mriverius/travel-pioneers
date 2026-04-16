"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  Users,
  FolderOpen,
  Settings,
  LogOut,
  Menu,
  X,
  Sparkles,
} from "lucide-react";
import { useState } from "react";

const navItems = [
  {
    label: "Agentes IA",
    href: "/agentes",
    icon: Users,
    description: "Gestiona tus agentes",
  },
  {
    label: "Recursos",
    href: "/recursos",
    icon: FolderOpen,
    description: "Archivos y datos",
  },
  {
    label: "Configuración",
    href: "/configuracion",
    icon: Settings,
    description: "Ajustes del sistema",
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-4 left-4 z-50 w-10 h-10 rounded-lg bg-card border border-border flex items-center justify-center text-foreground hover:bg-secondary transition-colors"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/60"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 z-50 h-screen w-[260px] bg-sidebar border-r border-sidebar-border flex flex-col transition-transform duration-300 lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="p-5 border-b border-sidebar-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg gradient-primary flex items-center justify-center animate-pulse-glow">
                <Bot className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-sm font-bold text-foreground leading-tight">
                  Travel Pioneers
                </h1>
                <p className="text-[11px] text-muted-foreground">
                  Supplier Intelligence
                </p>
              </div>
            </div>
            <button
              onClick={() => setMobileOpen(false)}
              className="lg:hidden text-muted-foreground hover:text-foreground"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* AI Status badge */}
        <div className="px-4 pt-4 pb-2">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-xs font-medium text-emerald-400">
              IA Activa — Modelos listos
            </span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto">
          <p className="px-3 pt-3 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Módulos
          </p>
          {navItems.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={`group relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${
                  active
                    ? "bg-emerald-500/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-emerald-400" />
                )}
                <item.icon
                  className={`w-4.5 h-4.5 flex-shrink-0 ${
                    active ? "text-emerald-400" : "text-muted-foreground group-hover:text-foreground"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <span className="font-medium">{item.label}</span>
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-sidebar-border space-y-3">
          <div className="flex items-center gap-3 px-2">
            <div className="w-8 h-8 rounded-full gradient-primary flex items-center justify-center text-white text-xs font-bold">
              TP
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">Admin</p>
              <p className="text-[11px] text-muted-foreground truncate">
                admin@travelpioners.com
              </p>
            </div>
          </div>
          <Link
            href="/login"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
          >
            <LogOut className="w-4 h-4" />
            <span>Cerrar Sesión</span>
          </Link>
        </div>
      </aside>
    </>
  );
}
