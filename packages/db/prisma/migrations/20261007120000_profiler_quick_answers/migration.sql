-- Profiler quick answers and «На потом» in the native app (decision journal
-- 2026-10-07): what was tapped, how the answer came about, and the postponed
-- mark.
--
-- Additive: three nullable / defaulted columns and one enum. Old code never
-- reads them; old rows keep option_ids = {} and answer_source = NULL.
-- DDL is `prisma migrate diff` verbatim: a Prisma scalar list is a nullable
-- column with a default (as `messages.image_urls`), so no NOT NULL here —
-- with it `db:drift-check` reports DROP NOT NULL and stops the deploy.

CREATE TYPE "profiler_answer_source" AS ENUM ('tap', 'text', 'both');

ALTER TABLE "profiler_answers" ADD COLUMN     "answer_source" "profiler_answer_source",
ADD COLUMN     "option_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "postponed_at" TIMESTAMP(3);
