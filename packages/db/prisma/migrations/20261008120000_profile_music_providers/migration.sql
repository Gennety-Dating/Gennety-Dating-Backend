-- Music on the profile, two providers (decision 2026-10-08): Apple Music is the
-- main source (the person's own listening, read on the iPhone through MusicKit),
-- Spotify stays as catalogue search. A row now names its provider and carries
-- provider-neutral `track_id` / `track_url`; the Spotify-only columns become
-- nullable, are no longer read or written, and are dropped by a later migration.
--
-- Additive: new columns, two DROP NOT NULLs, one new unique index. The new
-- NOT NULL columns are added nullable, backfilled from the Spotify columns and
-- only then tightened — the table is empty in production (PROFILE_MUSIC_ENABLED
-- has never been on there), but a database with rows still migrates.
--
-- Order: migration BEFORE code. The new process selects `provider` / `track_id`
-- / `track_url`; the old one keeps working on the old columns until it restarts.
-- DDL equals `prisma migrate diff --from-schema-datamodel <trunk>
-- --to-schema-datamodel <branch> --script` apart from the backfill split.

-- AlterTable
ALTER TABLE "profile_music_tracks" ADD COLUMN     "isrc" TEXT,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'spotify',
ADD COLUMN     "storefront" TEXT,
ADD COLUMN     "track_id" TEXT,
ADD COLUMN     "track_url" TEXT,
ALTER COLUMN "spotify_track_id" DROP NOT NULL,
ALTER COLUMN "spotify_url" DROP NOT NULL;

-- Backfill: every existing row is a Spotify track.
UPDATE "profile_music_tracks"
SET "track_id" = "spotify_track_id", "track_url" = "spotify_url"
WHERE "track_id" IS NULL;

ALTER TABLE "profile_music_tracks" ALTER COLUMN "track_id" SET NOT NULL,
ALTER COLUMN "track_url" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "profile_music_tracks_user_id_provider_track_id_key" ON "profile_music_tracks"("user_id", "provider", "track_id");
