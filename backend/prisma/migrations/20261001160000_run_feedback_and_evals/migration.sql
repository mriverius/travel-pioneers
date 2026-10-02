-- Learning signal per run (what the human corrected vs. what AI / pre-scan proposed).
ALTER TABLE "contract_runs" ADD COLUMN "feedback" JSONB;

-- Rule suggestions derived from recurring corrections; admins accept/dismiss.
CREATE TABLE "agent_rule_suggestions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 0,
    "evidence" JSONB NOT NULL,
    "proposed_text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rule_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_rule_suggestions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_rule_suggestions_key_key" ON "agent_rule_suggestions"("key");
CREATE INDEX "agent_rule_suggestions_status_idx" ON "agent_rule_suggestions"("status");

-- Pre-scan regression cases created from the UI (repo cases live on disk).
CREATE TABLE "eval_cases" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "supplier_codigo" TEXT,
    "layout_family" TEXT,
    "notes" TEXT,
    "expected" JSONB NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_cases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "eval_cases_slug_key" ON "eval_cases"("slug");

CREATE TABLE "eval_case_files" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "eval_case_files_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "eval_case_files_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "eval_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "eval_case_files_case_id_idx" ON "eval_case_files"("case_id");

CREATE TABLE "eval_runs" (
    "id" UUID NOT NULL,
    "ran_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ran_by" UUID,
    "total_cases" INTEGER NOT NULL,
    "total_checks" INTEGER NOT NULL,
    "failed_checks" INTEGER NOT NULL,
    "results" JSONB NOT NULL,

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "eval_runs_ran_at_idx" ON "eval_runs"("ran_at" DESC);
