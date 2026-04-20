"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileSearch,
  BookOpen,
  Settings,
  Menu,
  X,
} from "lucide-react";
import { useState, type ComponentType, type SVGProps } from "react";

type NavItem = {
  label: string;
  href: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
};

const agentItems: NavItem[] = [
  {
    label: "AI Supplier Intelligence Agent",
    href: "/module/supplier-intelligence",
    icon: FileSearch,
  },
];

const configItems: NavItem[] = [
  { label: "Cómo usar el sistema", href: "/resources", icon: BookOpen },
  { label: "Configuración del Portal", href: "/settings", icon: Settings },
];

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={`group relative flex items-center gap-2.5 pl-4 pr-3 py-2.5 rounded-md text-[13px] transition-all duration-200 ${
        active
          ? "bg-primary/10 text-foreground active-glow"
          : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
      }`}
    >
      <Icon
        className={`w-4 h-4 flex-shrink-0 ${
          active ? "text-primary" : "text-muted-foreground"
        }`}
      />
      <span className="font-medium truncate">{item.label}</span>
    </Link>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const close = () => setMobileOpen(false);

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-4 left-4 z-50 w-10 h-10 rounded-lg bg-card border border-border flex items-center justify-center text-foreground hover:bg-secondary transition-colors"
        aria-label="Abrir menú"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/60"
          onClick={close}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 z-50 h-screen w-[260px] gradient-sidebar border-r border-sidebar-border flex flex-col transition-transform duration-300 lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Brand */}
        <div className="px-4 pt-5 pb-4 border-b border-sidebar-border">
          <div className="flex items-center justify-between">
            <Link
              href="/module/supplier-intelligence"
              className="flex items-center gap-3 group"
              onClick={close}
            >
              <div className="w-9 h-9 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center animate-pulse-glow">
                <FileSearch className="w-4 h-4 text-primary" />
              </div>
              <div className="leading-tight">
                <p className="text-[13px] font-semibold text-foreground">
                  Travel Pioneers
                </p>
                <p className="text-[11px] text-muted-foreground">
                  AI Supplier Intelligence
                </p>
              </div>
            </Link>
            <button
              onClick={close}
              className="lg:hidden text-muted-foreground hover:text-foreground"
              aria-label="Cerrar menú"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto">
          <p className="px-3 pb-2 text-[10px] uppercase tracking-[0.15em] text-muted-foreground/80 font-semibold">
            Agente de IA
          </p>
          <div className="space-y-1 mb-5">
            {agentItems.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={pathname.startsWith(item.href)}
                onNavigate={close}
              />
            ))}
          </div>

          <p className="px-3 pb-2 text-[10px] uppercase tracking-[0.15em] text-muted-foreground/80 font-semibold">
            Configuración
          </p>
          <div className="space-y-1">
            {configItems.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={pathname === item.href}
                onNavigate={close}
              />
            ))}
          </div>
        </nav>

        {/* Account footer */}
        <div className="border-t border-sidebar-border p-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-primary text-xs font-semibold">
              TP
            </div>
            <div className="flex-1 min-w-0 leading-tight">
              <p className="text-[13px] font-semibold text-foreground truncate">
                Travel Pioneers
              </p>
              <p className="text-[11px] text-muted-foreground truncate">
                demo@travelpioners.com
              </p>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground/70 text-center mt-2">
            Powered by Destiny Media
          </p>
        </div>
      </aside>
    </>
  );
}
