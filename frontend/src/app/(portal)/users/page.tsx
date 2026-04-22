"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  ArrowDownAZ,
  ArrowUpAZ,
  ChevronLeft,
  ChevronRight,
  Eye,
  Pencil,
  RefreshCcw,
  Search,
  Shield,
  Trash2,
  Users as UsersIcon,
  X,
} from "lucide-react";
import { Select } from "@/components/ui/select";
import AdminGuard from "@/components/admin-guard";
import {
  ApiError,
  api,
  type ManagedUser,
  type Role,
  type ValidationDetail,
} from "@/lib/api";
import { useAuth } from "@/lib/useAuth";

type ViewId = "supplier-intelligence" | "resources" | "users";

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "admin", label: "Administrador" },
  { value: "member", label: "Miembro" },
];

const ROLE_LABEL: Record<Role, string> = {
  admin: "Administrador",
  member: "Miembro",
};

const ROLE_TONE: Record<Role, string> = {
  admin: "bg-primary/15 text-primary border-primary/30",
  member: "bg-sky-500/15 text-sky-300 border-sky-500/30",
};

const AVAILABLE_VIEWS: { id: ViewId; label: string; description: string }[] = [
  {
    id: "supplier-intelligence",
    label: "AI Supplier Intelligence",
    description: "Procesamiento de contratos y generación de plantillas",
  },
  {
    id: "resources",
    label: "Cómo usar el sistema",
    description: "Guías, documentación y preguntas frecuentes",
  },
  {
    id: "users",
    label: "Gestión de usuarios",
    description: "Administrar usuarios, roles y permisos",
  },
];

type DraftUser = {
  name: string;
  email: string;
  role: Role;
  views: ViewId[];
};

/** Narrow a raw backend view string onto our known view ids. */
function toViewIds(views: string[]): ViewId[] {
  const allowed = new Set<string>(AVAILABLE_VIEWS.map((v) => v.id));
  return views.filter((v): v is ViewId => allowed.has(v));
}

export default function UsersPage() {
  return (
    <AdminGuard>
      <UsersPageContent />
    </AdminGuard>
  );
}

