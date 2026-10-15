-- AlterTable
ALTER TABLE "users" ADD COLUMN     "analytics_opt_in" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "analytics_opt_in_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "client_events" ADD COLUMN     "platform" TEXT NOT NULL DEFAULT 'ios',
ADD COLUMN     "screen" TEXT,
ADD COLUMN     "session_id" UUID;

-- CreateTable
CREATE TABLE "metric_days" (
    "day" DATE NOT NULL,
    "metric" TEXT NOT NULL,
    "dim" TEXT NOT NULL DEFAULT '',
    "value" DOUBLE PRECISION NOT NULL,
    "n" INTEGER NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_days_pkey" PRIMARY KEY ("day","metric","dim")
);

-- CreateTable
CREATE TABLE "insights" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "baseline" DOUBLE PRECISION,
    "n" INTEGER NOT NULL,
    "small_sample" BOOLEAN NOT NULL DEFAULT false,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "code_hint" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metric_days_metric_day_idx" ON "metric_days"("metric", "day");

-- CreateIndex
CREATE UNIQUE INDEX "insights_key_key" ON "insights"("key");

-- CreateIndex
CREATE INDEX "insights_resolved_at_severity_idx" ON "insights"("resolved_at", "severity");

-- CreateIndex
CREATE INDEX "insights_kind_last_seen_at_idx" ON "insights"("kind", "last_seen_at");

-- CreateIndex
CREATE INDEX "client_events_screen_occurred_at_idx" ON "client_events"("screen", "occurred_at");

-- CreateIndex
CREATE INDEX "client_events_user_id_occurred_at_idx" ON "client_events"("user_id", "occurred_at");

