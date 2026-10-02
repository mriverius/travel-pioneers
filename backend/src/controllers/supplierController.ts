import type { Request, Response } from "express";
import prisma from "../config/prisma.js";
import logger from "../config/logger.js";
import ApiError from "../utils/ApiError.js";
import { isPrismaKnownError } from "../types/domain.js";
import { invalidateSupplierCache } from "../agents/supplier-intelligence/preScanService.js";

/**
 * Maestro de proveedores ("lista-proveedores").
 *
 *   GET    /suppliers               — catálogo completo (todo usuario autenticado)
 *   GET    /suppliers?summary=1     — sin servicios (+serviceCount); ~60 KB vs ~2.7 MB
 *   GET    /suppliers/:id           — un proveedor con sus servicios
 *   POST   /suppliers               — crear (admin)
 *   PATCH  /suppliers/:id           — editar datos del proveedor (admin)
 *   PUT    /suppliers/:id/servicios — reemplazar la lista de servicios (admin)
 *   DELETE /suppliers/:id           — eliminar proveedor + servicios (admin)
 *
 * La lectura es global porque el agente la necesita en el Paso 1 (dropdown
 * "¿Es un proveedor existente?") y para el prefill de catálogo; la escritura
 * queda restringida a admins en el router.
 */

export interface PublicSupplierService {
  id: string;
  codigo: string;
  descripcion: string | null;
  /** Actividad/zona propias del servicio; null → usar las del proveedor. */
  actividad: string | null;
  zona: string | null;
}

export interface PublicSupplier {
  id: string;
  codigo: string;
  nombre: string | null;
  actividad: string | null;
  zona: string | null;
  /** Vacío en modo summary — ver `serviceCount`. */
  servicios: PublicSupplierService[];
  serviceCount: number;
  createdAt: string;
  updatedAt: string;
}

interface SupplierRow {
  id: string;
  codigo: string;
  nombre: string | null;
  actividad: string | null;
  zona: string | null;
  createdAt: Date;
  updatedAt: Date;
  servicios?: PublicSupplierService[];
  _count?: { servicios: number };
}

const SERVICE_SELECT = {
  select: { id: true, codigo: true, descripcion: true, actividad: true, zona: true },
  orderBy: { codigo: "asc" as const },
};

