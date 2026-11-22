-- Additive: a chat with the agent can be archived (decision 2026-11-22).
-- One nullable column, no existing row touched, no index: a person has tens of
-- chats and every read is already scoped by user_id.
ALTER TABLE "chat_sessions" ADD COLUMN "archived_at" TIMESTAMP(3);
