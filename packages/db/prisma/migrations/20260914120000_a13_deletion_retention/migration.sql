-- Account deletion keeps what law and safety require (A13-H14, decision journal 2026-09-14),
-- plus the inbox retention index (A13-L29) and the ticket-price default (A13-L30).
-- No row is rewritten and nothing is dropped except foreign keys, which are recreated at once:
--   * payment ledgers / purchase tables: `user_id` becomes nullable, ON DELETE CASCADE -> SET NULL,
--     so a payment record survives the account it belonged to (privacy policy retention table);
--   * reports: reporter / reported / match become nullable with SET NULL, plus `reported_former_id`;
--   * user_blocks: `blocked_id` becomes nullable with SET NULL, plus `blocked_former_id`
--     (the blocker side still cascades: a boundary the deleted person drew is their own data);
--   * new table `safety_tombstones` (keyed hashes of a deleted account's identities);
--   * `inbox_items (created_at)` index for the nightly sweep;
--   * `matches.ticket_price_cents` default 699 -> 849 (the offer path always writes it explicitly).
-- Order: migration first, code restart right after, in the same deploy. The DDL itself is safe under
-- the previous build, but once an account is deleted with SET NULL in place, rows with a null owner
-- appear, and the previous Prisma client treats those relations as required (the admin report list
-- and the refund sweeps would throw on such a row) until the new build is running.
-- Generated with `prisma migrate diff --from-schema-datamodel <trunk> --to-schema-datamodel <branch> --script`.

-- DropForeignKey
ALTER TABLE "ticket_ledger" DROP CONSTRAINT "ticket_ledger_user_id_fkey";

-- DropForeignKey
ALTER TABLE "subscription_ledger" DROP CONSTRAINT "subscription_ledger_user_id_fkey";

-- DropForeignKey
ALTER TABLE "rematch_purchases" DROP CONSTRAINT "rematch_purchases_user_id_fkey";

-- DropForeignKey
ALTER TABLE "venue_change_purchases" DROP CONSTRAINT "venue_change_purchases_user_id_fkey";

-- DropForeignKey
ALTER TABLE "prime_time_purchases" DROP CONSTRAINT "prime_time_purchases_user_id_fkey";

-- DropForeignKey
ALTER TABLE "reports" DROP CONSTRAINT "reports_reporter_id_fkey";

-- DropForeignKey
ALTER TABLE "reports" DROP CONSTRAINT "reports_reported_id_fkey";

-- DropForeignKey
ALTER TABLE "reports" DROP CONSTRAINT "reports_match_id_fkey";

-- DropForeignKey
ALTER TABLE "user_blocks" DROP CONSTRAINT "user_blocks_blocked_id_fkey";

-- AlterTable
ALTER TABLE "ticket_ledger" ALTER COLUMN "user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "subscription_ledger" ALTER COLUMN "user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "rematch_purchases" ALTER COLUMN "user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "venue_change_purchases" ALTER COLUMN "user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "prime_time_purchases" ALTER COLUMN "user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "matches" ALTER COLUMN "ticket_price_cents" SET DEFAULT 849;

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "reported_former_id" UUID,
ALTER COLUMN "reporter_id" DROP NOT NULL,
ALTER COLUMN "reported_id" DROP NOT NULL,
ALTER COLUMN "match_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "user_blocks" ADD COLUMN     "blocked_former_id" UUID,
ALTER COLUMN "blocked_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "safety_tombstones" (
    "id" UUID NOT NULL,
    "identity_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "former_user_id" UUID NOT NULL,
    "status" "UserStatus",
    "suspended_until" TIMESTAMP(3),
    "strikes" INTEGER NOT NULL DEFAULT 0,
    "restored_to_user_id" UUID,
    "restored_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "safety_tombstones_identity_hash_idx" ON "safety_tombstones"("identity_hash");

-- CreateIndex
CREATE INDEX "safety_tombstones_former_user_id_idx" ON "safety_tombstones"("former_user_id");

-- CreateIndex
CREATE INDEX "safety_tombstones_created_at_idx" ON "safety_tombstones"("created_at");

-- CreateIndex
CREATE INDEX "reports_reported_former_id_idx" ON "reports"("reported_former_id");

-- CreateIndex
CREATE INDEX "user_blocks_blocked_former_id_idx" ON "user_blocks"("blocked_former_id");

-- CreateIndex
CREATE INDEX "inbox_items_created_at_idx" ON "inbox_items"("created_at");

-- AddForeignKey
ALTER TABLE "ticket_ledger" ADD CONSTRAINT "ticket_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_ledger" ADD CONSTRAINT "subscription_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rematch_purchases" ADD CONSTRAINT "rematch_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_change_purchases" ADD CONSTRAINT "venue_change_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prime_time_purchases" ADD CONSTRAINT "prime_time_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_id_fkey" FOREIGN KEY ("reported_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