function toPublic(row: SupplierRow): PublicSupplier {
  return {
    id: row.id,
    codigo: row.codigo,
    nombre: row.nombre,
    actividad: row.actividad,
    zona: row.zona,
    servicios: row.servicios ?? [],
    serviceCount: row._count?.servicios ?? row.servicios?.length ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Trim + colapsa espacios; "" → null. Mismo criterio que el seed. */
function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s === "" ? null : s;
}

export interface ServiceInput {
  codigo: string;
  descripcion?: string | null;
  actividad?: string | null;
  zona?: string | null;
}

interface NormalizedService {
  codigo: string;
  descripcion: string | null;
  actividad: string | null;
  zona: string | null;
}

/**
 * Normaliza y valida la lista de servicios del body. Códigos duplicados
 * (case-insensitive) se rechazan porque violarían la unique
 * (supplier_id, codigo) con un error poco legible.
 */
function normalizeServices(raw: unknown): NormalizedService[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: NormalizedService[] = [];
  for (const item of raw as ServiceInput[]) {
    const codigo = clean(item?.codigo);
    if (!codigo) continue;
    const key = codigo.toLowerCase();
    if (seen.has(key)) {
      throw ApiError.badRequest(`El código de servicio "${codigo}" está repetido.`);
    }
    seen.add(key);
    out.push({
      codigo,
      descripcion: clean(item?.descripcion),
      actividad: clean(item?.actividad)?.toUpperCase() ?? null,
      zona: clean(item?.zona)?.toUpperCase() ?? null,
    });
  }
  return out;
}

/* --------------------------------- list --------------------------------- */

/**
 * GET /suppliers — catálogo ordenado por nombre.
 *
 * `?summary=1` omite los servicios y devuelve solo `serviceCount`. Es lo que
 * usa el agente (dropdown del Paso 1 + lookup por nombre): 457 proveedores
 * pesan ~60 KB frente a ~2.7 MB con los ~14k servicios, y el backend no
 * comprime respuestas. Los servicios de un proveedor se piden aparte con
 * GET /suppliers/:id cuando hace falta.
 */
export async function list(req: Request, res: Response): Promise<void> {
  const summary = req.query.summary === "1" || req.query.summary === "true";
  const orderBy = [{ nombre: "asc" as const }, { codigo: "asc" as const }];
  const rows = (summary
    ? await prisma.supplier.findMany({
        orderBy,
        include: { _count: { select: { servicios: true } } },
      })
    : await prisma.supplier.findMany({
        orderBy,
        include: { servicios: SERVICE_SELECT },
      })) as SupplierRow[];
  res.json({ suppliers: rows.map(toPublic), summary });
}

/* --------------------------------- get ---------------------------------- */

export async function getOne(
  req: Request<{ id: string }>,
  res: Response,
): Promise<void> {
  const row = (await prisma.supplier.findUnique({
    where: { id: req.params.id },
    include: { servicios: SERVICE_SELECT },
  })) as SupplierRow | null;
  if (!row) throw ApiError.notFound("Proveedor no encontrado");
  res.json({ supplier: toPublic(row) });
}

/* -------------------------------- create -------------------------------- */

interface UpsertBody {
  codigo?: unknown;
  nombre?: unknown;
  actividad?: unknown;
  zona?: unknown;
  servicios?: unknown;
}

export async function create(
  req: Request<unknown, unknown, UpsertBody>,
  res: Response,
): Promise<void> {
  const codigo = clean(req.body.codigo);
  if (!codigo) throw ApiError.badRequest("El código del proveedor es obligatorio.");
  const servicios = normalizeServices(req.body.servicios);

  try {
    const created = (await prisma.supplier.create({
      data: {
        codigo,
        nombre: clean(req.body.nombre),
        actividad: clean(req.body.actividad)?.toUpperCase() ?? null,
        zona: clean(req.body.zona)?.toUpperCase() ?? null,
        servicios: servicios.length > 0 ? { create: servicios } : undefined,
      },
      include: { servicios: SERVICE_SELECT },
    })) as SupplierRow;

    invalidateSupplierCache();
    logger.info("Supplier created", {
      requestId: req.id,
      actorId: req.auth?.id,
      supplierId: created.id,
      codigo,
      services: servicios.length,
    });
    res.status(201).json({ supplier: toPublic(created) });
  } catch (err: unknown) {
    if (isPrismaKnownError(err) && err.code === "P2002") {
      throw ApiError.conflict(`Ya existe un proveedor con el código "${codigo}".`);
    }
    throw err;
  }
}

/* -------------------------------- update -------------------------------- */

export async function update(
  req: Request<{ id: string }, unknown, UpsertBody>,
  res: Response,
): Promise<void> {
  const { id } = req.params;
  const data: Record<string, string | null> = {};
  if (req.body.codigo !== undefined) {
    const codigo = clean(req.body.codigo);
    if (!codigo) throw ApiError.badRequest("El código del proveedor no puede quedar vacío.");
    data.codigo = codigo;
  }
  if (req.body.nombre !== undefined) data.nombre = clean(req.body.nombre);
  if (req.body.actividad !== undefined) {
    data.actividad = clean(req.body.actividad)?.toUpperCase() ?? null;
  }
  if (req.body.zona !== undefined) data.zona = clean(req.body.zona)?.toUpperCase() ?? null;

  if (Object.keys(data).length === 0) {
    throw ApiError.badRequest("No hay campos para actualizar.");
  }

  try {
    const updated = (await prisma.supplier.update({
      where: { id },
      data,
      include: { servicios: SERVICE_SELECT },
    })) as SupplierRow;
    invalidateSupplierCache();
    logger.info("Supplier updated", {
      requestId: req.id,
      actorId: req.auth?.id,
      supplierId: id,
      fields: Object.keys(data),
    });
    res.json({ supplier: toPublic(updated) });
  } catch (err: unknown) {
    if (isPrismaKnownError(err)) {
      if (err.code === "P2025") throw ApiError.notFound("Proveedor no encontrado");
      if (err.code === "P2002") {
        throw ApiError.conflict(`Ya existe un proveedor con el código "${data.codigo}".`);
      }
    }
    throw err;
  }
}

/* ------------------------------ services -------------------------------- */

/**
 * PUT /suppliers/:id/servicios — reemplaza la lista completa. El formulario
 * del portal edita la lista entera, así que "reemplazar" es la semántica
 * natural y evita tres endpoints (add / edit / remove) con estados parciales.
 * Transaccional: si algo falla, la lista anterior queda intacta.
 */
export async function replaceServices(
  req: Request<{ id: string }, unknown, { servicios?: unknown }>,
  res: Response,
): Promise<void> {
  const { id } = req.params;
  const servicios = normalizeServices(req.body.servicios);

  const exists = await prisma.supplier.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw ApiError.notFound("Proveedor no encontrado");

  const updated = (await prisma.$transaction(async (tx) => {
    await tx.supplierService.deleteMany({ where: { supplierId: id } });
    if (servicios.length > 0) {
      await tx.supplierService.createMany({
        data: servicios.map((s) => ({ ...s, supplierId: id })),
      });
    }
    // Toca updated_at para que el catálogo cacheado en los clientes detecte el cambio.
    return tx.supplier.update({
      where: { id },
      data: { updatedAt: new Date() },
      include: { servicios: SERVICE_SELECT },
    });
  })) as SupplierRow;

  invalidateSupplierCache();
    logger.info("Supplier services replaced", {
    requestId: req.id,
    actorId: req.auth?.id,
    supplierId: id,
    services: servicios.length,
  });
  res.json({ supplier: toPublic(updated) });
}

/* -------------------------------- remove -------------------------------- */

export async function remove(
  req: Request<{ id: string }>,
  res: Response,
): Promise<void> {
  const { id } = req.params;
  try {
    // Los servicios caen por ON DELETE CASCADE.
    const deleted = await prisma.supplier.delete({ where: { id }, select: { codigo: true } });
    invalidateSupplierCache();
    logger.info("Supplier deleted", {
      requestId: req.id,
      actorId: req.auth?.id,
      supplierId: id,
      codigo: deleted.codigo,
    });
    res.status(204).end();
  } catch (err: unknown) {
    if (isPrismaKnownError(err) && err.code === "P2025") {
      throw ApiError.notFound("Proveedor no encontrado");
    }
    throw err;
  }
}
