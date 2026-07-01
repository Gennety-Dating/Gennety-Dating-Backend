import type { ProfileMedia } from "./profile-media.js";

/** Onboarding steps — mirrors the Prisma OnboardingStep enum */
export type OnboardingStep =
  | "consent"
  | "language"
  | "conversational"
  | "completed";

export const SUPPORTED_LANGUAGES = ["en", "ru", "uk", "de", "pl"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
  ru: "Русский",
  uk: "Українська",
  de: "Deutsch",
  pl: "Polski",
};

export type Gender = "male" | "female";
export type GenderPreference = "men" | "women" | "both";

/** Post-onboarding menu sub-state. `idle` means the main menu is shown or no menu flow is active. */
export type MenuState =
  | "idle"
  | "settings_lang"
  | "edit_photos"
  | "edit_video"
  | "edit_bio"
  | "edit_major"
  | "edit_age_range";

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
  | "awaiting_report_details"
  /**
   * Active in the anonymous pre-date proxy chat (Variant C). Entered ONLY by
   * tapping the "Enter chat" button the cron sends at T-30m, never implicitly —
   * so normal bot use (/menu, settings, photos) is never hijacked into the
   * relay. While in this state, plain-text messages are forwarded to the match;
   * `activeMatchId` holds the proxy match. Reset to `idle` on "Leave chat" or
   * when the relay leg detects the T+2h window has closed.
   */
  | "coordination_chat";

/** Weekly matchmaking resolution used by the mobile countdown / standby UI. */
export type WeeklyMatchStatus = "pending" | "matched" | "standby";

/** Session data persisted per-user across messages */
export interface SessionData {
  onboardingStep: OnboardingStep;
  language: Language;
  /** Whether the agent is currently expecting a photo upload */
  expectingPhoto: boolean;
  /** Temporary storage for collected photos during conversational onboarding */
  pendingPhotos: string[];
  /** Structured media aligned 1:1 with pendingPhotos; empty legacy sessions normalize from pendingPhotos */
  pendingProfileMedia: ProfileMedia[];
  /** file_unique_id of each pending photo, for dedupe when Telegram re-delivers album frames */
  pendingPhotoUniqueIds: string[];
  /** Perceptual hashes for accepted pending photos, parallel to pendingPhotos when validation is enabled. */
  pendingPhotoHashes: string[];
  /**
   * Face-match similarity score (0..1) for each pending photo, parallel to
   * `pendingPhotos`. Populated by the photo-upload gate (Step 4) when a
   * verified user adds a new photo. 0 = gate didn't run (user not verified
   * yet, or the legacy gate was unavailable). Persisted to
   * `Profile.photoFaceScores` on commit.
   */
  pendingPhotoScores: number[];
  /** Sub-state for the post-onboarding main menu flows */
  menuState: MenuState;
  /**
   * Telegram message id of the live photo-manager control message (the row of
   * 🗑/➕/✅ buttons) shown while `menuState === "edit_photos"`. Tracked so each
   * re-render can strip the previous message's keyboard first, preventing a
   * stale button from deleting the wrong index. Null when no manager is open.
   */
  photoManagerMsgId: number | null;
  /** Sub-state for the matching / scheduling flow (Phase 3) */
  matchFlow: MatchFlowState;
  /** Match id currently awaiting this user's text input (rejection reason / calendar) */
  activeMatchId: string | null;
  /** Selected structured report category while waiting for optional details */
  pendingReportCategory: string | null;
  /**
   * True after the Magic Prompt has been sent to the user.
   * A substantial pasted response is briefly buffered in contextDumpBuffer
   * before being forwarded to the LLM agent.
   */
  awaitingContextDump: boolean;
  /** Buffered text from the user's LLM context dump paste */
  contextDumpBuffer: string;
  /**
   * Count of profile-survey answers given during conversational onboarding.
   * Drives the periodic "thinking" pause shown every few answers before the
   * next question is generated (see conversational handler). Onboarding-scoped.
   */
  onboardingAnswerCount: number;
}

export const DEFAULT_SESSION: SessionData = {
  onboardingStep: "consent",
  language: "en",
  expectingPhoto: false,
  pendingPhotos: [],
  pendingProfileMedia: [],
  pendingPhotoUniqueIds: [],
  pendingPhotoHashes: [],
  pendingPhotoScores: [],
  menuState: "idle",
  photoManagerMsgId: null,
  matchFlow: "idle",
  activeMatchId: null,
  pendingReportCategory: null,
  awaitingContextDump: false,
  contextDumpBuffer: "",
  onboardingAnswerCount: 0,
};
