-- Launch Events removed (founder decision 2026-09-16).
--
-- The subsystem never shipped: `EVENTS_FEATURE_ENABLED` was never added to the
-- production `.env` (deploy journal, repeatedly), the admission hook was only
-- wired inside that flag, and no admin route was reachable without it. Every
-- table below is therefore empty in production and this migration destroys no
-- user data. Verify before applying:
--   SELECT count(*) FROM events;  -- expected 0
--
-- `announcements.event_id` was the one column outside the subsystem that
-- pointed into it: an optional link from a bell announcement to an event. It
-- was already nullable, so dropping it takes nothing away from an announcement
-- that never named an event.
--
-- Written by hand from
-- `prisma migrate diff --from-schema-datamodel <trunk> --to-schema-datamodel <branch> --script`.

-- DropForeignKey
ALTER TABLE "announcements" DROP CONSTRAINT "announcements_event_id_fkey";

-- DropForeignKey
ALTER TABLE "waitlist_applications" DROP CONSTRAINT "waitlist_applications_event_id_fkey";

-- DropForeignKey
ALTER TABLE "waitlist_applications" DROP CONSTRAINT "waitlist_applications_user_id_fkey";

-- DropForeignKey
ALTER TABLE "event_ticket_tiers" DROP CONSTRAINT "event_ticket_tiers_event_id_fkey";

-- DropForeignKey
ALTER TABLE "event_tickets" DROP CONSTRAINT "event_tickets_event_id_fkey";

-- DropForeignKey
ALTER TABLE "event_tickets" DROP CONSTRAINT "event_tickets_tier_id_fkey";

-- DropForeignKey
ALTER TABLE "event_tickets" DROP CONSTRAINT "event_tickets_user_id_fkey";

-- DropForeignKey
ALTER TABLE "event_staff_tokens" DROP CONSTRAINT "event_staff_tokens_event_id_fkey";

-- DropForeignKey
ALTER TABLE "event_rounds" DROP CONSTRAINT "event_rounds_event_id_fkey";

-- DropForeignKey
ALTER TABLE "event_round_pairings" DROP CONSTRAINT "event_round_pairings_round_id_fkey";

-- DropForeignKey
ALTER TABLE "event_round_pairings" DROP CONSTRAINT "event_round_pairings_user_a_id_fkey";

-- DropForeignKey
ALTER TABLE "event_round_pairings" DROP CONSTRAINT "event_round_pairings_user_b_id_fkey";

-- DropForeignKey
ALTER TABLE "event_feedback" DROP CONSTRAINT "event_feedback_event_id_fkey";

-- DropForeignKey
ALTER TABLE "event_feedback" DROP CONSTRAINT "event_feedback_user_id_fkey";

-- AlterTable
ALTER TABLE "announcements" DROP COLUMN "event_id";

-- DropTable
DROP TABLE "events";

-- DropTable
DROP TABLE "waitlist_applications";

-- DropTable
DROP TABLE "event_ticket_tiers";

-- DropTable
DROP TABLE "event_tickets";

-- DropTable
DROP TABLE "event_staff_tokens";

-- DropTable
DROP TABLE "event_rounds";

-- DropTable
DROP TABLE "event_round_pairings";

-- DropTable
DROP TABLE "event_feedback";

