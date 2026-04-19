import { InlineKeyboard, type Api } from "grammy";
import type { MessageEntity } from "grammy/types";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../../config.js";

/** Build the main menu inline keyboard. Pause/Resume label depends on current user status. */
export function buildMainMenuKeyboard(
  ctx: BotContext,
  status: "active" | "paused",
): InlineKeyboard {
  return buildMainMenuKeyboardFor(ctx.session.language, status);
}

function buildMainMenuKeyboardFor(
  lang: Language,
  status: "active" | "paused",
): InlineKeyboard {
  const pauseLabel = status === "paused" ? t(lang, "menuResume") : t(lang, "menuPause");
  const pauseAction = status === "paused" ? "menu:resume" : "menu:pause";

  return new InlineKeyboard()
    .text(t(lang, "menuMyProfile"), "menu:profile")
    .text(t(lang, "menuEdit"), "menu:edit")
    .row()
    .text(pauseLabel, pauseAction)
    .text(t(lang, "menuSettings"), "menu:settings")
    .row()
    .text(t(lang, "menuHelp"), "menu:help");
}

/** Render the persistent main menu for a completed user. */
export async function showMainMenu(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { status: true },
  });
  const status = (user?.status ?? "active") as "active" | "paused";

  const { text, options } = buildMainMenuPayload(lang, status);
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
    select: { status: true },
  });
  const status = (user?.status ?? "active") as "active" | "paused";

  const { text, options } = buildMainMenuPayload(lang, status);
  await api.sendMessage(chatId, text, options);
}

function buildMainMenuPayload(
  lang: Language,
  status: "active" | "paused",
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
        reply_markup: buildMainMenuKeyboardFor(lang, status),
      },
    };
  }

  return {
    text: t(lang, "menuTitle"),
    options: {
      parse_mode: "Markdown",
      reply_markup: buildMainMenuKeyboardFor(lang, status),
    },
  };
}
