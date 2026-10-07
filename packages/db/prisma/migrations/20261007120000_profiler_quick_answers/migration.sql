-- Profiler quick answers and «На потом» in the native app (decision journal
-- 2026-10-07): what was tapped, how the answer came about, and the postponed
-- mark.
--
-- Additive: three nullable / defaulted columns and one enum. Old code never
-- reads them; old rows keep option_ids = {} and answer_source = NULL.

CREATE TYPE "profiler_answer_source" AS ENUM ('tap', 'text', 'both');

ALTER TABLE "profiler_answers"
  ADD COLUMN "option_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "answer_source" "profiler_answer_source",
  ADD COLUMN "postponed_at" TIMESTAMP(3);
