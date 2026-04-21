"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Clipboard,
  Eye,
  KeyRound,
  Pencil,
  Plus,
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

type ViewId =
  | "supplier-intelligence"
  | "resources"
  | "settings"
  | "users";

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
    id: "settings",
    label: "Configuración del Portal",
    description: "Preferencias, empresa y seguridad",
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

const emptyDraft: DraftUser = {
  name: "",
  email: "",
  role: "member",
  views: ["supplier-intelligence"],
};

/** Narrow a raw backend view string onto our known view ids. */
function toViewIds(views: string[]): ViewId[] {
  const allowed = new Set<string>(AVAILABLE_VIEWS.map((v) => v.id));
  return views.filter((v): v is ViewId => allowed.has(v));
}

interface CreatedPasswordBanner {
  email: string;
  name: string;
  password: string;
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
  const currentUserRole = session?.user.role ?? null;

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createdPassword, setCreatedPassword] =
    useState<CreatedPasswordBanner | null>(null);

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [creating, setCreating] = useState(false);

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
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-foreground">
            Gestión de usuarios
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            Administra usuarios, roles y los accesos que cada persona tiene en
            el portal.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          <button
            type="button"
            onClick={() => setCreating(true)}
            disabled={currentUserRole !== "admin"}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-md gradient-primary text-white text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
            Nuevo usuario
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
      {createdPassword && (
        <TempPasswordBanner
          data={createdPassword}
          onDismiss={() => setCreatedPassword(null)}
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
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o email"
            className="w-full h-10 pl-9 pr-3 rounded-md bg-input/70 border border-border text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/30 transition-colors"
          />
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
              onChange={(e) => setRoleFilter(e.target.value as Role | "all")}
            />
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
              ({loading ? "…" : filtered.length})
            </span>
          </h2>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 text-[12px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <Th>Usuario</Th>
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
              {!loading && filtered.length === 0 && (
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
              {filtered.map((u) => {
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
                          title={isSelf ? "No puedes eliminarte a ti mismo" : undefined}
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
      </section>

      {(creating || editing) && (
        <UserDialog
          user={editing}
          isSelf={editing?.id === currentUserId}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onCreate={async (draft) => {
            const result = await api.users.create(draft);
            setUsers((prev) => [result.user, ...prev]);
            setCreatedPassword({
              email: result.user.email,
              name: result.user.name,
              password: result.tempPassword,
            });
          }}
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

function TempPasswordBanner({
  data,
  onDismiss,
}: {
  data: CreatedPasswordBanner;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail (permissions, insecure origin). Leave UI as-is.
    }
  };
  return (
    <div className="rounded-xl border border-primary/40 bg-primary/[0.08] px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
          <KeyRound className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-semibold text-foreground">
            Usuario creado: {data.name}
          </p>
          <p className="text-[12.5px] text-muted-foreground mt-0.5">
            Comparte esta contraseña temporal con <strong>{data.email}</strong>{" "}
            — no la volveremos a mostrar. Se recomienda cambiarla tras el
            primer ingreso.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 font-mono text-[13px] bg-background/60 border border-border rounded-md px-3 py-2 select-all">
              {data.password}
            </code>
            <button
              type="button"
              onClick={() => void copy()}
              className="inline-flex items-center gap-1.5 px-3 h-9 rounded-md border border-primary/40 text-primary text-[12px] font-medium hover:bg-primary/10 transition-colors"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Copiado
                </>
              ) : (
                <>
                  <Clipboard className="w-3.5 h-3.5" />
                  Copiar
                </>
              )}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Descartar"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function UserDialog({
  user,
  isSelf,
  onClose,
  onCreate,
  onUpdate,
}: {
  user: ManagedUser | null;
  isSelf: boolean;
  onClose: () => void;
  onCreate: (draft: DraftUser) => Promise<void>;
  onUpdate: (id: string, payload: Partial<DraftUser>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftUser>(
    user
      ? {
          name: user.name,
          email: user.email,
          role: user.role,
          views: toViewIds(user.views),
        }
      : emptyDraft,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<"name" | "email", string>>
  >({});

  const isEdit = Boolean(user);

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
      if (user) {
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
      } else {
        await onCreate(draft);
      }
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl animate-fade-in"
      >
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h3 className="text-[15px] font-semibold">
            {isEdit ? "Editar usuario" : "Nuevo usuario"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="p-6 space-y-4">
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
              disabled={isEdit}
              className="w-full h-10 px-3 rounded-md bg-input/70 border border-border text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/30 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            />
            {isEdit && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                El correo no puede modificarse después de creado el usuario.
              </p>
            )}
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

          {!isEdit && (
            <p className="text-[12px] text-muted-foreground bg-secondary/40 border border-border rounded-md px-3 py-2">
              Se generará una contraseña temporal que se mostrará una sola vez
              después de crear el usuario.
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
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
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md gradient-primary text-white text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {submitting && (
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
            {isEdit ? "Guardar cambios" : "Crear usuario"}
          </button>
        </footer>
      </form>
    </div>
  );
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
