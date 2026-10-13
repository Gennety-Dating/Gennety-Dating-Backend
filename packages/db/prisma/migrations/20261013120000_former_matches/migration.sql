-- Report a partner who deleted their account (decision journal 2026-10-13).
--
-- Additive: one new table, nothing existing is touched. Old code never reads
-- it. DDL below is `prisma migrate diff` verbatim.

-- CreateTable
CREATE TABLE "former_matches" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "survivor_id" UUID NOT NULL,
    "former_user_id" UUID NOT NULL,
    "reported_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "former_matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "former_matches_survivor_id_created_at_idx" ON "former_matches"("survivor_id", "created_at");

-- CreateIndex
CREATE INDEX "former_matches_created_at_idx" ON "former_matches"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "former_matches_match_id_survivor_id_key" ON "former_matches"("match_id", "survivor_id");

-- AddForeignKey
ALTER TABLE "former_matches" ADD CONSTRAINT "former_matches_survivor_id_fkey" FOREIGN KEY ("survivor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

