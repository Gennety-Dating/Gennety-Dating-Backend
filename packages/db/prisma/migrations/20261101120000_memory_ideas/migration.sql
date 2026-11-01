-- Additive: ideas, their sources and uses (feature flag off by default).
-- CreateTable
CREATE TABLE "memory_ideas" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "canonical_key" TEXT,
    "place_id" TEXT,
    "city" TEXT,
    "place_provenance" TEXT,
    "event_at" TIMESTAMP(3),
    "event_timezone" TEXT,
    "event_check" TEXT NOT NULL DEFAULT 'unverified',
    "event_checked_at" TIMESTAMP(3),
    "intent" TEXT NOT NULL DEFAULT 'interested',
    "intent_before_plan" TEXT,
    "reason" TEXT,
    "recipient" TEXT,
    "reason_answered_at" TIMESTAMP(3),
    "reason_snoozed_until" TIMESTAMP(3),
    "allow_own_dates" BOOLEAN NOT NULL DEFAULT false,
    "allow_matching" BOOLEAN NOT NULL DEFAULT false,
    "allow_partner" BOOLEAN NOT NULL DEFAULT false,
    "planned_match_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_ideas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_idea_sources" (
    "id" UUID NOT NULL,
    "idea_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "screenshot_item_id" UUID,
    "wishlist_item_id" UUID,
    "url" TEXT,
    "quote" TEXT,
    "provenance" TEXT NOT NULL,
    "origin_idea_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_idea_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_idea_events" (
    "id" UUID NOT NULL,
    "idea_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_idea_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_preferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "facet" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "origin_idea_id" UUID,
    "allow_own_dates" BOOLEAN NOT NULL DEFAULT true,
    "allow_matching" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_reminders" (
    "id" UUID NOT NULL,
    "idea_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "dedupe_key" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_impressions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "idea_id" UUID,
    "place_rating" TEXT,
    "format_rating" TEXT,
    "repeat_format" BOOLEAN,
    "note" TEXT,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_impressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_ideas_user_id_deleted_at_updated_at_idx" ON "memory_ideas"("user_id", "deleted_at", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "memory_ideas_user_id_place_id_idx" ON "memory_ideas"("user_id", "place_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_ideas_user_id_canonical_key_key" ON "memory_ideas"("user_id", "canonical_key");

-- CreateIndex
CREATE INDEX "memory_idea_sources_idea_id_idx" ON "memory_idea_sources"("idea_id");

-- CreateIndex
CREATE INDEX "memory_idea_sources_screenshot_item_id_idx" ON "memory_idea_sources"("screenshot_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_idea_sources_user_id_dedupe_key_key" ON "memory_idea_sources"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "memory_idea_events_idea_id_created_at_idx" ON "memory_idea_events"("idea_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_idea_events_user_id_idempotency_key_key" ON "memory_idea_events"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "memory_preferences_user_id_revoked_at_idx" ON "memory_preferences"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_preferences_user_id_facet_value_key" ON "memory_preferences"("user_id", "facet", "value");

-- CreateIndex
CREATE INDEX "memory_reminders_state_due_at_idx" ON "memory_reminders"("state", "due_at");

-- CreateIndex
CREATE INDEX "memory_reminders_idea_id_idx" ON "memory_reminders"("idea_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_reminders_user_id_dedupe_key_key" ON "memory_reminders"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "memory_impressions_idea_id_idx" ON "memory_impressions"("idea_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_impressions_user_id_match_id_key" ON "memory_impressions"("user_id", "match_id");

-- AddForeignKey
ALTER TABLE "memory_ideas" ADD CONSTRAINT "memory_ideas_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_idea_sources" ADD CONSTRAINT "memory_idea_sources_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "memory_ideas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_idea_events" ADD CONSTRAINT "memory_idea_events_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "memory_ideas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_preferences" ADD CONSTRAINT "memory_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_reminders" ADD CONSTRAINT "memory_reminders_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "memory_ideas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_impressions" ADD CONSTRAINT "memory_impressions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

