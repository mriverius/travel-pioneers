-- Contract runs are a global history, not something owned by a user.
-- Make the audit reference optional and let it fall away when the user is
-- deleted, instead of blocking the deletion (previous ON DELETE RESTRICT).
ALTER TABLE "contract_runs" DROP CONSTRAINT "contract_runs_processed_by_id_fkey";

ALTER TABLE "contract_runs" ALTER COLUMN "processed_by_id" DROP NOT NULL;

ALTER TABLE "contract_runs"
    ADD CONSTRAINT "contract_runs_processed_by_id_fkey"
    FOREIGN KEY ("processed_by_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
