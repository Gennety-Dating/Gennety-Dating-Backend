import { MIN_AGE, MAX_AGE, MIN_PHOTOS, MAX_PHOTOS } from "@gennety/shared";
import type { OnboardingQuestion } from "../services/onboarding-collector.js";

/**
 * ui_hint — the hybrid-chat contract for the native client (IOS_APP_ROADMAP
 * task 0.7; DESIGN.md "гибридный чат"): alongside each interview/chat turn
 * the server names which NATIVE inline control best captures the answer, so
 * the app renders an age wheel / choice chips / a map instead of a bare text
 * field.
 *
 * Rules of the contract:
 *  - Hints are derived DETERMINISTICALLY from the collector's canonical
 *    `currentQuestion` — never from LLM output.
 *  - A hint is a suggestion, not a gate: the server always accepts free text
 *    for the same answer, and the client MUST fall back to a plain text
 *    field for `null` or any unknown `control` value (forward compat).
 */

/** Height bounds mirror the collector's `height_out_of_range` validation. */
const MIN_HEIGHT_CM = 140;
const MAX_HEIGHT_CM = 220;

export type UiHintControl =
  | "name_age" // text name field + age wheel accessory
  | "choice_chips"
  | "height_wheel"
  | "text"
  | "multiline_text"
  | "magic_prompt" // context_dump: copy-prompt CTA + large paste field
  | "photo_upload";

export interface UiHint {
  control: UiHintControl;
  /** For `choice_chips`: canonical values the server accepts verbatim. */
  options?: string[];
  /** For wheels/counters: inclusive bounds. */
  min?: number;
  max?: number;
  /** The question may be explicitly skipped (e.g. ethnicity). */
  skippable?: boolean;
}

const QUESTION_HINTS: Partial<Record<OnboardingQuestion, UiHint>> = {
  first_name_age: { control: "name_age", min: MIN_AGE, max: MAX_AGE },
  gender: { control: "choice_chips", options: ["male", "female"] },
  preference: { control: "choice_chips", options: ["men", "women", "both"] },
  height: { control: "height_wheel", min: MIN_HEIGHT_CM, max: MAX_HEIGHT_CM },
  hobbies: { control: "text" },
  partner_preferences: { control: "multiline_text" },
  ethnicity: { control: "text", skippable: true },
  friday_vibe: { control: "multiline_text" },
  vibe_focus: { control: "text" },
  ai_memory: { control: "choice_chips", options: ["accepted", "declined"] },
  context_dump: { control: "magic_prompt" },
  photos: { control: "photo_upload", min: MIN_PHOTOS, max: MAX_PHOTOS },
};

/**
 * Resolve the hint for a canonical collector question key. Unknown keys and
 * `complete`/null resolve to `null` (client falls back to plain text) — this
 * also covers legacy users whose onboarding predates the fact collector.
 */
export function uiHintForQuestion(question: string | null | undefined): UiHint | null {
  if (!question) return null;
  return QUESTION_HINTS[question as OnboardingQuestion] ?? null;
}
