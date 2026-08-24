import {
  MIN_AGE,
  MAX_AGE,
  MIN_HEIGHT_CM,
  MAX_HEIGHT_CM,
  MIN_PHOTOS,
  MAX_PHOTOS,
  RELATIONSHIP_INTENTS,
  VOICE_PROMPT_MIN_DURATION_SECONDS,
  VOICE_PROMPT_MAX_DURATION_SECONDS,
} from "@gennety/shared";
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

export type UiHintControl =
  | "name_age" // text name field + age wheel accessory
  | "choice_chips"
  | "height_wheel"
  | "text"
  | "multiline_text"
  | "magic_prompt" // context_dump: copy-prompt CTA + large paste field
  | "photo_upload"
  // voice_prompt: hold-to-record button, live level meter, preview + re-record.
  // `min`/`max` are SECONDS here rather than a count, which is the one place
  // this contract reuses those fields for a different unit — the control name
  // is what disambiguates them, and a client that does not know the control
  // falls back to a text field and ignores both.
  | "voice_record";

export interface UiHint {
  control: UiHintControl;
  /** For `choice_chips`: canonical values the server accepts verbatim. */
  options?: string[];
  /** For wheels/counters: inclusive bounds. */
  min?: number;
  max?: number;
  /** The question may be explicitly skipped. */
  skippable?: boolean;
}

const QUESTION_HINTS: Partial<Record<OnboardingQuestion, UiHint>> = {
  first_name_age: { control: "name_age", min: MIN_AGE, max: MAX_AGE },
  gender: { control: "choice_chips", options: ["male", "female"] },
  preference: { control: "choice_chips", options: ["men", "women", "both"] },
  height: { control: "height_wheel", min: MIN_HEIGHT_CM, max: MAX_HEIGHT_CM },
  relationship_intent: { control: "choice_chips", options: [...RELATIONSHIP_INTENTS] },
  hobbies: { control: "text" },
  partner_preferences: { control: "multiline_text" },
  friday_vibe: { control: "multiline_text" },
  vibe_focus: { control: "text" },
  ai_memory: { control: "choice_chips", options: ["accepted", "declined"] },
  context_dump: { control: "magic_prompt" },
  photos: { control: "photo_upload", min: MIN_PHOTOS, max: MAX_PHOTOS },
  voice_prompt: {
    control: "voice_record",
    min: VOICE_PROMPT_MIN_DURATION_SECONDS,
    max: VOICE_PROMPT_MAX_DURATION_SECONDS,
    skippable: true,
  },
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
