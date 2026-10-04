-- Chat sessions for the app's agent chat (decision journal 2026-09-30): the one
-- endless thread becomes separate chats, ChatGPT-style. New table `chat_sessions`
-- (title written by a small model or by hand, an English summary + its embedding
-- for the agent's `search_past_chats` tool) and `messages.session_id`.
--
-- Additive: no existing column changes type or loses data. Old code never reads
-- the new table or column; the new code tolerates rows without a session.
--
-- BACKFILL, in the same transaction: every user's existing messages (all roles,
-- ordered by (created_at, id)) are split into chats at a silence longer than six
-- hours — the rule `services/chat-topics.ts` (`TOPIC_GAP_MS`) already cut the
-- stream by, so the history list opens on the same conversations the old
-- "topics" sheet showed. One chat per group: created_at = its first message,
-- updated_at = its last, title NULL (the digest worker titles and summarizes
-- them after the deploy, in small batches). Consecutive groups of one user are
-- separated by more than six hours, so their [first, last] ranges are disjoint
-- and every message falls in exactly one — that is what lets the second
-- statement join by time range instead of carrying a temp mapping table.
--
-- DDL written by hand; identical to
-- `prisma migrate diff --from-schema-datamodel <main> --to-schema-datamodel <branch> --script`.

BEGIN;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "session_id" UUID;

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT,
    "title_by_user" BOOLEAN NOT NULL DEFAULT false,
    "titled_at_count" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "summary_embedding" vector(1536),
    "summarized_at_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_sessions_user_id_updated_at_idx" ON "chat_sessions"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "messages_session_id_created_at_idx" ON "messages"("session_id", "created_at");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill 1/2: one chat per >6h-separated run of each user's messages.
INSERT INTO "chat_sessions" ("id", "user_id", "created_at", "updated_at")
SELECT gen_random_uuid(), "user_id", MIN("created_at"), MAX("created_at")
FROM (
    SELECT "user_id", "created_at",
           SUM("opens") OVER (
               PARTITION BY "user_id" ORDER BY "created_at", "id"
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS "run"
    FROM (
        SELECT "id", "user_id", "created_at",
               CASE
                   WHEN LAG("created_at") OVER w IS NULL THEN 1
                   WHEN "created_at" - LAG("created_at") OVER w > INTERVAL '6 hours' THEN 1
                   ELSE 0
               END AS "opens"
        FROM "messages"
        WINDOW w AS (PARTITION BY "user_id" ORDER BY "created_at", "id")
    ) AS "marked"
) AS "runs"
GROUP BY "user_id", "run";

-- Backfill 2/2: every message into the chat whose time range holds it.
UPDATE "messages" AS m
SET "session_id" = s."id"
FROM "chat_sessions" AS s
WHERE s."user_id" = m."user_id"
  AND m."created_at" BETWEEN s."created_at" AND s."updated_at"
  AND m."session_id" IS NULL;

COMMIT;
