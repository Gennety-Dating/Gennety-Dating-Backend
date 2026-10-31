-- Additive: the private screenshot library (feature flag off by default).
CREATE TABLE "screenshot_libraries" (
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'off',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "auto_import" BOOLEAN NOT NULL DEFAULT false,
    "range_days" INTEGER,
    "consent_at" TIMESTAMP(3),
    "consent_version" TEXT,
    "last_reconciled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "screenshot_libraries_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE "screenshot_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "content_hash" TEXT,
    "captured_at" TIMESTAMP(3),
    "state" TEXT NOT NULL DEFAULT 'reserved',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "indexing_started_at" TIMESTAMP(3),
    "storage_path" TEXT NOT NULL,
    "ocr_text" TEXT,
    "title" TEXT,
    "description" TEXT,
    "category" TEXT,
    "entities" JSONB,
    "processing_version" INTEGER,
    "embedding" vector(1536),
    "indexed_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "screenshot_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "screenshot_exclusions" (
    "user_id" UUID NOT NULL,
    "source_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "screenshot_exclusions_pkey" PRIMARY KEY ("user_id","source_key")
);

CREATE UNIQUE INDEX "screenshot_items_user_id_content_hash_key" ON "screenshot_items"("user_id", "content_hash");
CREATE INDEX "screenshot_items_user_id_deleted_at_captured_at_idx" ON "screenshot_items"("user_id", "deleted_at", "captured_at" DESC);
CREATE INDEX "screenshot_items_user_id_source_key_idx" ON "screenshot_items"("user_id", "source_key");
CREATE INDEX "screenshot_items_state_next_attempt_at_idx" ON "screenshot_items"("state", "next_attempt_at");
CREATE INDEX "screenshot_items_deleted_at_idx" ON "screenshot_items"("deleted_at");

ALTER TABLE "screenshot_libraries" ADD CONSTRAINT "screenshot_libraries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "screenshot_items" ADD CONSTRAINT "screenshot_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "screenshot_exclusions" ADD CONSTRAINT "screenshot_exclusions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
