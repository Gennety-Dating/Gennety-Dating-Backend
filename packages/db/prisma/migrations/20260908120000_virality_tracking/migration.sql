-- CreateTable
CREATE TABLE "referral_events" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "referrer_id" UUID,
    "invitee_id" UUID,
    "surface" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hdyhau_responses" (
    "user_id" UUID NOT NULL,
    "answer" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "answered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hdyhau_responses_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "virality_days" (
    "day" DATE NOT NULL,
    "scope" TEXT NOT NULL,
    "signups" INTEGER NOT NULL,
    "organic_signups" INTEGER NOT NULL,
    "referral_signups" INTEGER NOT NULL,
    "seed_signups" INTEGER NOT NULL,
    "baseline_organic" DOUBLE PRECISION,
    "baseline_std_dev" DOUBLE PRECISION,
    "organic_uplift" DOUBLE PRECISION,
    "k_wom" DOUBLE PRECISION,
    "wom_status" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virality_days_pkey" PRIMARY KEY ("day","scope")
);

-- CreateTable
CREATE TABLE "virality_cohorts" (
    "cohort_date" DATE NOT NULL,
    "maturity_day" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "cohort_size" INTEGER NOT NULL,
    "sharers" INTEGER NOT NULL,
    "invites_sent" INTEGER NOT NULL,
    "link_clicks" INTEGER NOT NULL,
    "activations" INTEGER NOT NULL,
    "invites_per_user" DOUBLE PRECISION NOT NULL,
    "click_rate" DOUBLE PRECISION,
    "activation_rate" DOUBLE PRECISION,
    "k_direct" DOUBLE PRECISION NOT NULL,
    "cycle_time_median_hours" DOUBLE PRECISION,
    "k_wom" DOUBLE PRECISION,
    "k_total" DOUBLE PRECISION NOT NULL,
    "mature" BOOLEAN NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virality_cohorts_pkey" PRIMARY KEY ("cohort_date","maturity_day","scope")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_events_dedupe_key_key" ON "referral_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "referral_events_kind_occurred_at_idx" ON "referral_events"("kind", "occurred_at");

-- CreateIndex
CREATE INDEX "referral_events_referrer_id_occurred_at_idx" ON "referral_events"("referrer_id", "occurred_at");

-- CreateIndex
CREATE INDEX "hdyhau_responses_answered_at_idx" ON "hdyhau_responses"("answered_at");

-- CreateIndex
CREATE INDEX "hdyhau_responses_answer_answered_at_idx" ON "hdyhau_responses"("answer", "answered_at");

-- CreateIndex
CREATE INDEX "virality_days_scope_day_idx" ON "virality_days"("scope", "day");

-- CreateIndex
CREATE INDEX "virality_cohorts_scope_cohort_date_idx" ON "virality_cohorts"("scope", "cohort_date");

-- CreateIndex
CREATE INDEX "virality_cohorts_maturity_day_cohort_date_idx" ON "virality_cohorts"("maturity_day", "cohort_date");

-- AddForeignKey
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hdyhau_responses" ADD CONSTRAINT "hdyhau_responses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
