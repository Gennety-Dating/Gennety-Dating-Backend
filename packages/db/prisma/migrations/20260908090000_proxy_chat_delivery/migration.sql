-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "proxy_read_at_a" TIMESTAMP(3),
ADD COLUMN     "proxy_read_at_b" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "proxy_messages" ADD COLUMN     "delivered_at" TIMESTAMP(3);
