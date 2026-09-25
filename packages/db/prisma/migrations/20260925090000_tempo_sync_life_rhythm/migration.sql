-- Tempo Sync / life rhythm (decision journal 2026-09-24, variant B).
--   * `user_rhythm_profiles` — two coarse tags an iOS client derives on the device
--     from Apple Health step history. Health-derived (GDPR Art. 9): readers are
--     fenced by `apps/bot/src/services/rhythm/boundary.test.ts`; cascades with the
--     account; swept by retention after 35 days without a sync.
--   * `match_score_logs.score_rhythm` / `rhythm_similarity` — the centred matching
--     multiplier (weight 0 at launch) and the raw pair similarity it is decided from.
--   * `curated_venues.transit_walk_m` / `pedestrian_nearby` / `osm_enriched_at` —
--     venue Tier 2 facts from OpenStreetMap (`scripts/enrich-venues-osm.mjs`).
--   * `matches.after_date_place` — the neutral post-date continuation.
-- Purely additive: new nullable/defaulted columns and one new table. Old code
-- never reads them, so the deploy order is free.
-- Written by hand; DDL identical to
-- `prisma migrate diff --from-schema-datamodel <741a1c9b> --to-schema-datamodel <branch> --script`.

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "after_date_place" JSONB;

-- AlterTable
ALTER TABLE "match_score_logs" ADD COLUMN     "rhythm_similarity" DOUBLE PRECISION,
ADD COLUMN     "score_rhythm" DOUBLE PRECISION NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "curated_venues" ADD COLUMN     "osm_enriched_at" TIMESTAMP(3),
ADD COLUMN     "pedestrian_nearby" BOOLEAN,
ADD COLUMN     "transit_walk_m" INTEGER;

-- CreateTable
CREATE TABLE "user_rhythm_profiles" (
    "user_id" UUID NOT NULL,
    "activity" TEXT NOT NULL,
    "chronotype" TEXT,
    "coverage_days" INTEGER NOT NULL,
    "algo_version" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "consent_version" TEXT NOT NULL,
    "consented_at" TIMESTAMP(3) NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_rhythm_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "user_rhythm_profiles_synced_at_idx" ON "user_rhythm_profiles"("synced_at");

-- AddForeignKey
ALTER TABLE "user_rhythm_profiles" ADD CONSTRAINT "user_rhythm_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

