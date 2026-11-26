-- Additive: the «only my dates» mute (agent concept phase 4 item 6, schema
-- approved by the founder 2026-11-26). One boolean with a constant default:
-- no existing row is rewritten, no index (always read with the user row).
ALTER TABLE "users" ADD COLUMN "notify_only_dates" BOOLEAN NOT NULL DEFAULT false;
