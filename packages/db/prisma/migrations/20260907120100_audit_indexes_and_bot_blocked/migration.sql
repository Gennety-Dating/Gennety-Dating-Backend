-- AlterTable
ALTER TABLE "users" ADD COLUMN     "bot_blocked_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "users_status_id_idx" ON "users"("status", "id");

-- CreateIndex
CREATE INDEX "chat_events_created_at_idx" ON "chat_events"("created_at");

-- CreateIndex
CREATE INDEX "chat_events_direction_user_id_idx" ON "chat_events"("direction", "user_id");

-- CreateIndex
CREATE INDEX "profiles_embedding_dirty_embedding_dirty_at_idx" ON "profiles"("embedding_dirty", "embedding_dirty_at");

-- CreateIndex
CREATE INDEX "matches_user_a_id_status_idx" ON "matches"("user_a_id", "status");

-- CreateIndex
CREATE INDEX "matches_user_b_id_status_idx" ON "matches"("user_b_id", "status");

-- CreateIndex
CREATE INDEX "proxy_messages_created_at_idx" ON "proxy_messages"("created_at");

-- CreateIndex
CREATE INDEX "event_feedback_created_at_idx" ON "event_feedback"("created_at");

