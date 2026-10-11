-- Audit 2026-10-11 (B-04, B-21): index-only, no column changes.
-- Names match Prisma's defaults (checked with `prisma migrate diff`).

-- App Store Premium owner lookup by subscription anchor (webhook + report path).
CREATE INDEX IF NOT EXISTS "users_premium_external_id_idx" ON "users"("premium_external_id");

-- Proxy-close sweep: proxy_closed_at IS NULL AND proxy_closes_at <= now.
CREATE INDEX IF NOT EXISTS "matches_proxy_closed_at_proxy_closes_at_idx" ON "matches"("proxy_closed_at", "proxy_closes_at");

-- Post-date feedback-prompt sweep: feedback_prompted_at IS NULL AND agreed_time <= threshold.
CREATE INDEX IF NOT EXISTS "matches_feedback_prompted_at_agreed_time_idx" ON "matches"("feedback_prompted_at", "agreed_time");

-- scheduled / negotiating_venue + agreed_time window sweeps on the lifecycle tick.
CREATE INDEX IF NOT EXISTS "matches_status_agreed_time_idx" ON "matches"("status", "agreed_time");
