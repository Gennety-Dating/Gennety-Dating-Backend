-- Additive: emoji reactions in the app chat (decision 2026-11-24). Three
-- nullable columns, no existing row touched, no index: reactions are read only
-- with the rows they sit on, which every query already scopes by user or chat.
ALTER TABLE "messages" ADD COLUMN "user_reaction" TEXT,
ADD COLUMN "agent_reaction" TEXT,
ADD COLUMN "reacted_at" TIMESTAMP(3);
