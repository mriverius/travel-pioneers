"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  FileSearch,
  History,
  BookOpen,
  Users as UsersIcon,
  Menu,
  X,
  LogOut,
} from "lucide-react";
import { useState, type ComponentType, type SVGProps } from "react";
import { useAuth } from "@/lib/useAuth";

type NavItem = {
  label: string;
  href: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Only render for users matching this role. Omit = visible to everyone. */
  adminOnly?: boolean;
  /**
   * Sub-items anidados visualmente debajo del padre. Útiles para vistas
   * estrechamente relacionadas con el item padre (ej. "Historial de
   * contratos" debajo de "Supplier Intelligence").
   */
  children?: NavItem[];
};

const agentItems: NavItem[] = [
  {
    label: "AI Supplier Intelligence Agent",
    href: "/agent/supplier-intelligence",
    icon: FileSearch,
    children: [
      {
        label: "Historial de contratos",
        href: "/agent/supplier-intelligence/history",
        icon: History,
      },
    ],
  },
];

const configItems: NavItem[] = [
  { label: "Cómo usar el sistema", href: "/resources", icon: BookOpen },
  {
    label: "Gestión de usuarios",
    href: "/users",
    icon: UsersIcon,
    adminOnly: true,
  },
];

function NavLink({
  item,
  active,
  onNavigate,
  nested = false,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
  /**
   * Cuando es true, el link se renderiza con indent + tipografía algo más
   * pequeña, y un guía vertical sutil a la izquierda — visualmente sub-item
   * del padre que está justo arriba.
   */
  nested?: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={`group relative flex items-center gap-2.5 pr-3 py-2 rounded-md transition-all duration-200 ${
        nested ? "ml-3 pl-5 text-[12.5px] border-l border-sidebar-border" : "pl-4 py-2.5 text-[13px]"
      } ${
        active
          ? "bg-primary/10 text-foreground active-glow"
          : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
      }`}
    >
      <Icon
        className={`flex-shrink-0 ${nested ? "w-3.5 h-3.5" : "w-4 h-4"} ${
          active ? "text-primary" : "text-muted-foreground"
        }`}
      />
      <span className="font-medium truncate">{item.label}</span>
    </Link>
  );
}

function initials(name: string | undefined, fallback: string) {
  if (!name) return fallback;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { session, signOut } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const close = () => setMobileOpen(false);

  const handleSignOut = () => {
    signOut();
    router.replace("/login");
  };

  const user = session?.user;
  const displayName = user?.name ?? "—";
  const displayEmail = user?.email ?? "";
  const avatar = initials(user?.name, "TP");
  const isAdmin = user?.role === "admin";

  const visibleConfigItems = configItems.filter(
    (item) => !item.adminOnly || isAdmin,
  );

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
              href="/agent/supplier-intelligence"
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
            {agentItems.map((item) => {
              // Padre: activo solo si la ruta es EXACTAMENTE el padre. De lo
              // contrario, los sub-items (que son rutas que empiezan con el
              // padre) marcarían los dos como activos a la vez.
              const parentActive = pathname === item.href;
              return (
                <div key={item.href} className="space-y-1">
                  <NavLink
                    item={item}
                    active={parentActive}
                    onNavigate={close}
                  />
                  {item.children?.map((child) => (
                    <NavLink
                      key={child.href}
                      item={child}
                      active={pathname === child.href}
                      onNavigate={close}
                      nested
                    />
                  ))}
                </div>
              );
            })}
          </div>

          {visibleConfigItems.length > 0 && (
            <>
              <p className="px-3 pb-2 text-[10px] uppercase tracking-[0.15em] text-muted-foreground/80 font-semibold">
                Configuración
              </p>
              <div className="space-y-1">
                {visibleConfigItems.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={pathname === item.href}
                    onNavigate={close}
                  />
                ))}
              </div>
            </>
          )}
        </nav>

        {/* Account footer */}
        <div className="border-t border-sidebar-border p-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-primary text-xs font-semibold shrink-0">
              {avatar}
            </div>
            <div className="flex-1 min-w-0 leading-tight">
              <p
                className="text-[13px] font-semibold text-foreground truncate"
                title={displayName}
              >
                {displayName}
              </p>
              <p
                className="text-[11px] text-muted-foreground truncate"
                title={displayEmail}
              >
                {displayEmail}
              </p>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              aria-label="Cerrar sesión"
              title="Cerrar sesión"
              className="shrink-0 w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/50 hover:bg-destructive/5 transition-colors flex items-center justify-center"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground/70 text-center mt-3">
            Powered by Destiny Media
          </p>
        </div>
      </aside>
    </>
  );
}
