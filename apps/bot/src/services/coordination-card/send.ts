import { InputFile, type Api, type InlineKeyboard, type RawApi } from "grammy";
import { PROTECT_PARTNER_MEDIA } from "../../demo/config.js";
import { renderCoordinationCard, type CoordCardInput } from "./index.js";

/**
 * Delivery for the coordination cards (PRODUCT_SPEC §Phase 4): ONE message —
 * the rendered PNG, the existing localized copy as its caption, and the flow's
 * own inline keyboard — mirroring how the date card and the venue wish card
 * already ship.
 *
 * Everything here is fail-open by construction. A coordination DM lands about
 * an hour before the date and is the only way the pair can find each other, so
 * it must degrade to the plain text message it decorates rather than fail:
 * a null render, an oversized caption, or a rejected `sendPhoto` all fall
 * through to `sendMessage`, and a failure of that last resort is swallowed and
 * logged exactly like the rest of the flow's DMs.
 */

/** Bot API caps a photo caption at 1024 chars; text messages get 4096. */
const CAPTION_LIMIT = 1024;

export interface SendCoordCardOptions {
  /** The flow's own keyboard, attached to whichever message form is sent. */
  keyboard?: InlineKeyboard;
}

export async function sendCoordCard(
  api: Api<RawApi>,
  telegramId: bigint,
  card: CoordCardInput,
  text: string,
  opts: SendCoordCardOptions = {},
): Promise<void> {
  // Mobile-only accounts carry a synthetic negative id and are not reachable
  // on Telegram at all (the whole coordination flow is Telegram-only in v1).
  if (telegramId <= 0n) return;
  const chatId = Number(telegramId);
  const extra = opts.keyboard ? { reply_markup: opts.keyboard } : undefined;

  const sendText = () =>
    api
      .sendMessage(chatId, text, extra)
      .then(() => undefined)
      .catch((err: unknown) =>
        console.warn(
          `[coordination-card] text fallback failed for ${telegramId}:`,
          err instanceof Error ? err.message : err,
        ),
      );

  // A caption that would be truncated is worse than no card: the copy carries
  // the contact link and the instruction, and the card carries neither.
  if (text.length > CAPTION_LIMIT) {
    await sendText();
    return;
  }

  const png = await renderCoordinationCard(card, api);
  if (!png) {
    await sendText();
    return;
  }

  try {
    await api.sendPhoto(chatId, new InputFile(png, `coord-${card.variant}.png`), {
      caption: text,
      // The `offer` / `ask` / `shared` cards render the OTHER person's face, so
      // this send is bound by the same rule as the match card and the private
      // date card: a partner photo with a clear face never leaves the chat
      // forwardable (PRODUCT_SPEC §3.7a, `legal/privacy-policy.md` §10). Set
      // unconditionally rather than per-variant — `declined` / `proxy` render an
      // emblem instead of a face, but they still name the partner, and a flag
      // that is always on cannot be forgotten when a sixth variant is added.
      // The one exception is demo mode, where the partner is a puppet and the
      // protection only blacks the card out of a screen recording
      // (`PROTECT_PARTNER_MEDIA`, DEMO_MODE.md).
      protect_content: PROTECT_PARTNER_MEDIA,
      ...(extra ?? {}),
    });
  } catch (err) {
    console.warn(
      `[coordination-card] photo send failed for ${telegramId}, falling back to text:`,
      err instanceof Error ? err.message : err,
    );
    await sendText();
  }
}
