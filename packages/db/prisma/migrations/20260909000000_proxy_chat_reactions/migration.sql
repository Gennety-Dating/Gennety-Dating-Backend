-- AlterTable
ALTER TABLE "proxy_messages" ADD COLUMN     "reaction" TEXT,
ADD COLUMN     "author_chat_message_id" BIGINT;
