-- Several photos in one chat turn: `messages.image_urls` next to the old `image_url`
-- (decision journal 2026-09-21, commit b1562471 changed only schema.prisma, no migration).
-- Purely additive: one column with a constant default — metadata-only in Postgres 11+,
-- no existing row rewritten; old code never selects it.
-- Written by hand; DDL identical to
-- `prisma migrate diff --from-schema-datamodel <a6e902d5> --to-schema-datamodel <b1562471> --script`.

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "image_urls" TEXT[] DEFAULT ARRAY[]::TEXT[];
