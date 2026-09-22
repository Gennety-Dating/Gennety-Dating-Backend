-- Referral program pays in Date Tickets only (decision journal 2026-09-22): every
-- counted invitee becomes a `referral_qualifications` row, and the proven identities
-- of that invitee are kept as keyed hashes in `referral_identities`, so a deleted
-- account that re-registers cannot be counted twice.
-- Purely additive: two new tables, no existing column changed. The Prisma field
-- `User.referralGiftSeenAt` reuses the existing `referral_invitee_premium_at` column
-- through @map, so it needs no DDL. Old code never reads the new tables.
-- Written by hand; DDL identical to
-- `prisma migrate diff --from-schema-datamodel <923d4233> --to-schema-datamodel <branch> --script`.

-- CreateTable
CREATE TABLE "referral_qualifications" (
    "id" UUID NOT NULL,
    "invitee_id" UUID,
    "referrer_id" UUID,
    "status" TEXT NOT NULL,
    "referrer_tickets" INTEGER NOT NULL DEFAULT 0,
    "invitee_tickets" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "credited_at" TIMESTAMP(3),

    CONSTRAINT "referral_qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_identities" (
    "identity_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "qualification_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_identities_pkey" PRIMARY KEY ("identity_hash")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_qualifications_invitee_id_key" ON "referral_qualifications"("invitee_id");

-- CreateIndex
CREATE INDEX "referral_qualifications_referrer_id_status_created_at_idx" ON "referral_qualifications"("referrer_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "referral_qualifications_status_referrer_id_idx" ON "referral_qualifications"("status", "referrer_id");

-- CreateIndex
CREATE INDEX "referral_identities_qualification_id_idx" ON "referral_identities"("qualification_id");

-- AddForeignKey
ALTER TABLE "referral_qualifications" ADD CONSTRAINT "referral_qualifications_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_qualifications" ADD CONSTRAINT "referral_qualifications_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_identities" ADD CONSTRAINT "referral_identities_qualification_id_fkey" FOREIGN KEY ("qualification_id") REFERENCES "referral_qualifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
