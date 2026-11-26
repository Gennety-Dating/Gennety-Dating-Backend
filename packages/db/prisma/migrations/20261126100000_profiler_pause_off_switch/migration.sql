-- Additive: agent concept phase 4 item 1 (founder 2026-11-26). Telegram
-- Profiler batches pause for 14 days after two ignored in a row, and the
-- person gets a persistent off switch. One counter with a constant default and
-- two nullable timestamps; no existing row is rewritten, no index.
ALTER TABLE "profiles" ADD COLUMN "profiler_ignored_streak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "profiler_paused_until" TIMESTAMP(3),
ADD COLUMN "profiler_opted_out_at" TIMESTAMP(3);
