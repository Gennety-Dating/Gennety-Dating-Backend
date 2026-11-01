-- Additive: a one-word topic so two ideas can meet without either person's words.
-- AlterTable
ALTER TABLE "memory_ideas" ADD COLUMN     "topic" TEXT;

-- CreateIndex
CREATE INDEX "memory_ideas_user_id_topic_idx" ON "memory_ideas"("user_id", "topic");

