-- In-app inbox, admin announcements and chat context (decision journal 2026-09-13).
-- Purely additive: one nullable column on `messages`, two new tables, no existing row rewritten.
-- `inbox_items (user_id, announcement_id)` is unique so an announcement fan-out that restarts
-- cannot land twice for the same person; NULL announcement ids (transactional rows) stay distinct.
-- Written by hand; DDL identical to
-- `prisma migrate diff --from-schema-datamodel <trunk> --to-schema-datamodel <branch> --script`.

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "context" JSONB;

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "title" TEXT NOT NULL,
    "teaser" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "agent_brief" TEXT,
    "suggested_questions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "event_id" UUID,
    "media_kind" TEXT,
    "media_path" TEXT,
    "poster_path" TEXT,
    "audience" JSONB NOT NULL DEFAULT '{}',
    "send_push" BOOLEAN NOT NULL DEFAULT true,
    "scheduled_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "recipient_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "announcement_id" UUID,
    "match_id" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),
    "pushed_at" TIMESTAMP(3),

    CONSTRAINT "inbox_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_status_scheduled_at_idx" ON "announcements"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "inbox_items_user_id_created_at_idx" ON "inbox_items"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "inbox_items_announcement_id_pushed_at_idx" ON "inbox_items"("announcement_id", "pushed_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_items_user_id_announcement_id_key" ON "inbox_items"("user_id", "announcement_id");

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

