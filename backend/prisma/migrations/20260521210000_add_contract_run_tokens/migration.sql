-- Add token usage + cost columns to contract_runs.
--
-- Nullable so existing rows (created before this column existed) stay
-- valid and so the agent can keep saving runs even if Anthropic happens to
-- return an empty `usage` object on a specific response.
--
-- `cost_usd` is DOUBLE PRECISION (Prisma Float). The dollar range we expect
-- (sub-cent up to ~$10 per run) doesn't need NUMERIC precision; Float
-- keeps the read path lightweight (no Decimal.js wrapping).
ALTER TABLE "contract_runs"
    ADD COLUMN "input_tokens"  INTEGER,
    ADD COLUMN "output_tokens" INTEGER,
    ADD COLUMN "cost_usd"      DOUBLE PRECISION;
