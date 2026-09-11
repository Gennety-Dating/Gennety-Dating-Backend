-- Music on the profile (decision 2026-09-11): up to three Spotify tracks a
-- person pins to their profile. Purely additive — one new table, no existing
-- column touched. Hand-written; DDL checked against
-- `prisma migrate diff --from-empty --to-schema-datamodel`.

-- CreateTable
CREATE TABLE "profile_music_tracks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "spotify_track_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artists" TEXT NOT NULL,
    "album_name" TEXT,
    "cover_url" TEXT,
    "spotify_url" TEXT NOT NULL,
    "preview_url" TEXT,
    "explicit" BOOLEAN NOT NULL DEFAULT false,
    "refreshed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_music_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "profile_music_tracks_refreshed_at_idx" ON "profile_music_tracks"("refreshed_at");

-- CreateIndex
CREATE UNIQUE INDEX "profile_music_tracks_user_id_position_key" ON "profile_music_tracks"("user_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "profile_music_tracks_user_id_spotify_track_id_key" ON "profile_music_tracks"("user_id", "spotify_track_id");

-- AddForeignKey
ALTER TABLE "profile_music_tracks" ADD CONSTRAINT "profile_music_tracks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
