-- «The Morning After», Date Wishlist and Premium without the ticket cover
-- (decision journal 2026-10-08).
--
-- Additive: nullable columns and three new tables. Old code never reads them.
-- DDL below is `prisma migrate diff` verbatim.
--
-- One data statement, at the end: subscribers who are paid up at the moment
-- this migration runs keep Premium's ticket cover until the end of the period
-- they already paid for (founder's choice, 2026-10-08). Renewals never move
-- `premium_ticket_cover_until`, so the cover ends with that period.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "premium_ticket_cover_until" TIMESTAMP(3),
ADD COLUMN     "wishlist_consent_at" TIMESTAMP(3),
ADD COLUMN     "wishlist_consent_version" TEXT;

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "wishlist_done_at" TIMESTAMP(3),
ADD COLUMN     "wishlist_offered_at" TIMESTAMP(3),
ADD COLUMN     "wishlist_snoozed_until" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "morning_after_a" TEXT,
ADD COLUMN     "morning_after_at_a" TIMESTAMP(3),
ADD COLUMN     "morning_after_at_b" TIMESTAMP(3),
ADD COLUMN     "morning_after_b" TEXT,
ADD COLUMN     "morning_after_sent_at" TIMESTAMP(3),
ADD COLUMN     "mutual_interest_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "wishlist_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brand" TEXT,
    "note" TEXT,
    "image_url" TEXT,
    "product_url" TEXT,
    "price_band" TEXT,
    "source" TEXT NOT NULL,
    "catalog_key" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wishlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wishlist_unlocks" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "owner_id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_payment_id" TEXT,
    "amount_stars" INTEGER,
    "amount_cents" INTEGER,
    "refunded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_unlocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "web_lookup_cache" (
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_lookup_cache_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "wishlist_items_user_id_position_idx" ON "wishlist_items"("user_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "wishlist_unlocks_external_payment_id_key" ON "wishlist_unlocks"("external_payment_id");

-- CreateIndex
CREATE INDEX "wishlist_unlocks_owner_id_idx" ON "wishlist_unlocks"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "wishlist_unlocks_match_id_user_id_key" ON "wishlist_unlocks"("match_id", "user_id");

-- CreateIndex
CREATE INDEX "web_lookup_cache_expires_at_idx" ON "web_lookup_cache"("expires_at");

-- AddForeignKey
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishlist_unlocks" ADD CONSTRAINT "wishlist_unlocks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Grandfather the ticket cover for subscribers paid up right now.
UPDATE "users" SET "premium_ticket_cover_until" = "premium_until"
WHERE "premium_until" IS NOT NULL AND "premium_until" > CURRENT_TIMESTAMP;
