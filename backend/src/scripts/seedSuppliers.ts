/**
 * Seed del maestro de proveedores desde `backend/data/lista-proveedores.xlsx`.
 *
 *   npm run seed:suppliers            # upsert: no borra lo que ya existe
 *   npm run seed:suppliers -- --reset # borra suppliers + servicios y recarga
 *
 * Reemplaza al antiguo `frontend/scripts/build-supplier-catalog.mjs`, que
 * generaba un .ts estático en build. Misma lógica de agrupación: una fila
 * del xlsx = un servicio (con su propia actividad/zona); el proveedor se
 * agrupa por la columna `proveedor` y su nombre/actividad/zona se resuelven
 * por moda cuando las filas difieren (sirven de fallback).
 *
 * Idempotente: upsert por `codigo` de proveedor y por (proveedor, código de
 * servicio). Los proveedores creados o editados desde el portal que no
 * estén en el xlsx NO se tocan (salvo con --reset).
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import prisma from "../config/prisma.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const XLSX_PATH = resolve(__dirname, "..", "..", "data", "lista-proveedores.xlsx");

interface RawRow {
  Actividad: unknown;
  Zona: unknown;
  proveedor: unknown;
  Nombre: unknown;
  Servicio: unknown;
  Descripción: unknown;
}

interface ServiceRecord {
  descripcion: string | null;
  actividad: string | null;
  zona: string | null;
}

interface SupplierRecord {
  codigo: string;
  nombre: string | null;
  actividad: string | null;
  zona: string | null;
  servicios: Map<string, ServiceRecord>;
  nombreCounts: Map<string, number>;
  actividadCounts: Map<string, number>;
  zonaCounts: Map<string, number>;
}

const clean = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, " ");
  return s === "" ? null : s;
};

const bump = (m: Map<string, number>, key: string | null) => {
  if (!key) return;
  m.set(key, (m.get(key) ?? 0) + 1);
};

const topOf = (m: Map<string, number>): string | null => {
  let best: string | null = null;
  let bestCount = -1;
  for (const [k, c] of m) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return best;
};

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");

  if (!existsSync(XLSX_PATH)) {
    console.error(`[seed:suppliers] No existe ${XLSX_PATH}`);
    process.exit(1);
  }

  console.log(`[seed:suppliers] Leyendo ${XLSX_PATH}…`);
  const workbook = XLSX.readFile(XLSX_PATH);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    console.error("[seed:suppliers] El xlsx no tiene hojas.");
    process.exit(1);
  }
  const rows = XLSX.utils.sheet_to_json<RawRow>(workbook.Sheets[sheetName]!, {
    defval: null,
  });

  const byCode = new Map<string, SupplierRecord>();
  let skipped = 0;
  for (const row of rows) {
    const codigo = clean(row.proveedor);
    if (!codigo) {
      skipped += 1;
      continue;
    }
    let rec = byCode.get(codigo);
    if (!rec) {
      rec = {
        codigo,
        nombre: null,
        actividad: null,
        zona: null,
        servicios: new Map(),
        nombreCounts: new Map(),
        actividadCounts: new Map(),
        zonaCounts: new Map(),
      };
      byCode.set(codigo, rec);
    }
    bump(rec.nombreCounts, clean(row.Nombre));
    bump(rec.actividadCounts, clean(row.Actividad));
    bump(rec.zonaCounts, clean(row.Zona));
    const servicio = clean(row.Servicio);
    if (servicio && !rec.servicios.has(servicio)) {
      rec.servicios.set(servicio, {
        descripcion: clean(row["Descripción"]),
        actividad: clean(row.Actividad),
        zona: clean(row.Zona),
      });
    }
  }

  const suppliers = [...byCode.values()]
    .map((r) => ({
      ...r,
      nombre: topOf(r.nombreCounts),
      actividad: topOf(r.actividadCounts),
      zona: topOf(r.zonaCounts),
    }))
    .sort((a, b) => a.codigo.localeCompare(b.codigo));

  const totalServicios = suppliers.reduce((n, s) => n + s.servicios.size, 0);
  console.log(
    `[seed:suppliers] ${rows.length} filas → ${suppliers.length} proveedores · ${totalServicios} servicios (${skipped} filas sin código omitidas)`,
  );

  if (reset) {
    console.log("[seed:suppliers] --reset: borrando suppliers y servicios…");
    await prisma.supplierService.deleteMany({});
    await prisma.supplier.deleteMany({});
  }

  let created = 0;
  let updated = 0;
  for (const s of suppliers) {
    const existing = await prisma.supplier.findUnique({
      where: { codigo: s.codigo },
      select: { id: true },
    });
    const supplier = await prisma.supplier.upsert({
      where: { codigo: s.codigo },
      create: {
        codigo: s.codigo,
        nombre: s.nombre,
        actividad: s.actividad,
        zona: s.zona,
      },
      update: { nombre: s.nombre, actividad: s.actividad, zona: s.zona },
      select: { id: true },
    });
    if (existing) updated += 1;
    else created += 1;

    if (s.servicios.size > 0) {
      // createMany + skipDuplicates respeta la unique (supplier_id, codigo):
      // servicios ya cargados (o editados desde el portal) se conservan.
      await prisma.supplierService.createMany({
        data: [...s.servicios].map(([codigo, svc]) => ({
          supplierId: supplier.id,
          codigo,
          descripcion: svc.descripcion,
          actividad: svc.actividad,
          zona: svc.zona,
        })),
        skipDuplicates: true,
      });
    }
  }

  console.log(
    `[seed:suppliers] Listo: ${created} proveedores creados, ${updated} actualizados.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error("[seed:suppliers] Error:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