function UsersPageContent() {
  const { session } = useAuth();
  const currentUserId = session?.user.id ?? null;

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [editing, setEditing] = useState<ManagedUser | null>(null);

  // Initial load. State starts as { loading: true, loadError: null, users: [] },
  // so the effect doesn't need to touch state synchronously — it only writes
  // once the fetch settles. The `cancelled` flag guards against writing into
  // an unmounted component during StrictMode's double-invoke or a fast route
  // change.
  useEffect(() => {
    let cancelled = false;
    api.users
      .list()
      .then(({ users: fetched }) => {
        if (cancelled) return;
        setUsers(fetched);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(describeError(err, "No se pudieron cargar los usuarios."));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-fetch on demand (retry banner, refresh button). Always invoked from an
  // event handler, so synchronous setState is fine here.
  const reloadUsers = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { users: fetched } = await api.users.list();
      setUsers(fetched);
    } catch (err) {
      setLoadError(describeError(err, "No se pudieron cargar los usuarios."));
    } finally {
      setLoading(false);
    }
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      const matchesQuery =
        !q ||
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q);
      const matchesRole = roleFilter === "all" || u.role === roleFilter;
      return matchesQuery && matchesRole;
    });
  }, [users, search, roleFilter]);

  // Alphabetic sort by name. `localeCompare` with the "es" locale + `base`
  // sensitivity gives natural ordering for Spanish names (accents and case
  // collapse instead of sorting separately).
  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) =>
      a.name.localeCompare(b.name, "es", { sensitivity: "base" }),
    );
    return sortDir === "asc" ? copy : copy.reverse();
  }, [filtered, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  // Clamp the visible page so we never render an empty trailing page after
  // a filter change shrinks the result set. We use `safePage` everywhere in
  // render; the raw `page` state is only updated through handlers, so drift
  // is purely transient and corrects itself on the next interaction.
  const safePage = Math.min(page, totalPages);

  const paginated = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, safePage, pageSize]);

  const rangeStart = sorted.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const rangeEnd = Math.min(safePage * pageSize, sorted.length);

  // Any filter/sort/page-size change should jump back to page 1 so users
  // always land on the first batch of the new result set. We do this inline
  // from each handler rather than in a useEffect to avoid the cascading
  // render pattern the React 19 lint rule warns about.
  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
  };
  const handleRoleFilterChange = (value: Role | "all") => {
    setRoleFilter(value);
    setPage(1);
  };
  const handleSortDirChange = (value: "asc" | "desc") => {
    setSortDir(value);
    setPage(1);
  };
  const handlePageSizeChange = (value: number) => {
    setPageSize(value);
    setPage(1);
  };

  const stats = useMemo(() => {
    const byRole = users.reduce<Record<Role, number>>(
      (acc, u) => {
        acc[u.role] += 1;
        return acc;
      },
      { admin: 0, member: 0 },
    );
    return { total: users.length, ...byRole };
  }, [users]);

  const updateRole = async (u: ManagedUser, role: Role) => {
    if (u.role === role) return;
    setActionError(null);
    // Optimistic update.
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, role } : x)));
    try {
      const { user } = await api.users.update(u.id, { role });
      setUsers((prev) => prev.map((x) => (x.id === user.id ? user : x)));
    } catch (err) {
      // Rollback.
      setUsers((prev) =>
        prev.map((x) => (x.id === u.id ? { ...x, role: u.role } : x)),
      );
      setActionError(describeError(err, "No se pudo cambiar el rol."));
    }
  };

  const toggleView = async (u: ManagedUser, view: ViewId) => {
    const has = u.views.includes(view);
    const nextViews = has
      ? u.views.filter((v) => v !== view)
      : [...u.views, view];
    setActionError(null);
    setUsers((prev) =>
      prev.map((x) => (x.id === u.id ? { ...x, views: nextViews } : x)),
    );
    try {
      const { user } = await api.users.update(u.id, { views: nextViews });
      setUsers((prev) => prev.map((x) => (x.id === user.id ? user : x)));
    } catch (err) {
      setUsers((prev) =>
        prev.map((x) => (x.id === u.id ? { ...x, views: u.views } : x)),
      );
      setActionError(describeError(err, "No se pudieron guardar las vistas."));
    }
  };

  const removeUser = async (u: ManagedUser) => {
    if (u.id === currentUserId) {
      setActionError("No puedes eliminar tu propia cuenta desde aquí.");
      return;
    }
    if (!confirm(`¿Eliminar a ${u.name}? Esta acción no se puede deshacer.`)) {
      return;
    }
    setActionError(null);
    const prev = users;
    setUsers((list) => list.filter((x) => x.id !== u.id));
    try {
      await api.users.remove(u.id);
    } catch (err) {
      setUsers(prev);
      setActionError(describeError(err, "No se pudo eliminar el usuario."));
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 pl-12 lg:pl-0">
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-foreground">
            Gestión de usuarios
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            Administra usuarios, roles y los accesos que cada persona tiene en
            el portal.
          </p>
        </div>
        <div className="flex items-center gap-2 self-stretch sm:self-auto">
          <button
            type="button"
            onClick={() => void reloadUsers()}
            disabled={loading}
            className="inline-flex items-center gap-2 h-10 px-3 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-50"
            aria-label="Refrescar"
            title="Refrescar"
          >
            <RefreshCcw
              className={`w-4 h-4 ${loading ? "animate-spin" : ""}`}
            />
          </button>
        </div>
      </header>

      {loadError && (
        <BannerError message={loadError} onRetry={() => void reloadUsers()} />
      )}
      {actionError && (
        <BannerError
          message={actionError}
          onDismiss={() => setActionError(null)}
        />
      )}

      {/* Stats */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Total" value={stats.total} tone="muted" />
        <StatCard label="Administradores" value={stats.admin} tone="primary" />
        <StatCard label="Miembros" value={stats.member} tone="sky" />
      </section>

      {/* Filters */}
      <section className="bg-card/80 border border-border rounded-xl p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Buscar por nombre o email"
            className="w-full h-10 pl-9 pr-3 rounded-md bg-input/70 border border-border text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/30 transition-colors"
          />
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-muted-foreground">Orden:</span>
            <div className="w-44">
              <Select
                options={[
                  { value: "asc", label: "Nombre (A → Z)" },
                  { value: "desc", label: "Nombre (Z → A)" },
                ]}
                value={sortDir}
                onChange={(e) =>
                  handleSortDirChange(e.target.value as "asc" | "desc")
                }
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-muted-foreground">Rol:</span>
            <div className="w-44">
              <Select
                options={[
                  { value: "all", label: "Todos los roles" },
                  ...ROLE_OPTIONS,
                ]}
                value={roleFilter}
                onChange={(e) =>
                  handleRoleFilterChange(e.target.value as Role | "all")
                }
              />
            </div>
          </div>
        </div>
      </section>

      {/* Table */}
      <section className="bg-card/80 border border-border rounded-xl overflow-hidden">
        <header className="flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-border">
          <UsersIcon className="w-5 h-5 text-primary" />
          <h2 className="text-[15px] font-semibold">
            Usuarios{" "}
            <span className="text-muted-foreground font-normal">
              ({loading ? "…" : sorted.length})
            </span>
          </h2>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 text-[12px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <Th>
                  <button
                    type="button"
                    onClick={() =>
                      handleSortDirChange(sortDir === "asc" ? "desc" : "asc")
                    }
                    className="inline-flex items-center gap-1.5 uppercase tracking-wider text-[12px] font-semibold hover:text-foreground transition-colors"
                    title={
                      sortDir === "asc"
                        ? "Ordenar Z → A"
                        : "Ordenar A → Z"
                    }
                    aria-label={
                      sortDir === "asc"
                        ? "Ordenar descendente"
                        : "Ordenar ascendente"
                    }
                  >
                    Usuario
                    {sortDir === "asc" ? (
                      <ArrowDownAZ className="w-3.5 h-3.5 text-primary" />
                    ) : (
                      <ArrowUpAZ className="w-3.5 h-3.5 text-primary" />
                    )}
                  </button>
                </Th>
                <Th>Rol</Th>
                <Th>Vistas con acceso</Th>
                <Th className="text-right pr-6">Acciones</Th>
              </tr>
            </thead>
            <tbody>
              {loading && users.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-6 py-10 text-center text-muted-foreground text-[13px]"
                  >
                    <div className="inline-flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                      Cargando usuarios…
                    </div>
                  </td>
                </tr>
              )}
              {!loading && sorted.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-6 py-10 text-center text-muted-foreground text-[13px]"
                  >
                    {users.length === 0
                      ? "Aún no hay usuarios. Crea el primero."
                      : "No hay usuarios que coincidan con los filtros."}
                  </td>
                </tr>
              )}
              {paginated.map((u) => {
                const isSelf = u.id === currentUserId;
                return (
                  <tr
                    key={u.id}
                    className="border-t border-border/60 hover:bg-secondary/20 transition-colors"
                  >
                    <td className="px-6 py-4 align-top">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center text-primary text-[12px] font-semibold shrink-0">
                          {initials(u.name)}
                        </div>
                        <div className="min-w-0">
                          <p className="text-[13.5px] font-semibold text-foreground truncate flex items-center gap-2">
                            {u.name}
                            {isSelf && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-primary/15 text-primary text-[10px] font-medium border border-primary/30">
                                Tú
                              </span>
                            )}
                          </p>
                          <p className="text-[12px] text-muted-foreground truncate">
                            {u.email}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 align-top">
                      <div className="flex flex-col gap-2">
                        <span
                          className={`inline-flex items-center gap-1.5 w-fit px-2 py-0.5 rounded-full text-[11.5px] font-medium border ${ROLE_TONE[u.role]}`}
                        >
                          <Shield className="w-3 h-3" />
                          {ROLE_LABEL[u.role]}
                        </span>
                        <div className="w-44">
                          <Select
                            options={ROLE_OPTIONS}
                            value={u.role}
                            disabled={isSelf}
                            title={
                              isSelf
                                ? "No puedes cambiar tu propio rol"
                                : undefined
                            }
                            onChange={(e) =>
                              void updateRole(u, e.target.value as Role)
                            }
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 align-top">
                      <div className="flex flex-wrap gap-1.5 max-w-[360px]">
                        {AVAILABLE_VIEWS.map((v) => {
                          const enabled = u.views.includes(v.id);
                          return (
                            <button
                              key={v.id}
                              type="button"
                              onClick={() => void toggleView(u, v.id)}
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] border transition-colors ${
                                enabled
                                  ? "bg-primary/10 border-primary/40 text-primary"
                                  : "bg-secondary/50 border-border text-muted-foreground hover:bg-secondary"
                              }`}
                              title={v.description}
                            >
                              <Eye className="w-3 h-3" />
                              {v.label}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-6 py-4 align-top">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setEditing(u)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-border text-[12px] hover:bg-secondary/60 transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          Editar
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeUser(u)}
                          disabled={isSelf}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-destructive/40 text-destructive text-[12px] hover:bg-destructive/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          aria-label={`Eliminar a ${u.name}`}
                          title={
                            isSelf
                              ? "No puedes eliminarte a ti mismo"
                              : undefined
                          }
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {sorted.length > 0 && (
          <Pagination
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            total={sorted.length}
            page={safePage}
            totalPages={totalPages}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={handlePageSizeChange}
          />
        )}
      </section>

      {editing && (
        <UserDialog
          user={editing}
          isSelf={editing.id === currentUserId}
          onClose={() => setEditing(null)}
          onUpdate={async (id, payload) => {
            const { user } = await api.users.update(id, payload);
            setUsers((prev) => prev.map((x) => (x.id === id ? user : x)));
          }}
        />
      )}
    </div>
  );
}

/* ----------------------------- subcomponents ----------------------------- */

function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.details.length > 0) {
      return err.details.map((d) => d.message).join(", ");
    }
    return err.message || fallback;
  }
  if (err instanceof TypeError) {
    return "No se pudo contactar con el servidor. Revisa tu conexión.";
  }
  return fallback;
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`text-left font-semibold px-6 py-3 ${className}`}
    >
      {children}
    </th>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "primary" | "amber" | "sky" | "muted";
}) {
  const tones: Record<typeof tone, string> = {
    primary: "text-primary",
    amber: "text-amber-300",
    sky: "text-sky-300",
    muted: "text-muted-foreground",
  };
  return (
    <div className="bg-card/80 border border-border rounded-xl px-4 py-3.5">
      <p className="text-[11.5px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={`text-[22px] font-bold mt-1 ${tones[tone]}`}>{value}</p>
    </div>
  );
}

function Pagination({
  rangeStart,
  rangeEnd,
  total,
  page,
  totalPages,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  rangeStart: number;
  rangeEnd: number;
  total: number;
  page: number;
  totalPages: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  // Build the page-number pill list. For long result sets, collapse the
  // middle with "…" so we never render an unbounded strip of buttons.
  const pages = buildPageList(page, totalPages);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-4 sm:px-6 py-3 border-t border-border bg-secondary/20">
      <div className="flex items-center gap-3 text-[12.5px] text-muted-foreground">
        <span>
          Mostrando{" "}
          <span className="font-semibold text-foreground">
            {rangeStart}–{rangeEnd}
          </span>{" "}
          de <span className="font-semibold text-foreground">{total}</span>
        </span>
        <span className="hidden sm:inline-block h-4 w-px bg-border" />
        <div className="hidden sm:flex items-center gap-2">
          <span>Por página:</span>
          <div className="w-20">
            <Select
              options={[
                { value: "10", label: "10" },
                { value: "25", label: "25" },
                { value: "50", label: "50" },
              ]}
              value={String(pageSize)}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Página anterior"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        {pages.map((p, i) =>
          p === "…" ? (
            <span
              key={`gap-${i}`}
              className="px-1.5 text-[12.5px] text-muted-foreground select-none"
            >
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              aria-current={p === page ? "page" : undefined}
              className={`min-w-[32px] h-8 px-2 rounded-md text-[12.5px] font-medium border transition-colors ${
                p === page
                  ? "bg-primary/15 border-primary/40 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60"
              }`}
            >
              {p}
            </button>
          ),
        )}

        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Página siguiente"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Compact page number strip. Always shows first / last page, the current
 * page, and its immediate neighbours. Gaps are filled with "…" sentinels.
 *
 * Examples (current page in parens):
 *   totalPages=5, page=(3) → [1, 2, (3), 4, 5]
 *   totalPages=10, page=(1) → [(1), 2, 3, "…", 10]
 *   totalPages=10, page=(5) → [1, "…", 4, (5), 6, "…", 10]
 *   totalPages=10, page=(10) → [1, "…", 8, 9, (10)]
 */
function buildPageList(page: number, totalPages: number): (number | "…")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const out: (number | "…")[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  if (start > 2) out.push("…");
  for (let i = start; i <= end; i++) out.push(i);
  if (end < totalPages - 1) out.push("…");
  out.push(totalPages);
  return out;
}

function BannerError({
  message,
  onRetry,
  onDismiss,
}: {
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
    >
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="px-2 py-0.5 rounded-md border border-destructive/40 text-[12px] hover:bg-destructive/20 transition-colors"
        >
          Reintentar
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Descartar"
          className="text-destructive/70 hover:text-destructive"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function UserDialog({
  user,
  isSelf,
  onClose,
  onUpdate,
}: {
  user: ManagedUser;
  isSelf: boolean;
  onClose: () => void;
  onUpdate: (id: string, payload: Partial<DraftUser>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftUser>({
    name: user.name,
    email: user.email,
    role: user.role,
    views: toViewIds(user.views),
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<"name" | "email", string>>
  >({});

  const update = <K extends keyof DraftUser>(key: K, value: DraftUser[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const toggleView = (view: ViewId) =>
    setDraft((prev) => ({
      ...prev,
      views: prev.views.includes(view)
        ? prev.views.filter((v) => v !== view)
        : [...prev.views, view],
    }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    if (!draft.name.trim() || !draft.email.trim()) {
      setError("Nombre y correo son obligatorios.");
      return;
    }
    setSubmitting(true);
    try {
      // Only send changed fields to avoid unnecessary writes — backend
      // accepts partial PATCH anyway.
      const payload: Partial<DraftUser> = {};
      if (draft.name !== user.name) payload.name = draft.name;
      if (!isSelf && draft.role !== user.role) payload.role = draft.role;
      const sameViews =
        draft.views.length === user.views.length &&
        draft.views.every((v) => user.views.includes(v));
      if (!sameViews) payload.views = draft.views;
      if (Object.keys(payload).length === 0) {
        onClose();
        return;
      }
      await onUpdate(user.id, payload);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        applyFieldErrors(err.details, setFieldErrors);
        setError(
          err.details.length === 0
            ? err.message
            : "Revisa los errores señalados arriba.",
        );
      } else {
        setError(describeError(err, "No se pudo guardar."));
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Lock body scroll while the modal is open, and close on Escape. The
  // modal itself is rendered through a portal attached to <body> so it
  // escapes any transformed ancestor (e.g. the `animate-fade-up` wrapper in
  // the portal layout) — without that, `fixed inset-0` is positioned
  // relative to the transformed ancestor instead of the viewport, which
  // causes the modal to appear off-center.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // `createPortal` must not run during SSR — guard against a missing window.
  if (typeof window === "undefined") return null;

  const modal = (
    <div
      className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain bg-black/60 p-4 sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* Flex wrapper handles centering; min-h-full + my-auto keeps the modal
          centered when it fits, and lets it scroll when it doesn't. */}
      <div className="flex min-h-full items-center justify-center">
        <form
          onSubmit={handleSubmit}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl animate-fade-in my-auto"
        >
          <header className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-border">
            <h3 className="text-[15px] font-semibold">Editar usuario</h3>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Cerrar"
            >
              <X className="w-4 h-4" />
            </button>
          </header>

          <div className="p-4 sm:p-6 space-y-4">
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[12.5px] text-destructive"
              >
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Field label="Nombre completo" error={fieldErrors.name}>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => update("name", e.target.value)}
                required
                minLength={2}
                maxLength={120}
                className="w-full h-10 px-3 rounded-md bg-input/70 border border-border text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/30 transition-colors"
              />
            </Field>
            <Field label="Correo electrónico" error={fieldErrors.email}>
              <input
                type="email"
                value={draft.email}
                onChange={(e) => update("email", e.target.value)}
                required
                disabled
                className="w-full h-10 px-3 rounded-md bg-input/70 border border-border text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/30 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                El correo no puede modificarse después de creado el usuario.
              </p>
            </Field>

            <Field label="Rol">
              <Select
                options={ROLE_OPTIONS}
                value={draft.role}
                disabled={isSelf}
                onChange={(e) => update("role", e.target.value as Role)}
              />
              {isSelf && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  No puedes cambiar tu propio rol desde esta pantalla.
                </p>
              )}
            </Field>

            <div>
              <p className="text-[12.5px] font-medium text-muted-foreground mb-2">
                Vistas con acceso
              </p>
              <div className="space-y-2">
                {AVAILABLE_VIEWS.map((v) => {
                  const checked = draft.views.includes(v.id);
                  return (
                    <label
                      key={v.id}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        checked
                          ? "bg-primary/10 border-primary/40"
                          : "bg-secondary/40 border-border hover:bg-secondary/60"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleView(v.id)}
                        className="mt-0.5 w-4 h-4 rounded border-border bg-secondary accent-primary"
                      />
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-foreground">
                          {v.label}
                        </p>
                        <p className="text-[12px] text-muted-foreground mt-0.5">
                          {v.description}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>

          <footer className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center sm:justify-end gap-2 px-4 sm:px-6 py-4 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3.5 py-2 rounded-md border border-border text-[13px] hover:bg-secondary/60 transition-colors disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-md gradient-primary text-white text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {submitting && (
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              )}
              Guardar cambios
            </button>
          </footer>
        </form>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function applyFieldErrors(
  details: ValidationDetail[],
  setFieldErrors: React.Dispatch<
    React.SetStateAction<Partial<Record<"name" | "email", string>>>
  >,
) {
  if (details.length === 0) return;
  const next: Partial<Record<"name" | "email", string>> = {};
  for (const d of details) {
    if (d.field === "name" || d.field === "email") {
      if (!next[d.field]) next[d.field] = d.message;
    }
  }
  setFieldErrors(next);
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[12.5px] font-medium text-muted-foreground mb-1.5">
        {label}
      </span>
      {children}
      {error && <p className="mt-1 text-[11.5px] text-destructive">{error}</p>}
    </label>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}
