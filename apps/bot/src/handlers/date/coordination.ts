import { prisma } from "@gennety/db";
import { t, PROXY_MAX_MESSAGE_LEN } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { buildChatControlsKeyboard } from "../../services/coordination.js";
import {
  proxyChatSendRefusal,
  relayProxyMessage,
  type ProxyChatRefusal,
} from "../../services/proxy-chat.js";

/**
 * Pre-date coordination handlers (PRODUCT_SPEC.md §Phase 4, feature-flagged).
 *
 * Routed inside `dateRouter` (runs before the menu LLM router, gates on
 * completed onboarding). Callback families:
 *   - `coord:enter:{matchId}` — join the anonymous proxy chat
 *   - `coord:exit` — leave the proxy chat
 *   - `coord:m:*`, `coord:approve:*`, `coord:decline:*` — buttons of the retired
 *     T-3h questionnaire; acknowledged and stripped, nothing else (see
 *     `handleRetiredCoordCard`)
 * Plus the free-text relay leg for users in the `coordination_chat` session
 * state. Whether that chat is open, what gets logged and how the partner is
 * reached all belong to `services/proxy-chat.ts`, shared with the app; this
 * file keeps only Telegram's idiom of entering and leaving a chat session.
 */

async function callerUserId(ctx: BotContext): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  return user?.id ?? null;
}

/**
 * Take a refused user out of the chat state and say why — one exit for the
 * Enter button and the relay, so a refusal reads the same from either.
 *
 * The session is reset only when it IS the chat: a stale Enter button tapped
 * mid-way through some other flow must not knock that flow over.
 *
 * A date that is no longer `scheduled` gets its own line rather than the
 * window-close one. "Hope the date went well" is the wrong thing to tell
 * someone whose date was just cancelled, and the line has to stay neutral
 * enough that it never tells a blocked person they were blocked.
 */
async function refuseProxyChat(ctx: BotContext, refusal: ProxyChatRefusal): Promise<void> {
  if (ctx.session.matchFlow === "coordination_chat") {
    ctx.session.matchFlow = "idle";
    ctx.session.activeMatchId = null;
  }
  // A stranger's tap, or a match that no longer exists, is answered with
  // nothing — as it always was.
  if (refusal === "not-found" || refusal === "forbidden") return;
  const key = refusal === "closed" ? "coordProxyClosed" : "coordProxyUnavailable";
  await ctx.reply(t(ctx.session.language, key));
}

/**
 * `coord:m:*` / `coord:approve:*` / `coord:decline:*` — a button on a card of
 * the retired T-3h questionnaire (founder decision 2026-09-26: no handle
 * exchange, no choice — every scheduled date gets the anonymous chat at T-1h).
 *
 * Cards sent before the change are still sitting in people's chats, and a tap
 * on one must neither spin forever nor do what it used to: nothing is written
 * and no handle is revealed. The tap is answered and the dead keyboard taken
 * off the card, so the question stops looking open.
 */
export async function handleRetiredCoordCard(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (
    !data?.startsWith("coord:m:") &&
    !data?.startsWith("coord:approve:") &&
    !data?.startsWith("coord:decline:")
  ) {
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => {});
}

/** `coord:enter:{matchId}` — join the anonymous proxy chat. */
export async function handleCoordEnter(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("coord:enter:")) return;
  await ctx.answerCallbackQuery();

  const matchId = data.slice("coord:enter:".length);
  if (!matchId) return;

  const callerId = await callerUserId(ctx);
  if (!callerId) return;

  // The gate the relay itself will ask, so the button cannot let someone into
  // a chat whose first message would be refused — nor into a cancelled or
  // blocked date's chat, which the window alone used to allow.
  const refusal = await proxyChatSendRefusal({ matchId, userId: callerId });
  if (refusal) {
    await refuseProxyChat(ctx, refusal);
    return;
  }

  const lang = ctx.session.language;
  ctx.session.matchFlow = "coordination_chat";
  ctx.session.activeMatchId = matchId;
  await ctx.reply(t(lang, "coordChatEntered"), {
    reply_markup: buildChatControlsKeyboard(matchId, lang),
  });
}

/** `coord:exit` — leave the anonymous proxy chat. */
export async function handleCoordExit(ctx: BotContext): Promise<void> {
  if (ctx.callbackQuery?.data !== "coord:exit") return;
  await ctx.answerCallbackQuery();
  ctx.session.matchFlow = "idle";
  ctx.session.activeMatchId = null;
  await ctx.reply(t(ctx.session.language, "coordChatExited"));
}

/**
 * Free-text relay leg: forward a `coordination_chat` user's message to their
 * match. Text-only — media is rejected to close the face/metadata-leak bypass.
 *
 * The gate, the log and the delivery are `relayProxyMessage`'s, the same call
 * the app's `POST /v1/matches/{id}/chat` makes. This leg used to carry its own
 * copy of all three, and each copy had drifted: its gate looked only at the
 * window, so a date cancelled, frozen or blocked inside the last hour kept
 * relaying; its delivery DM'd whatever carried a positive Telegram id, so an
 * app-only partner got a 403 instead of the push the app path sends; and its
 * rows never earned a delivery stamp.
 *
 * Re-asked per message, which is what lets a stale session self-heal: the
 * close tick cannot reset another user's session.
 */
export async function handleProxyRelay(ctx: BotContext): Promise<void> {
  const matchId = ctx.session.activeMatchId;

  if (!matchId) {
    ctx.session.matchFlow = "idle";
    return;
  }

  const callerId = await callerUserId(ctx);
  if (!callerId) {
    ctx.session.matchFlow = "idle";
    ctx.session.activeMatchId = null;
    return;
  }

  const message = ctx.message;
  const body = message?.text;
  if (!message || !body) {
    // Nothing to relay, but the chat is still asked whether it is open: a photo
    // sent into a closed or cancelled chat must end the session just as text
    // would, rather than earn a "text only" hint for a chat that is gone.
    const refusal = await proxyChatSendRefusal({ matchId, userId: callerId });
    if (refusal) {
      await refuseProxyChat(ctx, refusal);
      return;
    }
    await ctx.reply(t(ctx.session.language, "coordProxyTextOnly"));
    return;
  }

  const relayed = await relayProxyMessage({
    matchId,
    senderUserId: callerId,
    // Clamped, as this rail always has, rather than refused like the app's
    // composer: Telegram shows the writer no counter to keep under.
    body: body.slice(0, PROXY_MAX_MESSAGE_LEN),
    // This line AS ITS AUTHOR SEES IT, in their own chat with the bot — where a
    // partner's reaction has to land (see `relayProxyMessage`).
    authorChatMessageId: BigInt(message.message_id),
  });
  if (relayed.ok) return;

  // Whitespace only (the clamp rules out too-long): nothing to pass on, and
  // nothing wrong with the chat, so the session stays where it is.
  if (relayed.error === "empty" || relayed.error === "too-long") return;
  await refuseProxyChat(ctx, relayed.error);
}
