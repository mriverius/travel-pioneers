-- Persistence for Supplier Intelligence agent runs that reach step 3.
-- Stores shared, row, catalog and manual data as JSONB so the schema can
-- evolve with the agent without per-field migrations.
CREATE TABLE "contract_runs" (
    "id" UUID NOT NULL,
    "processed_by_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filename" TEXT NOT NULL,
    "file_kind" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "shared_fields" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "catalog_prefill" JSONB,
    "manual_fields" JSONB,
    "ai_model" TEXT NOT NULL,

    CONSTRAINT "contract_runs_pkey" PRIMARY KEY ("id")
);

-- Reverse-chronological listing on the history page is the hot read path.
CREATE INDEX "contract_runs_processed_at_idx" ON "contract_runs" ("processed_at" DESC);

-- Audit lookups by user.
CREATE INDEX "contract_runs_processed_by_id_idx" ON "contract_runs" ("processed_by_id");

-- ON DELETE RESTRICT — we never want to lose audit trail when a user is
-- removed; admins should reassign or anonymize before deletion.
ALTER TABLE "contract_runs"
    ADD CONSTRAINT "contract_runs_processed_by_id_fkey"
    FOREIGN KEY ("processed_by_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
