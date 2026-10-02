-- Idempotency key for contract runs: one row per extraction, however many
-- times its xlsx is downloaded. Nullable for pre-existing rows.
ALTER TABLE "contract_runs" ADD COLUMN "extraction_id" UUID;

CREATE UNIQUE INDEX "contract_runs_extraction_id_key" ON "contract_runs" ("extraction_id");
