-- Retire external profile intake without changing questionnaire facts or media.
BEGIN;

UPDATE "onboarding_progress"
SET "completed_fields" = array_remove(array_remove("completed_fields", 'ai_memory'), 'context_dump'),
    "skipped_fields" = array_remove(array_remove("skipped_fields", 'ai_memory'), 'context_dump'),
    "asked_fields" = array_remove(array_remove("asked_fields", 'ai_memory'), 'context_dump'),
    "current_question" = CASE WHEN "current_question" IN ('ai_memory', 'context_dump') THEN NULL ELSE "current_question" END,
    "revision" = "revision" + 1,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "completed_fields" && ARRAY['ai_memory', 'context_dump']
   OR "skipped_fields" && ARRAY['ai_memory', 'context_dump']
   OR "asked_fields" && ARRAY['ai_memory', 'context_dump']
   OR "current_question" IN ('ai_memory', 'context_dump');

UPDATE "bot_sessions"
SET "data" = "data" - 'awaitingContextDump' - 'contextDumpBuffer',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "data" ?| ARRAY['awaitingContextDump', 'contextDumpBuffer'];

-- Only in-flight onboarding histories carrying retired instructions are reset.
-- Canonical answers remain in users/profiles; the next turn derives its next
-- question from those facts. Completed accounts' chat histories are preserved.
UPDATE "users"
SET "message_history" = ARRAY[]::jsonb[]
WHERE "status" = 'onboarding'
  AND EXISTS (
    SELECT 1 FROM unnest("message_history") AS message
    WHERE message::text ~* 'context_dump|Magic Prompt|AI.memory export|CONTEXT_DUMP_SAVED'
  );

ALTER TABLE "users"
  DROP COLUMN "ai_memory_export_preference",
  DROP COLUMN "ai_memory_export_preference_at";
DROP TYPE "AiMemoryExportPreference";

COMMIT;
