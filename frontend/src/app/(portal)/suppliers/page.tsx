"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownAZ,
  ArrowUpAZ,
  Building2,
  ListTree,
  MapPin,
  Pencil,
  Plus,
  RefreshCcw,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { Select } from "@/components/ui/select";
import { Pagination } from "@/components/ui/pagination";
import {
  Field,
  InlineError,
  ModalHeader,
  ModalShell,
  inputClass,
} from "@/components/ui/modal";
import AdminGuard from "@/components/admin-guard";
import {
  ApiError,
  api,
  type CatalogSupplier,
  type CreateSupplierPayload,
  type SupplierServiceInput,
  type UpdateSupplierPayload,
} from "@/lib/api";
import { invalidateSupplierCatalog, normalizeKey } from "@/lib/supplierLookup";

/* -------------------------------------------------------------------------- */
/*                                   Page                                     */
/* -------------------------------------------------------------------------- */

export default function SuppliersPage() {
  return (
    <AdminGuard>
      <SuppliersPageContent />
    </AdminGuard>
  );
}

function SuppliersPageContent() {
  const [suppliers, setSuppliers] = useState<CatalogSupplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [actividadFilter, setActividadFilter] = useState("all");
  const [zonaFilter, setZonaFilter] = useState("all");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CatalogSupplier | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CatalogSupplier | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    api.suppliers
      .list()
      .then(({ suppliers: fetched }) => {
        if (!cancelled) setSuppliers(fetched);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            describeError(err, "No se pudieron cargar los proveedores."),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { suppliers: fetched } = await api.suppliers.list();
      setSuppliers(fetched);
    } catch (err) {
      setLoadError(describeError(err, "No se pudieron cargar los proveedores."));
    } finally {
      setLoading(false);
    }
  }, []);

  // Any mutation also drops the agent's in-memory catalog so Paso 1 sees
  // the change without a full page reload.
  const applyUpsert = (s: CatalogSupplier) => {
    setSuppliers((prev) => {
      const idx = prev.findIndex((x) => x.id === s.id);
      if (idx === -1) return [s, ...prev];
      const next = [...prev];
      next[idx] = s;
      return next;
    });
    invalidateSupplierCatalog();
  };

  const actividades = useMemo(
    () => distinctSorted(suppliers.map((s) => s.actividad)),
    [suppliers],
  );
  const zonas = useMemo(
    () => distinctSorted(suppliers.map((s) => s.zona)),
    [suppliers],
  );

  const filtered = useMemo(() => {
    const k = normalizeKey(search);
    const tokens = k.split(" ").filter(Boolean);
    return suppliers.filter((s) => {
      if (actividadFilter !== "all" && (s.actividad ?? "") !== actividadFilter)
        return false;
      if (zonaFilter !== "all" && (s.zona ?? "") !== zonaFilter) return false;
      if (tokens.length === 0) return true;
      const hay = `${normalizeKey(s.nombre)} ${normalizeKey(s.codigo)}`;
      return tokens.every((t) => hay.includes(t));
    });
  }, [suppliers, search, actividadFilter, zonaFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) =>
      (a.nombre ?? a.codigo).localeCompare(b.nombre ?? b.codigo, "es", {
        sensitivity: "base",
      }),
    );
    return sortDir === "asc" ? copy : copy.reverse();
  }, [filtered, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, safePage, pageSize]);
  const rangeStart = sorted.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const rangeEnd = Math.min(safePage * pageSize, sorted.length);

  const stats = useMemo(
    () => ({
      suppliers: suppliers.length,
      services: suppliers.reduce((n, s) => n + s.servicios.length, 0),
      zonas: zonas.length,
    }),
    [suppliers, zonas],
  );

  const filtersActive =
    search.trim() !== "" || actividadFilter !== "all" || zonaFilter !== "all";
  const clearFilters = () => {
    setSearch("");
    setActividadFilter("all");
    setZonaFilter("all");
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 pl-12 lg:pl-0">
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-foreground">
            Proveedores
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            Maestro de proveedores y sus servicios. Es la lista que el agente
            ofrece en «¿Es un proveedor existente?» y la que pre-llena
            actividad, zona y códigos en la plantilla.
          </p>
        </div>
        <div className="flex items-center gap-2 self-stretch sm:self-auto">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex flex-1 sm:flex-none items-center justify-center gap-2 h-10 px-4 rounded-md gradient-primary text-white text-[13px] font-medium hover:opacity-90 transition-opacity"
          >
            <Plus className="w-4 h-4" />
            Nuevo proveedor
          </button>
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            className="inline-flex items-center gap-2 h-10 px-3 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-50"
            aria-label="Refrescar"
            title="Refrescar"
          >
            <RefreshCcw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </header>

      {loadError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
        >
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1">{loadError}</span>
          <button
            type="button"
            onClick={() => void reload()}
            className="px-2 py-0.5 rounded-md border border-destructive/40 text-[12px] hover:bg-destructive/20 transition-colors"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* Stats */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Proveedores" value={stats.suppliers} tone="primary" />
        <StatCard label="Servicios" value={stats.services} tone="sky" />
        <StatCard label="Zonas" value={stats.zonas} tone="muted" />
      </section>

      {/* Filters */}
      <section className="bg-card/80 border border-border rounded-xl p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Buscar por nombre o código"
            className="w-full h-10 pl-9 pr-3 rounded-md bg-input/70 border border-border text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/30 transition-colors"
          />
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <FilterSelect
            label="Actividad"
            value={actividadFilter}
            options={actividades}
            onChange={(v) => {
              setActividadFilter(v);
              setPage(1);
            }}
          />
          <FilterSelect
            label="Zona"
            value={zonaFilter}
            options={zonas}
            onChange={(v) => {
              setZonaFilter(v);
              setPage(1);
            }}
          />
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center justify-center gap-1.5 h-10 px-3 rounded-md border border-border text-[12.5px] text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              Limpiar
            </button>
          )}
        </div>
      </section>

      {/* Table */}
      <section className="bg-card/80 border border-border rounded-xl overflow-hidden">
        <header className="flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-border">
          <Building2 className="w-5 h-5 text-primary" />
          <h2 className="text-[15px] font-semibold">
            Proveedores{" "}
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
                    onClick={() => {
                      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                      setPage(1);
                    }}
                    className="inline-flex items-center gap-1.5 uppercase tracking-wider text-[12px] font-semibold hover:text-foreground transition-colors"
                    aria-label={
                      sortDir === "asc"
                        ? "Ordenar descendente"
                        : "Ordenar ascendente"
                    }
                  >
                    Proveedor
                    {sortDir === "asc" ? (
                      <ArrowDownAZ className="w-3.5 h-3.5 text-primary" />
                    ) : (
                      <ArrowUpAZ className="w-3.5 h-3.5 text-primary" />
                    )}
                  </button>
                </Th>
                <Th>Actividad</Th>
                <Th>Zona</Th>
                <Th>Servicios</Th>
                <Th className="text-right pr-6">Acciones</Th>
              </tr>
            </thead>
            <tbody>
              {loading && suppliers.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-6 py-10 text-center text-muted-foreground text-[13px]"
                  >
                    <div className="inline-flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                      Cargando proveedores…
                    </div>
                  </td>
                </tr>
              )}
              {!loading && sorted.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-6 py-10 text-center text-muted-foreground text-[13px]"
                  >
                    {suppliers.length === 0
                      ? "Aún no hay proveedores. Crea el primero o corre el seed desde el backend."
                      : "Ningún proveedor coincide con los filtros."}
                  </td>
                </tr>
              )}
              {paginated.map((s) => (
                <tr
                  key={s.id}
                  className="border-t border-border/60 hover:bg-secondary/20 transition-colors"
                >
                  <td className="px-6 py-3.5 align-top">
                    <div className="min-w-0 max-w-[360px]">
                      <p className="text-[13.5px] font-semibold text-foreground truncate">
                        {s.nombre ?? (
                          <span className="italic text-muted-foreground">
                            Sin nombre
                          </span>
                        )}
                      </p>
                      <span className="inline-flex items-center gap-1 mt-1 rounded-full border border-border bg-secondary/60 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                        <Tag className="w-3 h-3" />
                        {s.codigo}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-3.5 align-top text-[13px]">
                    {s.actividad ?? <Dash />}
                  </td>
                  <td className="px-6 py-3.5 align-top text-[13px]">
                    {s.zona ? (
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                        {s.zona}
                      </span>
                    ) : (
                      <Dash />
                    )}
                  </td>
                  <td className="px-6 py-3.5 align-top">
                    <ServicesPreview servicios={s.servicios} />
                  </td>
                  <td className="px-6 py-3.5 align-top">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEditing(s)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-border text-[12px] hover:bg-secondary/60 transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        Editar
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(s)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-destructive/40 text-destructive text-[12px] hover:bg-destructive/10 transition-colors"
                        aria-label={`Eliminar ${s.nombre ?? s.codigo}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
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
            onPageSizeChange={(n) => {
              setPageSize(n);
              setPage(1);
            }}
          />
        )}
      </section>

      {creating && (
        <SupplierDialog
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={applyUpsert}
        />
      )}
      {editing && (
        <SupplierDialog
          mode="edit"
          supplier={editing}
          onClose={() => setEditing(null)}
          onSaved={applyUpsert}
        />
      )}
      {pendingDelete && (
        <ConfirmDeleteDialog
          supplier={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onConfirm={async () => {
            await api.suppliers.remove(pendingDelete.id);
            setSuppliers((prev) => prev.filter((x) => x.id !== pendingDelete.id));
            invalidateSupplierCatalog();
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                               Supplier dialog                              */
/* -------------------------------------------------------------------------- */

type ServiceDraft = {
  key: string;
  codigo: string;
  descripcion: string;
  actividad: string;
  zona: string;
};

let draftSeq = 0;
const newDraftKey = () => `d${++draftSeq}`;

function toServiceDrafts(s: CatalogSupplier | undefined): ServiceDraft[] {
  if (!s) return [];
  return s.servicios.map((x) => ({
    key: x.id ?? newDraftKey(),
    codigo: x.codigo,
    descripcion: x.descripcion ?? "",
    actividad: x.actividad ?? "",
    zona: x.zona ?? "",
  }));
}

function toServiceInputs(drafts: ServiceDraft[]): SupplierServiceInput[] {
  return drafts
    .map((d) => ({
      codigo: d.codigo.trim(),
      descripcion: d.descripcion.trim() || null,
      actividad: d.actividad.trim().toUpperCase() || null,
      zona: d.zona.trim().toUpperCase() || null,
    }))
    .filter((d) => d.codigo !== "");
}

function sameServices(a: SupplierServiceInput[], b: SupplierServiceInput[]) {
  if (a.length !== b.length) return false;
  const norm = (xs: SupplierServiceInput[]) =>
    [...xs]
      .map(
        (x) =>
          `${x.codigo}\u0000${x.descripcion ?? ""}\u0000${x.actividad ?? ""}\u0000${x.zona ?? ""}`,
      )
      .sort()
      .join("\n");
  return norm(a) === norm(b);
}

function SupplierDialog(props: {
  mode: "create" | "edit";
  supplier?: CatalogSupplier;
  onClose: () => void;
  onSaved: (s: CatalogSupplier) => void;
}) {
  const { mode, supplier, onClose, onSaved } = props;
  const [codigo, setCodigo] = useState(supplier?.codigo ?? "");
  const [nombre, setNombre] = useState(supplier?.nombre ?? "");
  const [actividad, setActividad] = useState(supplier?.actividad ?? "");
  const [zona, setZona] = useState(supplier?.zona ?? "");
  const [services, setServices] = useState<ServiceDraft[]>(() =>
    toServiceDrafts(supplier),
  );
  const [serviceFilter, setServiceFilter] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addService = () => {
    setServices((prev) => [
      ...prev,
      { key: newDraftKey(), codigo: "", descripcion: "", actividad: "", zona: "" },
    ]);
    setServiceFilter("");
  };
  const updateService = (key: string, patch: Partial<ServiceDraft>) =>
    setServices((prev) =>
      prev.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    );
  const removeService = (key: string) =>
    setServices((prev) => prev.filter((s) => s.key !== key));

  const visibleServices = useMemo(() => {
    const k = normalizeKey(serviceFilter);
    if (!k) return services;
    return services.filter(
      (s) =>
        s.codigo === "" ||
        normalizeKey(s.codigo).includes(k) ||
        normalizeKey(s.descripcion).includes(k),
    );
  }, [services, serviceFilter]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedCodigo = codigo.trim();
    if (!trimmedCodigo) {
      setError("El código del proveedor es obligatorio.");
      return;
    }
    const inputs = toServiceInputs(services);
    const dupe = findDuplicateCode(inputs);
    if (dupe) {
      setError(`El código de servicio "${dupe}" está repetido.`);
      return;
    }

    setSubmitting(true);
    try {
      if (mode === "create") {
        const payload: CreateSupplierPayload = {
          codigo: trimmedCodigo,
          nombre: nombre.trim() || null,
          actividad: actividad.trim() || null,
          zona: zona.trim() || null,
          servicios: inputs,
        };
        const { supplier: created } = await api.suppliers.create(payload);
        onSaved(created);
      } else if (supplier) {
        const patch: UpdateSupplierPayload = {};
        if (trimmedCodigo !== supplier.codigo) patch.codigo = trimmedCodigo;
        if ((nombre.trim() || null) !== supplier.nombre)
          patch.nombre = nombre.trim() || null;
        if ((actividad.trim() || null) !== supplier.actividad)
          patch.actividad = actividad.trim() || null;
        if ((zona.trim() || null) !== supplier.zona)
          patch.zona = zona.trim() || null;

        let latest = supplier;
        if (Object.keys(patch).length > 0) {
          latest = (await api.suppliers.update(supplier.id, patch)).supplier;
        }
        const current = supplier.servicios.map((s) => ({
          codigo: s.codigo,
          descripcion: s.descripcion,
          actividad: s.actividad ?? null,
          zona: s.zona ?? null,
        }));
        if (!sameServices(current, inputs)) {
          latest = (await api.suppliers.replaceServices(supplier.id, inputs))
            .supplier;
        }
        onSaved(latest);
      }
      onClose();
    } catch (err) {
      setError(describeError(err, "No se pudo guardar el proveedor."));
    } finally {
      setSubmitting(false);
    }
  };

  const title = mode === "create" ? "Nuevo proveedor" : "Editar proveedor";

  return (
    <ModalShell onClose={onClose} labelledBy="supplier-dialog-title" maxWidth="max-w-2xl">
      <form onSubmit={handleSubmit}>
        <ModalHeader id="supplier-dialog-title" title={title} onClose={onClose} />

        <div className="p-4 sm:p-6 space-y-5">
          {error && <InlineError message={error} />}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label="Código"
              hint="Código corto del maestro (columna C de la plantilla)."
            >
              <input
                type="text"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                required
                maxLength={64}
                autoFocus={mode === "create"}
                placeholder="Ej. LAPARIOS"
                className={`${inputClass} font-mono uppercase`}
              />
            </Field>
            <Field label="Nombre comercial">
              <input
                type="text"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                maxLength={200}
                placeholder="Ej. Lapa Rios Lodge"
                className={inputClass}
              />
            </Field>
            <Field label="Actividad" hint="Tipo de actividad, ej. HO, TR, TO.">
              <input
                type="text"
                value={actividad}
                onChange={(e) => setActividad(e.target.value)}
                maxLength={32}
                placeholder="HO"
                className={`${inputClass} uppercase`}
              />
            </Field>
            <Field label="Zona" hint="Destino turístico, ej. DOM, OSA, SJO.">
              <input
                type="text"
                value={zona}
                onChange={(e) => setZona(e.target.value)}
                maxLength={32}
                placeholder="DOM"
                className={`${inputClass} uppercase`}
              />
            </Field>
          </div>

          {/* Services editor */}
          <div className="rounded-xl border border-border bg-secondary/20">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <ListTree className="w-4 h-4 text-primary" />
                <p className="text-[13px] font-semibold">
                  Servicios{" "}
                  <span className="text-muted-foreground font-normal">
                    ({toServiceInputs(services).length})
                  </span>
                </p>
                <span
                  className="hidden md:inline text-[11px] text-muted-foreground"
                  title="Algunos proveedores mezclan hotel, tours y transporte"
                >
                  · actividad y zona por servicio son opcionales
                </span>
              </div>
              <div className="flex items-center gap-2">
                {services.length > 8 && (
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="search"
                      value={serviceFilter}
                      onChange={(e) => setServiceFilter(e.target.value)}
                      placeholder="Filtrar servicios"
                      className="h-8 w-44 pl-8 pr-2 rounded-md bg-input/70 border border-border text-[12px] outline-none focus:border-primary/60"
                    />
                  </div>
                )}
                <button
                  type="button"
                  onClick={addService}
                  className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-primary/40 bg-primary/10 text-primary text-[12px] hover:bg-primary/15 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Agregar servicio
                </button>
              </div>
            </div>

            {services.length > 0 && (
              <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_4.5rem_4.5rem_auto] gap-2 px-3 pt-2 pb-1 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                <span>Código</span>
                <span>Descripción</span>
                <span title="Actividad del servicio; vacío = la del proveedor">
                  Activ.
                </span>
                <span title="Zona del servicio; vacío = la del proveedor">Zona</span>
                <span className="w-9" />
              </div>
            )}
            <div className="max-h-72 overflow-y-auto overscroll-contain">
              {services.length === 0 ? (
                <p className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
                  Este proveedor no tiene servicios. Agrega al menos uno para que
                  el agente pueda pre-llenar «Código servicio».
                </p>
              ) : visibleServices.length === 0 ? (
                <p className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
                  Ningún servicio coincide con el filtro.
                </p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {visibleServices.map((s) => (
                    <li
                      key={s.key}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_4.5rem_4.5rem_auto] gap-2 items-center px-3 py-2"
                    >
                      <input
                        type="text"
                        value={s.codigo}
                        onChange={(e) =>
                          updateService(s.key, { codigo: e.target.value })
                        }
                        placeholder="Código"
                        aria-label="Código de servicio"
                        maxLength={64}
                        className="h-9 px-2.5 rounded-md bg-input/70 border border-border font-mono text-[12.5px] uppercase outline-none focus:border-primary/60"
                      />
                      <input
                        type="text"
                        value={s.descripcion}
                        onChange={(e) =>
                          updateService(s.key, { descripcion: e.target.value })
                        }
                        placeholder="Descripción"
                        aria-label="Descripción del servicio"
                        maxLength={500}
                        className="h-9 px-2.5 rounded-md bg-input/70 border border-border text-[12.5px] outline-none focus:border-primary/60"
                      />
                      <input
                        type="text"
                        value={s.actividad}
                        onChange={(e) =>
                          updateService(s.key, { actividad: e.target.value })
                        }
                        placeholder={actividad.trim().toUpperCase() || "—"}
                        aria-label="Actividad del servicio"
                        title="Vacío = usa la actividad del proveedor"
                        maxLength={32}
                        className="h-9 px-2 rounded-md bg-input/70 border border-border font-mono text-[12px] uppercase outline-none focus:border-primary/60 placeholder:text-muted-foreground/50"
                      />
                      <input
                        type="text"
                        value={s.zona}
                        onChange={(e) =>
                          updateService(s.key, { zona: e.target.value })
                        }
                        placeholder={zona.trim().toUpperCase() || "—"}
                        aria-label="Zona del servicio"
                        title="Vacío = usa la zona del proveedor"
                        maxLength={32}
                        className="h-9 px-2 rounded-md bg-input/70 border border-border font-mono text-[12px] uppercase outline-none focus:border-primary/60 placeholder:text-muted-foreground/50"
                      />
                      <button
                        type="button"
                        onClick={() => removeService(s.key)}
                        className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 transition-colors"
                        aria-label="Quitar servicio"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
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
            {mode === "create" ? "Crear proveedor" : "Guardar cambios"}
          </button>
        </footer>
      </form>
    </ModalShell>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Delete confirmation                           */
/* -------------------------------------------------------------------------- */

function ConfirmDeleteDialog({
  supplier,
  onClose,
  onConfirm,
}: {
  supplier: CatalogSupplier;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    if (!submitting) onClose();
  }, [submitting, onClose]);

  const handleConfirm = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(describeError(err, "No se pudo eliminar el proveedor."));
      setSubmitting(false);
    }
  };

  const n = supplier.servicios.length;

  return (
    <ModalShell onClose={close} labelledBy="delete-supplier-title" maxWidth="max-w-md">
      <ModalHeader
        id="delete-supplier-title"
        title="Eliminar proveedor"
        onClose={close}
        tone="danger"
      />
      <div className="p-4 sm:p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-destructive/10 border border-destructive/30 flex items-center justify-center text-destructive shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="min-w-0 text-[13.5px] text-foreground">
            <p>
              ¿Seguro que quieres eliminar a{" "}
              <span className="font-semibold">
                {supplier.nombre ?? supplier.codigo}
              </span>
              ?
            </p>
            <p className="mt-1.5 text-[12.5px] text-muted-foreground">
              Se eliminarán también sus {n} servicio{n === 1 ? "" : "s"}. Los
              contratos ya procesados en el historial no se modifican. Esta
              acción no se puede deshacer.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">
              {supplier.nombre ?? <span className="italic">Sin nombre</span>}
            </p>
            <p className="text-[12px] text-muted-foreground truncate">
              {[supplier.actividad, supplier.zona].filter(Boolean).join(" · ") ||
                "Sin clasificación"}
            </p>
          </div>
          <span className="ml-auto shrink-0 rounded-full border border-border bg-secondary/60 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
            {supplier.codigo}
          </span>
        </div>

        {error && <InlineError message={error} />}
      </div>
      <footer className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center sm:justify-end gap-2 px-4 sm:px-6 py-4 border-t border-border">
        <button
          type="button"
          onClick={close}
          disabled={submitting}
          className="px-3.5 py-2 rounded-md border border-border text-[13px] hover:bg-secondary/60 transition-colors disabled:opacity-50"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={submitting}
          autoFocus
          className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-md bg-destructive text-white text-[13px] font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50"
        >
          {submitting ? (
            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4" />
          )}
          Eliminar proveedor
        </button>
      </footer>
    </ModalShell>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

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

function distinctSorted(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort(
    (a, b) => a.localeCompare(b, "es"),
  );
}

function findDuplicateCode(inputs: SupplierServiceInput[]): string | null {
  const seen = new Set<string>();
  for (const s of inputs) {
    const k = s.codigo.toLowerCase();
    if (seen.has(k)) return s.codigo;
    seen.add(k);
  }
  return null;
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[12.5px] text-muted-foreground">{label}:</span>
      <div className="w-40">
        <Select
          options={[
            { value: "all", label: `Todas` },
            ...options.map((o) => ({ value: o, label: o })),
          ]}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

function ServicesPreview({
  servicios,
}: {
  servicios: CatalogSupplier["servicios"];
}) {
  if (servicios.length === 0) {
    return (
      <span className="text-[12px] text-amber-300/90">Sin servicios</span>
    );
  }
  const shown = servicios.slice(0, 3);
  const rest = servicios.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1 max-w-[320px]">
      {shown.map((s) => (
        <span
          key={s.id ?? s.codigo}
          title={s.descripcion ?? undefined}
          className="rounded-full border border-border bg-secondary/50 px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground"
        >
          {s.codigo}
        </span>
      ))}
      {rest > 0 && (
        <span className="text-[11.5px] text-muted-foreground">+{rest}</span>
      )}
    </div>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th scope="col" className={`text-left font-semibold px-6 py-3 ${className}`}>
      {children}
    </th>
  );
}

function Dash() {
  return <span className="text-muted-foreground/60">—</span>;
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "primary" | "sky" | "muted";
}) {
  const tones: Record<typeof tone, string> = {
    primary: "text-primary",
    sky: "text-sky-300",
    muted: "text-muted-foreground",
  };
  return (
    <div className="bg-card/80 border border-border rounded-xl px-4 py-3.5">
      <p className="text-[11.5px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={`text-[22px] font-bold mt-1 ${tones[tone]}`}>
        {value.toLocaleString("es-CR")}
      </p>
    </div>
  );
}
