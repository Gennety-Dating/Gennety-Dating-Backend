-- Additive: personal reminders the agent sets on request (decision 2026-11-20,
-- docs/product/domains/agent-reminders.md). One new table, no existing row touched.
-- CreateTable
CREATE TABLE "agent_reminders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "time_zone" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "session_id" UUID,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "exact_time" BOOLEAN NOT NULL DEFAULT false,
    "snoozes" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3),
    "answered_at" TIMESTAMP(3),
    "message_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_reminders_state_due_at_idx" ON "agent_reminders"("state", "due_at");

-- CreateIndex
CREATE INDEX "agent_reminders_user_id_state_idx" ON "agent_reminders"("user_id", "state");

-- AddForeignKey
ALTER TABLE "agent_reminders" ADD CONSTRAINT "agent_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

