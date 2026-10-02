-- Supplier master ("lista-proveedores") moves from a build-time generated
-- file into the database so admins can manage it from the portal.
-- Seed from the historical xlsx with `npm run seed:suppliers`.
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT,
    "actividad" TEXT,
    "zona" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "suppliers_codigo_key" ON "suppliers"("codigo");
CREATE INDEX "suppliers_nombre_idx" ON "suppliers"("nombre");

CREATE TABLE "supplier_services" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT,
    -- Per-service activity/zone: the xlsx carries them per row and some
    -- suppliers mix several (hotel + tours + transport).
    "actividad" TEXT,
    "zona" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_services_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_services_supplier_id_codigo_key" ON "supplier_services"("supplier_id", "codigo");

ALTER TABLE "supplier_services"
    ADD CONSTRAINT "supplier_services_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
