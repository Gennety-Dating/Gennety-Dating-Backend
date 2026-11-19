-- Long-term memory of the agent (decision 2026-11-19). Additive only:
-- two new tables and one column; no existing row is rewritten, no vector index.

CREATE TABLE "agent_memories" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "subject" TEXT,
    "due_on" DATE,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT,
    "outcome" TEXT,
    "provenance" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "source_session_id" UUID,
    "embedding" vector(1536),
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_memories_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "agent_memories_user_id_kind_idx" ON "agent_memories"("user_id", "kind");
CREATE INDEX "agent_memories_user_id_updated_at_idx" ON "agent_memories"("user_id", "updated_at");
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_source_session_id_fkey"
    FOREIGN KEY ("source_session_id") REFERENCES "chat_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "agent_memory_state" (
    "user_id" UUID NOT NULL,
    "paused_at" TIMESTAMP(3),
    "telegram_scanned_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_memory_state_pkey" PRIMARY KEY ("user_id")
);
ALTER TABLE "agent_memory_state" ADD CONSTRAINT "agent_memory_state_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_sessions" ADD COLUMN "memory_scanned_count" INTEGER NOT NULL DEFAULT 0;
