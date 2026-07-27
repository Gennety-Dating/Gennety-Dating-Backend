import type { ReplyKeyboardMarkup, ReplyKeyboardRemove } from "grammy/types";
import {
  t,
  SUPPORTED_LANGUAGES,
  type Language,
  type SessionData,
} from "@gennety/shared";

/**
 * The persistent bottom panel of the onboarding photo-upload stage
 * (PRODUCT_SPEC §1.3) — a Telegram *reply* keyboard carrying one button into
 * the photo editor.
 *
 * Why a reply keyboard rather than an inline button on the progress message:
 * the progress message scrolls away the moment the user sends the next batch
 * (their own photos, plus any per-frame rejection reply, land below it). A
 * reply keyboard is the only Telegram surface guaranteed to still be there
 * whenever the user looks down. That matters because before this the first
 * upload was write-only — photos could be added but never reconsidered.
 *
 * Two Telegram facts shape the whole design:
 *
 * 1. A message carries exactly ONE `reply_markup`, so the panel and the stage's
 *    inline "Continue" cannot share a message. They don't need to: a reply
 *    keyboard is CHAT-level and persists from whichever message first carried
 *    it, so the panel attaches to the stage's first plain-text message and
 *    simply stays.
 * 2. It persists until explicitly removed, and it hides the user's normal
 *    keyboard — an orphaned panel would block the next onboarding question.
 *    `session.photoStagePanelShown` tracks it so the teardown can ride the very
 *    next message the bot sends after the stage ends, whichever path ended it.
 *
 * Both directions go through {@link photoStagePanelSync}, so any plain-text
 * send in the onboarding flow can spread it in unconditionally.
 */

/**
 * Markup a plain-text onboarding message should carry to keep the bottom panel
 * in sync with the stage:
 *
 * - stage just became active → the panel (armed for teardown);
 * - stage just ended → `remove_keyboard`;
 * - otherwise → nothing, so spreading this into every send is safe.
 *
 * Deliberately mutates `session`: the panel must be shown once and removed
 * once, and making each call site remember to flip the flag is exactly how it
 * ends up orphaned. Callers hold the result in a local so a retried send (the
 * Markdown → plain-text fallback) still carries the same markup.
 *
 * Never attach this to a message that needs its own inline keyboard — see the
 * one-`reply_markup` rule above.
 */
export function photoStagePanelSync(
  session: SessionData,
): { reply_markup?: ReplyKeyboardMarkup | ReplyKeyboardRemove } {
  if (session.expectingPhoto) {
    if (session.photoStagePanelShown) return {};
    session.photoStagePanelShown = true;
    return photoStagePanelMarkup(session.language);
  }

  if (!session.photoStagePanelShown) return {};
  session.photoStagePanelShown = false;
  return { reply_markup: { remove_keyboard: true } };
}

/**
 * The panel markup on its own, for the one stage-entry path that has no live
 * session object to sync against: the Type Radar resume
 * (`handlers/onboarding/type-radar.ts`), which sends the photo request from the
 * Mini App route / Skip callback and hands its session patch back to the caller.
 *
 * Callers that DO hold a session must use {@link photoStagePanelSync} instead —
 * it owns the show-once / remove-once bookkeeping.
 */
export function photoStagePanelMarkup(
  language: Language,
): { reply_markup: ReplyKeyboardMarkup } {
  return {
    reply_markup: {
      keyboard: [[{ text: photoStagePanelLabel(language) }]],
      resize_keyboard: true,
      is_persistent: true,
      input_field_placeholder: t(language, "photoStagePanelPlaceholder"),
    },
  };
}

function photoStagePanelLabel(language: Language): string {
  return t(language, "photoStagePanelBtn");
}

/**
 * Every label the panel button can carry, across all five languages.
 *
 * A reply-keyboard tap arrives as an ordinary text message containing the
 * button's label — there is no callback data to match on — so recognising it
 * means comparing against the exact rendered strings. All languages are
 * matched, not just the user's current one, because a Settings language switch
 * can land between the panel being sent and tapped.
 */
let panelLabels: Set<string> | null = null;

function allPanelLabels(): Set<string> {
  if (panelLabels) return panelLabels;
  panelLabels = new Set(
    SUPPORTED_LANGUAGES.map((language) => photoStagePanelLabel(language).trim()),
  );
  return panelLabels;
}

/** True when a plain text message is a tap on the panel button. */
export function isPhotoStagePanelTap(text: string): boolean {
  return allPanelLabels().has(text.trim());
}
