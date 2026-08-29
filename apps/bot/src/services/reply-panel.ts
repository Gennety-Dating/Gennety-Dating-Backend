import type { ReplyKeyboardMarkup, ReplyKeyboardRemove } from "grammy/types";
import {
  t,
  SUPPORTED_LANGUAGES,
  type Language,
  type ReplyPanel,
  type SessionData,
} from "@gennety/shared";
import { isAwaitingVoicePrompt } from "./voice-prompt-claim.js";

/**
 * The persistent bottom panel of onboarding — a Telegram *reply* keyboard
 * carrying the current step's one standing affordance.
 *
 * Two steps own one today: the photo-upload stage's editor entry
 * (PRODUCT_SPEC §1.3) and the voice-prompt step's "without a voice note"
 * (§1.3b).
 *
 * Why a reply keyboard rather than an inline button on the step's message:
 * that message scrolls away the moment the step's own traffic lands below it —
 * the user's photos and any per-frame rejection reply on one step, their
 * recording plus the validation shimmer plus the confirmation card on the
 * other. A reply keyboard is the only Telegram surface guaranteed to still be
 * there whenever the user looks down. That matters because before this the
 * first photo upload was write-only, and because a recording that has been
 * accepted can still be dropped.
 *
 * Two Telegram facts shape the whole design:
 *
 * 1. A message carries exactly ONE `reply_markup`, so the panel and a step's
 *    inline button cannot share a message. They don't need to: a reply keyboard
 *    is CHAT-level and persists from whichever message first carried it, so the
 *    panel attaches to the step's first plain-text message and simply stays.
 * 2. It persists until explicitly removed, and it hides the user's normal
 *    keyboard — an orphaned panel would block the next onboarding question.
 *
 * ## Why ONE owner rather than a flag per step
 *
 * The steps hand the panel over to each other, and Telegram REPLACES a reply
 * keyboard when a new one is sent. So photos → voice is a single message with
 * the new keyboard on it: no `remove_keyboard` in between, no extra bubble, no
 * gap where the wrong placeholder is on screen. Two independent flags would
 * eventually emit a removal that killed the other step's panel instead.
 *
 * That handover is also the only way the voice step can put its panel up at
 * all. Its ask message needed its `reply_markup` slot for an inline skip
 * button, so it could carry neither the panel nor the photo panel's teardown —
 * and there is no `reply_markup`-free message anywhere downstream to carry one
 * either (`sendVerificationCTABare`, `buildMainMenuPayload` and
 * `pinStatusBanner` all set an inline keyboard). The photo panel therefore
 * survived the entire voice step and into the verification gate, which is the
 * bug this module's shape exists to make unreachable.
 *
 * Both directions go through {@link replyPanelSync}, so any plain-text send in
 * the onboarding flow can spread it in unconditionally.
 */

/**
 * Markup a plain-text onboarding message should carry to keep the bottom panel
 * in sync with the step the user is actually on:
 *
 * - a step that owns a panel just became active → that panel;
 * - one panel handed over to another → the new panel (never a removal first);
 * - no step owns one any more → `remove_keyboard`;
 * - otherwise → nothing, so spreading this into every send is safe.
 *
 * Deliberately mutates `session`: the panel must be shown once and removed
 * once, and making each call site remember to flip the field is exactly how it
 * ends up orphaned. Callers hold the result in a local so a retried send (the
 * Markdown → plain-text fallback) still carries the same markup.
 *
 * Never attach this to a message that needs its own inline keyboard — see the
 * one-`reply_markup` rule above.
 */
export function replyPanelSync(
  session: SessionData,
): { reply_markup?: ReplyKeyboardMarkup | ReplyKeyboardRemove } {
  const current = currentPanel(session);
  const desired = desiredPanel(session);
  if (desired === current) return {};

  session.replyPanel = desired;
  // The legacy flag has been consulted for the last time on this session; any
  // later `null` must not read as "an old photo panel is still up" and emit a
  // second removal.
  session.photoStagePanelShown = false;

  if (desired === null) return { reply_markup: { remove_keyboard: true } };
  return replyPanelMarkupFor(desired, session.language);
}

