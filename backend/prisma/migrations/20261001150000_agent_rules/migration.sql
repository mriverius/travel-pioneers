-- Permanent, admin-curated instructions injected into every agent run.
CREATE TABLE "agent_rules" (
    "id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_rules_pkey" PRIMARY KEY ("id")
);
