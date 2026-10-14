import { type Api } from "grammy";
import { t, type Language } from "@gennety/shared";
import { env } from "../config.js";

/**
 * Welcome-gift pre-roll (PRODUCT_SPEC §3.5b).
 *
 * Delivered once, as a pre-roll before a new user's first-ever match pitch
 * (`handlers/matching/pitch.ts`), after `grantWelcomeGiftIfEligible` actually
 * credits the ticket: the gift **DM** (`welcomeGiftTicket`) carrying the $8.49
 * value anchor + an optional message effect. (The founder video note that used
 * to precede it was retired 2026-10-15 — founder decision.)
 *
 * Best-effort: the ticket is already credited before this runs, so a Bot API
 * hiccup must never strand the user or block the pitch.
 */
export async function sendWelcomeGiftPreroll(
  api: Api,
  chatId: number,
  lang: Language,
): Promise<void> {
  const text = t(lang, "welcomeGiftTicket");
  const effectId = env.MESSAGE_EFFECT_GIFT_ID || undefined;
  try {
    await api.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      ...(effectId ? { message_effect_id: effectId } : {}),
    });
  } catch {
    // Retry once without the effect so an unsupported effect id never loses the
    // gift notification. The ticket is already credited; My Tickets shows it.
    try {
      await api.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch {
      // ignore
    }
  }
}
