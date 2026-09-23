-- The time-agreement Live Activity (decision journal 2026-09-23): the §3.6 twin of
-- `venue_change_activities`. One row per side while the server believes that side's
-- lock-screen card is running — the phase and content hash last pushed, the hash of the
-- PARTNER's slots (the only change that may raise an alert on an update), and when the
-- card was push-started (the ~7.5h restart reads it). Durable because a second
-- push-to-start opens a SECOND card on the phone; a restarted bot must know one is
-- already up. `match_id` is free-form (no FK), like `venue_change_activities.match_id`;
-- `user_id` cascades with the account.
-- Purely additive: one new table, no existing column changed. Old code never reads it.
-- Written by hand; DDL identical in shape to
-- `20260922180000_venue_change_activity` plus the `partner_hash` column.

-- CreateTable
CREATE TABLE "time_agreement_activities" (
    "match_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phase" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "partner_hash" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_agreement_activities_pkey" PRIMARY KEY ("match_id","user_id")
);

-- AddForeignKey
ALTER TABLE "time_agreement_activities" ADD CONSTRAINT "time_agreement_activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
