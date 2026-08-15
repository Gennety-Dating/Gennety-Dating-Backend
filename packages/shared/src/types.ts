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
  | "settings_theme"
  | "edit_photos"
  | "edit_video"
  | "edit_bio"
  | "edit_major"
  | "edit_partner_preferences"
  | "edit_age_range"
  /**
   * After an in-chat Premium cancellation, the bot politely asks WHY. The next
   * free-text message is captured as the churn reason (and attached to the
   * `cancelled` SubscriptionLedger row) instead of going to the menu agent.
   * `premiumCancelLedgerId` holds the row to annotate; a Skip button also exits.
   */
  | "awaiting_premium_cancel_reason";

export interface PendingAccountAction {
  nonce: string;
  stage: "freeze_or_delete" | "delete_final";
  expiresAtMs: number;
  messageId: number;
}

/** One-time, expiring confirmation for the in-chat Premium cancel button. */
export interface PendingPremiumCancel {
  nonce: string;
  stage: "offer" | "final";
  expiresAtMs: number;
  messageId: number;
}

/** One photo's own card message in the photo manager — see `SessionData.photoCards`. */
export interface PhotoManagerCard {
  msgId: number;
  ref: string;
}

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
  /**
   * The T+24h "did you actually meet?" question is open and the next plain
   * message is its answer (PRODUCT_SPEC §Phase 4). Buttons are the primary
   * path and stay deterministic; this state exists because the question is
   * asked in ordinary prose, and prose invites a typed reply — without it
   * "да, всё супер" would fall through to the concierge and the one fact the
   * question exists to collect would be lost.
   *
   * Bounded like every other claim here (`services/match-flow-claim.ts`).
   */
  | "awaiting_attendance"
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
  /**
   * True while the photo manager was opened from a verification prompt
   * ("Upload different photos") rather than from the menu. Changes three things
   * about the same manager: a "delete all and start over" action appears, the
   * `MIN_PHOTOS` delete floor is lifted (the user is not in the matching pool
   * yet, and someone whose four photos are all of another person must be able
   * to drop them), and finishing returns to verification instead of the menu.
   */
  verifyPhotoRedo: boolean;
  /**
   * True while the onboarding photo EDITOR is open — the card manager reached
   * from the upload stage's bottom panel (PRODUCT_SPEC §1.3). It reuses the
   * same cards as the menu manager but is driven by the onboarding router
   * (`onb:ph:*`), has no `MIN_PHOTOS` delete floor (the user is not in the
   * matching pool yet, and "Continue" already refuses to appear under the
   * minimum), and returns to the upload stage instead of a menu.
   *
   * While it is open, an incoming photo burst re-renders the editor rather
   * than the ordinary stage progress message, so "delete one, send its
   * replacement" stays one continuous screen.
   */
  onboardingPhotoEdit: boolean;
  /**
   * True while the onboarding upload stage's persistent bottom panel (a reply
   * keyboard carrying the editor entry) is on screen. It is what lets the
   * teardown ride the next outgoing message once the stage ends — a reply
   * keyboard survives until explicitly removed, and it hides the user's normal
   * keyboard, so an orphaned one would block the next onboarding question.
   */
  photoStagePanelShown: boolean;
  /**
   * One entry per photo currently shown as its own card message in the photo
   * manager (photo + a single delete button), in no particular order.
   * `ref` is the photo's `pendingPhotos` entry (Telegram file_id or Supabase
   * path) — the delete button on a card resolves straight to this ref via the
   * TAPPED MESSAGE's id (`ctx.callbackQuery.message.message_id`), never an
   * array index, so cards stay independently deletable/addable without any
   * renumbering. Cleared when the manager closes (Done) or is abandoned.
   */
  photoCards: PhotoManagerCard[];
  /** One-time, expiring confirmation for Telegram Freeze/Delete callbacks. */
  pendingAccountAction: PendingAccountAction | null;
  /** One-time, expiring confirmation for the in-chat Premium cancel button. */
  pendingPremiumCancel: PendingPremiumCancel | null;
  /**
   * `SubscriptionLedger` row id of an in-chat cancellation whose churn reason we
   * are waiting for (paired with `menuState === "awaiting_premium_cancel_reason"`).
   */
  premiumCancelLedgerId: string | null;
  /** Sub-state for the matching / scheduling flow (Phase 3) */
  matchFlow: MatchFlowState;
  /**
   * Deadline (epoch ms) of the CURRENT free-text claim on this chat — the
   * `awaiting_*` states above that consume a plain message as their answer.
   *
   * An open question is not a standing claim on everything the user ever types
   * (the same rule the Profiler states for `profilerAnswerWindowUntil`). Without
   * a bound, a user who tapped "🚨 Report" or confirmed an emergency
   * cancellation and then simply walked away left the claim live forever: the
   * next unrelated message — hours or days later — was consumed as the report
   * body, or as the reason that CANCELS a scheduled date. Nothing else in the
   * product ever released it.
   *
   * `null` (including on every session written before this field existed) means
   * "no live claim", so a stale state fails closed: the message falls through to
   * the concierge agent, which can see the live match and offer the real action.
   * Owned by `services/match-flow-claim.ts`; `coordination_chat` is deliberately
   * outside it (explicitly entered, and bounded by the proxy window instead).
   */
  matchFlowClaimUntil: number | null;
  /**
   * Deadline past which a `menuState` that consumes plain text stops owning the
   * chat — the menu twin of `matchFlowClaimUntil` above.
   *
   * The match flows were bounded and the menu edits were not, so the same class
   * of bug survived on the other side of the router: `edit_bio` writes its
   * message verbatim into `Profile.psychologicalSummary`, the dominant
   * embedding input (`V_explicit`, 0.65). A user who tapped "About me" and
   * walked away had their NEXT message — on any topic, weeks later — become
   * their entire profile analysis, with nothing to restore from, while the
   * question they actually asked went unanswered.
   *
   * `null` means "no live claim" and is what every session written before this
   * field existed reads, so a stale state fails closed. Owned by
   * `services/menu-text-claim.ts`; the photo/video upload states are outside it
   * (they consume media, not text, and a stray photo writes nothing).
   */
  menuClaimUntil: number | null;
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
  verifyPhotoRedo: false,
  onboardingPhotoEdit: false,
  photoStagePanelShown: false,
  photoCards: [],
  pendingAccountAction: null,
  pendingPremiumCancel: null,
  premiumCancelLedgerId: null,
  matchFlow: "idle",
  matchFlowClaimUntil: null,
  menuClaimUntil: null,
  activeMatchId: null,
  pendingReportCategory: null,
  awaitingContextDump: false,
  contextDumpBuffer: "",
  onboardingAnswerCount: 0,
};
