import { InlineKeyboard, type Api } from "grammy";
import {
  t,
  MIN_PHOTOS,
  MAX_PHOTOS,
  type Language,
  type SessionData,
  type PhotoManagerCard,
} from "@gennety/shared";

/**
 * Card-based photo manager primitives, shared by every surface that lets a user
 * curate their photo set: the menu manager and the verification redo
 * (`handlers/menu/edit-profile.ts`), and the onboarding upload stage
 * (`handlers/onboarding/photo-editor.ts`).
 *
 * The design is PRODUCT_SPEC §2.1: each photo is its OWN message carrying a
 * single 🗑 button, followed by a counter/actions panel. It replaced a numbered
 * grid of delete buttons under one shared album, which made the user count
 * positions in a Telegram-arranged grid — a wrong tap was easy — and re-sent
 * the whole album on every delete.
 *
 * Everything here is ctx-free on purpose: the onboarding upload burst is
 * flushed by a debounced timer that runs OUTSIDE the grammY update lifecycle
 * and owns its own `bot_sessions` row read/write. `session` is mutated in place
 * (`photoCards`, `photoManagerMsgId`) and the caller owns persisting it.
 */

/**
 * What the calling surface wants on the cards and the bottom panel. Labels are
 * resolved by the caller (which knows the user's language), so this module
 * stays free of per-surface i18n branching.
 */
export interface PhotoCardsSurface {
  /**
   * Callback data on each card's own delete button. Every card of a surface
   * shares this SAME value — the tapped card is identified by the message the
   * button lives on (`ctx.callbackQuery.message.message_id`), never an index
   * encoded in the payload, so cards stay independently addable/removable with
   * no renumbering (the same "resolve by the exact tapped message" pattern used
   * by the Freeze/Delete and Premium-cancel confirmation cards).
   */
  deleteCallback: string;
  /** Card delete button label. */
  deleteLabel: string;
  /** Bottom-panel primary action — menu: "✅ Done"; onboarding: "← back to upload". */
  done: { callback: string; label: string };
  /** "➕ Add" — omitted by surfaces where photos are simply sent into the chat. */
  add?: { callback: string; label: string };
  /** Verification redo only: "🗑 Delete all and start over", rendered on top. */
  clearAll?: { callback: string; label: string };
}

/**
 * Gap between consecutive card sends. Opening a full 10-photo manager is 10
 * `sendPhoto` calls where the old design was a single `sendMediaGroup`, and an
 * unpaced burst risks a 429 — which would silently cost the user a card while
 * the photo still counts toward the total. Small enough to stay imperceptible
 * (~1s across a full set), large enough to keep the burst civil.
 */
const PHOTO_CARD_SEND_DELAY_MS = 120;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drop one card's message. Telegram only lets a bot delete its own messages
 * for 48 hours, so a manager opened, abandoned, and resumed days later cannot
 * always clean up after itself. In that case the card must at least stop
 * looking live: one `editMessageCaption` both marks it deleted and drops its
 * button (omitting `reply_markup` clears the keyboard).
 */
export async function removePhotoCardMessage(
  api: Api,
  chatId: number,
  msgId: number,
  language: Language,
): Promise<void> {
  try {
    await api.deleteMessage(chatId, msgId);
  } catch {
    await api
      .editMessageCaption(chatId, msgId, {
        caption: t(language, "photoManagerCardRemoved"),
      })
      .catch(() => {});
  }
}

/**
 * Close the manager's live surface: strip the keyboards off every tracked card
 * and off the bottom panel, then stop tracking them.
 *
 * The card messages themselves stay in the chat on purpose — they are the
 * gallery the user just reviewed — but their delete buttons must not survive,
 * because after this the session no longer knows what they point at. Tapping
 * one is already a safe no-op (cards resolve by message id), yet a button that
 * does nothing is its own bug.
 */
export async function retirePhotoCards(
  api: Api,
  chatId: number,
  session: SessionData,
): Promise<void> {
  for (const card of session.photoCards) {
    await api.editMessageReplyMarkup(chatId, card.msgId).catch(() => {});
  }
  session.photoCards = [];
  if (session.photoManagerMsgId != null) {
    await api.editMessageReplyMarkup(chatId, session.photoManagerMsgId).catch(() => {});
    session.photoManagerMsgId = null;
  }
}

/**
 * Reconcile `session.photoCards` against `session.pendingPhotos`: delete the
 * card message for any ref no longer present (a concurrent mobile/Aether edit,
 * or an explicit delete/clear-all that already spliced its own arrays before
 * calling this), and send a fresh card — the photo plus a single delete
 * button — for any ref that doesn't have one yet.
 *
 * Returns true when at least one card was newly SENT, which is the caller's
 * signal that the bottom panel must move below the new cards rather than
 * being edited in place (Telegram has no "move a message").
 */
