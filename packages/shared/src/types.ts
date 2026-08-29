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

/**
 * Which onboarding step currently owns the chat's bottom reply keyboard.
 *
 * The steps hand it over rather than each removing their own: Telegram REPLACES
 * a reply keyboard when a new one is sent, so photos → voice is one message and
 * no `remove_keyboard` in between. See `services/reply-panel.ts`.
 */
export type ReplyPanel = "photos" | "voice" | null;

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
  /**
   * True while the onboarding voice-prompt step is waiting for a recording
   * (VOICE_PROMPT_PRODUCT_SPEC.md §4.1).
   *
   * This is a claim on incoming VOICE, and it is the one thing standing between
   * the feature and `voiceHandler` — which is mounted ahead of every router
   * (`bot.ts`), transcribes any `message:voice` through Whisper and replaces
   * `ctx.message.text` with the transcript. Without the flag the recording the
   * user was just asked for arrives at the collector as a sentence and gets
   * mined for profile facts.
   *
   * Deliberately UNBOUNDED, unlike the text and media claims in
   * `menu-text-claim.ts`. Those bound a sub-flow that the user can walk away
   * from while the product moves on; this is a linear onboarding question, so
   * "still waiting" a week later is the correct state — the same reasoning
   * `expectingPhoto` above already runs on. It is cleared by answering, by
   * skipping, and by finalization, and the predicate additionally refuses once
   * onboarding is complete, so it cannot leak into the post-onboarding chat.
   */
  expectingVoicePrompt: boolean;
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
   * Which persistent bottom panel (reply keyboard) onboarding currently has on
   * screen, or `null` for none — see `services/reply-panel.ts`.
   *
   * A reply keyboard is CHAT-level: it survives until explicitly removed, and
   * it hides the user's normal keyboard, so an orphaned one would block the
   * next onboarding question. One field rather than one flag per step, because
   * the steps hand the panel over to each other: two independent flags would
   * eventually emit a `remove_keyboard` that kills the other step's panel.
   */
  replyPanel: ReplyPanel;
  /**
   * @deprecated Superseded by {@link SessionData.replyPanel}. Kept because
   * `SessionData` is persisted JSON in `bot_sessions` and survives a deploy:
   * `replyPanelSync` reads a legacy `true` here as `replyPanel = "photos"`, so
   * a user standing in the photo stage at restart is not left with an orphaned
   * panel. Never written any more.
   */
  photoStagePanelShown: boolean;
  /**
   * Telegram message id of the live voice-prompt confirmation card — the
   * "recorded, tap Done" message and its single inline button
   * (VOICE_PROMPT_PRODUCT_SPEC.md §4.1).
   *
   * Tracked for the same reason `photoManagerMsgId` is: a re-record strips the
   * previous card's keyboard before sending the new one, so a resolved card
   * never sits in the chat still looking answerable. Also the discriminator
   * between "skip" and "drop": non-null means a recording was already saved
   * this step, so the panel tap owes a `deleteVoicePrompt`.
   */
  voicePromptCardMsgId: number | null;
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
  expectingVoicePrompt: false,
  pendingPhotos: [],
  pendingProfileMedia: [],
  pendingPhotoUniqueIds: [],
  pendingPhotoHashes: [],
  pendingPhotoScores: [],
  menuState: "idle",
  photoManagerMsgId: null,
  verifyPhotoRedo: false,
  onboardingPhotoEdit: false,
  replyPanel: null,
  photoStagePanelShown: false,
  voicePromptCardMsgId: null,
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
