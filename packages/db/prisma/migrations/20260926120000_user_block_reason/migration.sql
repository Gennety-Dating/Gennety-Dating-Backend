-- Optional block reason, for moderation only (decision journal 2026-09-26): `user_blocks.reason`.
-- Never shown to the blocked side and never returned by GET /v1/me/blocks; a block never
-- requires it (decision 2026-08-23).
-- Purely additive: one nullable column, no default — metadata-only in Postgres, no existing
-- row rewritten; old code never selects it.
-- Written by hand; DDL identical to
-- `prisma migrate diff --from-schema-datamodel <f59d9d5a> --to-schema-datamodel <this commit> --script`.

-- AlterTable
ALTER TABLE "user_blocks" ADD COLUMN     "reason" TEXT;
