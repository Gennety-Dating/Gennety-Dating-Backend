import { InlineKeyboard, type Api } from "grammy";
import type { MessageEntity } from "grammy/types";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { menuToggleStateFor, type MenuToggleState } from "../../services/user-status.js";

/** Build the main menu inline keyboard. Pause/Resume label depends on current user status. */
export function buildMainMenuKeyboard(
  ctx: BotContext,
  status: MenuToggleState,
  videoReward = false,
): InlineKeyboard {
  return buildMainMenuKeyboardFor(ctx.session.language, status, videoReward);
}

function buildMainMenuKeyboardFor(
  lang: Language,
  status: MenuToggleState,
  videoReward: boolean,
): InlineKeyboard {
  // My Profile is now a single combined view+edit screen (the old separate
  // "Edit Profile" button was merged in — `menu:edit` still routes there for
  // any stale keyboards).
  const kb = new InlineKeyboard()
    .text(t(lang, "menuMyProfile"), "menu:profile")
    .row();

  if (status !== "locked") {
    const pauseLabel = status === "paused" ? t(lang, "menuResume") : t(lang, "menuPause");
    const pauseAction = status === "paused" ? "menu:resume" : "menu:pause";
    kb.text(pauseLabel, pauseAction);
  }

  kb.text(t(lang, "menuSettings"), "menu:settings").row();

  // First of the single-button rows: always-visible profile-video entry; a 🎁
  // marker signals an unclaimed free Date Ticket (when tickets are live and the
  // bonus hasn't been earned yet).
  const videoLabel = t(lang, "menuVideo") + (videoReward ? " 🎁" : "");
  kb.text(videoLabel, "menu:video").row();

  // Ticket wallet entry — only when the Date Ticket feature is live.
  if (env.TICKET_FEATURE_ENABLED) {
    kb.text(t(lang, "menuMyTickets"), "menu:tickets").row();
  }

  return kb.text(t(lang, "menuHelp"), "menu:help");
}

/** Render the persistent main menu for a completed user. */
export async function showMainMenu(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { status: true, profile: { select: { videoBonusTicketAt: true } } },
  });
  const status = menuToggleStateFor(user?.status);
  const videoReward = videoRewardAvailable(user?.profile?.videoBonusTicketAt ?? null);

  const { text, options } = buildMainMenuPayload(lang, status, videoReward);
  await ctx.reply(text, options);
}

/**
 * Ctx-free variant of {@link showMainMenu}. Used by background flows
 * (e.g. debounced album flush) that don't have a live ctx.
 */
export async function sendMainMenu(
  api: Api,
  chatId: number,
  lang: Language,
  telegramId: bigint,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { status: true, profile: { select: { videoBonusTicketAt: true } } },
  });
  const status = menuToggleStateFor(user?.status);
  const videoReward = videoRewardAvailable(user?.profile?.videoBonusTicketAt ?? null);

  const { text, options } = buildMainMenuPayload(lang, status, videoReward);
  await api.sendMessage(chatId, text, options);
}

/** True when a profile video earns a free Date Ticket (feature on, not yet claimed). */
function videoRewardAvailable(videoBonusTicketAt: Date | null): boolean {
  return env.TICKET_FEATURE_ENABLED && !videoBonusTicketAt;
}

function buildMainMenuPayload(
  lang: Language,
  status: MenuToggleState,
  videoReward: boolean,
): { text: string; options: Record<string, unknown> } {
  const menuEmojiId = env.CUSTOM_EMOJI_MENU_ID;

  if (menuEmojiId) {
    // When custom emoji is configured we must use explicit entities because
    // parse_mode doesn't support custom_emoji. Strip Markdown `*` markers
    // and build both custom_emoji + bold entities manually.
    const raw = t(lang, "menuTitle");
    const plainText = raw.replace(/\*/g, "");

    // 🎓 is a surrogate pair (length 2 in UTF-16) at offset 0.
    const entities: MessageEntity[] = [
      { type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: menuEmojiId },
    ];

    const boldMatch = raw.match(/\*(.+?)\*/);
    if (boldMatch) {
      const boldStart = raw.indexOf("*");
      const offsetInPlain = boldStart - 1;
      entities.push({ type: "bold", offset: offsetInPlain, length: boldMatch[1]!.length });
    }

    return {
      text: plainText,
      options: {
        entities,
        reply_markup: buildMainMenuKeyboardFor(lang, status, videoReward),
      },
    };
  }

  return {
    text: t(lang, "menuTitle"),
    options: {
      parse_mode: "Markdown",
      reply_markup: buildMainMenuKeyboardFor(lang, status, videoReward),
    },
  };
}