async function ensurePhotoCards(
  api: Api,
  chatId: number,
  session: SessionData,
  surface: PhotoCardsSurface,
): Promise<boolean> {
  const wanted = new Set(session.pendingPhotos);
  const kept: PhotoManagerCard[] = [];
  for (const card of session.photoCards) {
    if (wanted.has(card.ref)) {
      kept.push(card);
    } else {
      await removePhotoCardMessage(api, chatId, card.msgId, session.language);
    }
  }

  const known = new Set(kept.map((c) => c.ref));
  let addedAny = false;
  for (const ref of session.pendingPhotos) {
    if (known.has(ref)) continue;
    // Pace the burst: a full set is up to 10 sends where the old design used
    // one media group (see PHOTO_CARD_SEND_DELAY_MS).
    if (addedAny) await sleep(PHOTO_CARD_SEND_DELAY_MS);
    try {
      const msg = await api.sendPhoto(chatId, ref, {
        reply_markup: new InlineKeyboard().text(
          surface.deleteLabel,
          surface.deleteCallback,
        ),
      });
      kept.push({ msgId: msg.message_id, ref });
      addedAny = true;
    } catch (err) {
      // Stale file_id, or a rate limit we paced for but still hit. The photo
      // stays counted toward MIN/MAX either way and the next re-render retries
      // its card — but this must not stay silent, because the visible symptom
      // (panel says 10/10, fewer cards on screen) looks like a render bug.
      console.warn("[photo-cards] photo card send failed:", err);
    }
  }

  session.photoCards = kept;
  return addedAny;
}

/**
 * Render (or update) the bottom panel: a photo counter, then in order the
 * surface's clear-all action, ➕ Add (hidden at MAX), and the done action.
 *
 * `forceResend` is set whenever {@link ensurePhotoCards} just sent new cards:
 * since Telegram has no "move a message", the only way to keep the panel
 * BELOW the freshly-arrived cards is to delete the old one and send a new
 * one. Otherwise (a delete, or a re-render with no new cards) the panel is
 * already the newest message in the chat, so it is edited in place — cheaper,
 * and it avoids the panel visibly flickering out and back for a one-line
 * count change.
 */
async function renderPhotoCardsPanel(
  api: Api,
  chatId: number,
  session: SessionData,
  surface: PhotoCardsSurface,
  opts: { forceResend: boolean; lead?: string },
): Promise<void> {
  const { forceResend, lead } = opts;
  const lang = session.language;
  const photos = session.pendingPhotos;

  const keyboard = new InlineKeyboard();
  if (surface.clearAll && photos.length > 0) {
    keyboard.text(surface.clearAll.label, surface.clearAll.callback).row();
  }
  if (surface.add && photos.length < MAX_PHOTOS) {
    keyboard.text(surface.add.label, surface.add.callback).row();
  }
  keyboard.text(surface.done.label, surface.done.callback);

  const counter = t(lang, "photoManagerTitle", {
    count: photos.length,
    min: MIN_PHOTOS,
    max: MAX_PHOTOS,
  });
  const text = lead ? `${lead}\n\n${counter}` : counter;

  if (!forceResend && session.photoManagerMsgId != null) {
    try {
      await api.editMessageText(chatId, session.photoManagerMsgId, text, {
        reply_markup: keyboard,
      });
      return;
    } catch {
      // Either the message is gone, or the text is byte-identical and Telegram
      // rejects the no-op edit (the video path re-renders without changing the
      // count). Both are handled the same way — send a fresh panel below.
    }
  }

  if (session.photoManagerMsgId != null) {
    await api.deleteMessage(chatId, session.photoManagerMsgId).catch(() => {});
  }
  const msg = await api.sendMessage(chatId, text, { reply_markup: keyboard });
  session.photoManagerMsgId = msg?.message_id ?? null;
}

/**
 * Render the card-manager screen: reconcile the per-photo cards, then render
 * the bottom counter/actions panel below them.
 *
 * `lead` prepends a summary line to the panel, which is how a whole upload
 * burst reports itself in ONE message instead of one reply per frame.
 */
export async function renderPhotoCards(
  api: Api,
  chatId: number,
  session: SessionData,
  surface: PhotoCardsSurface,
  opts: { lead?: string } = {},
): Promise<void> {
  const addedAny = await ensurePhotoCards(api, chatId, session, surface);
  await renderPhotoCardsPanel(api, chatId, session, surface, {
    // A `lead` is a burst summary the user has to actually SEE, and by the
    // time it exists the chat already holds their uploads plus any per-frame
    // rejection replies. Editing it into a panel that has scrolled above all
    // of that hides exactly the message that matters most — notably the
    // "nothing was added" case, where no new card forces a resend on its own.
    forceResend: addedAny || opts.lead !== undefined,
    ...(opts.lead !== undefined ? { lead: opts.lead } : {}),
  });
}
