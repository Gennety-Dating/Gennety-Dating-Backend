import type { Api } from "grammy";
import { t, type Language } from "@gennety/shared";
import { env } from "../config.js";

/**
 * DM the user a celebratory "you earned a free Date Ticket" message after a
 * one-time onboarding bonus (4+ photos or adding a profile video). The copy
 * explains the mechanic (each date costs 1 ticket; tickets normally cost money)
 * and shows the new balance. When `MESSAGE_EFFECT_TICKET_ID` is configured the
 * message plays a Bot API 7.6 effect so the reward reads as a moment, not a
 * tech ping. Cosmetic only — never gates the flow; failures are swallowed.
 */
export async function sendTicketRewardDM(
  api: Api,
  chatId: number,
  lang: Language,
  kind: "photo" | "video",
  balance: number,
): Promise<void> {
  const text = t(
    lang,
    kind === "photo" ? "ticketRewardPhoto" : "ticketRewardVideo",
    { balance },
  );
  const effectId = env.MESSAGE_EFFECT_TICKET_ID;
  try {
    await api.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      ...(effectId ? { message_effect_id: effectId } : {}),
    });
  } catch {
    // Best-effort: retry once without Markdown/effect so a malformed entity
    // or an unsupported effect id never loses the reward notification.
    try {
      await api.sendMessage(chatId, text.replace(/[*_`[\]]/g, ""));
    } catch {
      // ignore — the balance is already credited; the menu shows it.
    }
  }
}
