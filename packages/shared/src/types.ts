/** Onboarding steps — mirrors the Prisma OnboardingStep enum */
export type OnboardingStep =
  | "consent"
  | "language"
  | "conversational"
  | "completed";

export type Language = "en" | "ru" | "uk";

export type Gender = "male" | "female";
export type GenderPreference = "men" | "women" | "both";

/** Post-onboarding menu sub-state. `idle` means the main menu is shown or no menu flow is active. */
export type MenuState =
  | "idle"
  | "settings_lang"
  | "edit_photos"
  | "edit_bio"
  | "edit_major"
  | "edit_age_range"
  | "edit_visual_prefs";

/**
 * Sub-state for the matching / scheduling flow. `idle` means no match is
 * currently awaiting the user's free-text input.
 *   - `awaiting_calendar`: iteration 3 — the Mini App is open and we're
 *     waiting for `web_app_data` containing the picked timeslot.
 *
 * Note: rejection reasons are collected conversationally by the menu agent
 * via `record_rejection_feedback`, so there is no dedicated session state
 * for them.
 */
export type MatchFlowState =
  | "idle"
  | "awaiting_calendar"
  | "awaiting_venue_details"
  | "awaiting_emergency_reason"
  | "awaiting_feedback"
  | "awaiting_report_details";

/** Session data persisted per-user across messages */
export interface SessionData {
  onboardingStep: OnboardingStep;
  language: Language;
  /** Whether the agent is currently expecting a photo upload */
  expectingPhoto: boolean;
  /** Temporary storage for collected photos during conversational onboarding */
  pendingPhotos: string[];
  /** file_unique_id of each pending photo, for dedupe when Telegram re-delivers album frames */
  pendingPhotoUniqueIds: string[];
  /** Visual screening votes (used by edit-profile visual re-screening) */
  visualVotes: Array<{ photoIndex: number; liked: boolean }>;
  /** Sub-state for the post-onboarding main menu flows */
  menuState: MenuState;
  /** Sub-state for the matching / scheduling flow (Phase 3) */
  matchFlow: MatchFlowState;
  /** Match id currently awaiting this user's text input (rejection reason / calendar) */
  activeMatchId: string | null;
  /**
   * True after the Magic Prompt has been sent to the user.
   * Incoming text messages are buffered into contextDumpBuffer instead of
   * being forwarded directly to the LLM agent, because Telegram may split
   * a long paste into multiple messages.
   */
  awaitingContextDump: boolean;
  /** Accumulated text chunks from the user's LLM context dump paste */
  contextDumpBuffer: string;
}

export const DEFAULT_SESSION: SessionData = {
  onboardingStep: "consent",
  language: "en",
  expectingPhoto: false,
  pendingPhotos: [],
  pendingPhotoUniqueIds: [],
  visualVotes: [],
  menuState: "idle",
  matchFlow: "idle",
  activeMatchId: null,
  awaitingContextDump: false,
  contextDumpBuffer: "",
};
