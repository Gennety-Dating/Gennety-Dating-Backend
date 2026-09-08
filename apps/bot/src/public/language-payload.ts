import { SUPPORTED_LANGUAGES, type Language } from "@gennety/shared";

/**
 * Validation for `PATCH /v1/me/language`, kept out of `routes/me.ts` for the
 * same reason `theme-payload.ts` is: that router drags in multer, storage,
 * vision and the onboarding agent, none of which this decision touches, and a
 * test that had to stand all of it up would be testing the wrong thing.
 */

/**
 * Returns the accepted language, or the reason it was refused.
 *
 * The list in `@gennety/shared` is the only source of truth, and it is checked
 * rather than pattern-matched: this value decides which language the account's
 * pushes, interview questions and rendered Telegram cards come out in, so a
 * string that merely LOOKS like a locale ("ru-RU", "EN") must not reach the
 * column. Nothing here normalises case or region — accepting a near-miss would
 * store a value no renderer knows how to read.
 */
export function parseLanguagePayload(body: unknown): { language: Language } | { error: string } {
  const raw = (body ?? {}) as { language?: unknown };
  const language = SUPPORTED_LANGUAGES.find((l) => l === raw.language);
  if (!language) return { error: "Unsupported language" };
  return { language };
}
