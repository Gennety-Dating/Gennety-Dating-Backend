-- AlterTable
ALTER TABLE "curated_venues" ADD COLUMN     "is_hub_fallback" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "terminal_invite_sent_at" TIMESTAMP(3),
ADD COLUMN     "terminal_reminder_sent_at" TIMESTAMP(3);

-- Pin Kyiv's hub for the Venue Intent V2 fallback (decision 2026-09-11):
-- "ТРІШКИ БІЛЬШЕ на Золотих Воротах" (Volodymyrska 40/2) — 4.5★ on 2,289
-- reviews, moderate price, open 09:00–22:00 every day, 70 m from Zoloti Vorota.
-- Every per-domain copy of the place is flagged. Zero rows on a database that
-- never imported the Kyiv catalog, which is harmless: the fallback then derives
-- the most central eligible cafe on its own.
UPDATE "curated_venues" SET "is_hub_fallback" = true WHERE "place_id" = 'ChIJCf0hmzbP1EARL6cbjd3G1i4';