/**
 * What is on screen right now.
 *
 * `SessionData` is persisted JSON in `bot_sessions` and survives a deploy, and
 * a row written before `replyPanel` existed cannot be told apart from "no
 * panel" by looking for `undefined` — the session middleware spreads
 * `DEFAULT_SESSION` first, so the field reads `null` either way. The legacy
 * boolean is what distinguishes them, and reading it here is what stops every
 * user standing in the photo stage at restart from being left with a panel
 * nothing will ever remove.
 */
function currentPanel(session: SessionData): ReplyPanel {
  if (session.replyPanel === null && session.photoStagePanelShown) return "photos";
  return session.replyPanel;
}

/**
 * What SHOULD be on screen, from step state alone.
 *
 * Voice outranks photos, and that order is load-bearing rather than tidy: the
 * all-rejected unsolicited branch of the photo-burst flush
 * (`handlers/onboarding/conversational.ts`) can send the voice-prompt ask
 * without having reset `expectingPhoto`, so a photos-first reading would leave
 * the photo panel up and the voice panel would silently never appear on that
 * path. `voice_prompt` comes after `photos` in the collector's question order,
 * so a live voice claim is the authoritative one by construction.
 *
 * The voice side is read through `isAwaitingVoicePrompt` rather than off
 * `session.expectingVoicePrompt` directly, so a stale flag on an old session
 * cannot raise a panel for a feature that is switched off — "switching the
 * feature off is complete rather than partial" is that predicate's own claim
 * and this is one of the places it has to hold.
 */
function desiredPanel(session: SessionData): ReplyPanel {
  if (isAwaitingVoicePrompt(session)) return "voice";
  if (session.expectingPhoto) return "photos";
  return null;
}

/**
 * A panel's markup on its own, for the one entry path that has no live session
 * object to sync against: the Type Radar resume
 * (`handlers/onboarding/type-radar.ts`), which sends the next question from the
 * Mini App route / Skip callback and hands its session patch back to the caller.
 *
 * Callers that DO hold a session must use {@link replyPanelSync} instead — it
 * owns the show-once / hand-over / remove-once bookkeeping.
 */
export function replyPanelMarkupFor(
  panel: Exclude<ReplyPanel, null>,
  language: Language,
): { reply_markup: ReplyKeyboardMarkup } {
  return {
    reply_markup: {
      keyboard: [[{ text: panelLabel(panel, language) }]],
      resize_keyboard: true,
      is_persistent: true,
      input_field_placeholder: t(language, PLACEHOLDER_KEY[panel]),
    },
  };
}

const LABEL_KEY = {
  photos: "photoStagePanelBtn",
  voice: "voicePromptSkipButton",
} as const;

const PLACEHOLDER_KEY = {
  photos: "photoStagePanelPlaceholder",
  voice: "voicePromptPanelPlaceholder",
} as const;

function panelLabel(panel: Exclude<ReplyPanel, null>, language: Language): string {
  return t(language, LABEL_KEY[panel]);
}

/**
 * Every label a panel button can carry, across all five languages.
 *
 * A reply-keyboard tap arrives as an ordinary text message containing the
 * button's label — there is no callback data to match on — so recognising it
 * means comparing against the exact rendered strings. All languages are
 * matched, not just the user's current one, because a Settings language switch
 * can land between the panel being sent and tapped.
 */
const labelCache = new Map<Exclude<ReplyPanel, null>, Set<string>>();

function allLabels(panel: Exclude<ReplyPanel, null>): Set<string> {
  const cached = labelCache.get(panel);
  if (cached) return cached;
  const labels = new Set(
    SUPPORTED_LANGUAGES.map((language) => panelLabel(panel, language).trim()),
  );
  labelCache.set(panel, labels);
  return labels;
}

/** True when a plain text message is a tap on the photo stage's panel button. */
export function isPhotoStagePanelTap(text: string): boolean {
  return allLabels("photos").has(text.trim());
}

/** True when a plain text message is a tap on the voice step's panel button. */
export function isVoicePromptPanelTap(text: string): boolean {
  return allLabels("voice").has(text.trim());
}
