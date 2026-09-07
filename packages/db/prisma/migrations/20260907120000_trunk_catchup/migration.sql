-- CreateEnum
CREATE TYPE "profiler_media_kind" AS ENUM ('photo', 'sticker');

-- CreateEnum
CREATE TYPE "short_video_platform" AS ENUM ('tiktok', 'instagram');

-- AlterTable
ALTER TABLE "profiler_answers" ADD COLUMN     "meme_file_id" TEXT,
ADD COLUMN     "meme_kind" "profiler_media_kind",
ADD COLUMN     "meme_source_url" TEXT;

-- CreateTable
CREATE TABLE "city_waitlist_entries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "city_key" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "city_waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "short_video_analyses" (
    "id" UUID NOT NULL,
    "platform" "short_video_platform" NOT NULL,
    "external_id" TEXT NOT NULL,
    "canonical_url" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "author_name" TEXT,
    "poster_file_id" TEXT,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "short_video_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "place_cache" (
    "place_id" TEXT NOT NULL,
    "name" TEXT,
    "address" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "photo_refs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "refreshed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "place_cache_pkey" PRIMARY KEY ("place_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "city_waitlist_entries_user_id_key" ON "city_waitlist_entries"("user_id");

-- CreateIndex
CREATE INDEX "city_waitlist_entries_city_key_created_at_idx" ON "city_waitlist_entries"("city_key", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "short_video_analyses_platform_external_id_key" ON "short_video_analyses"("platform", "external_id");

-- CreateIndex
CREATE INDEX "place_cache_refreshed_at_idx" ON "place_cache"("refreshed_at");

-- AddForeignKey
ALTER TABLE "city_waitlist_entries" ADD CONSTRAINT "city_waitlist_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

