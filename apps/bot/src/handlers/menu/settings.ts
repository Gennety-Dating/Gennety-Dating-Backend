import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { t, type Language, DEFAULT_SESSION } from "@gennety/shared";
import { showMainMenu } from "./main.js";

const VALID_LANGUAGES = new Set<Language>(["en", "ru", "uk"]);

/** Shared settings rendering logic. */
async function renderSettings(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;

  const keyboard = new InlineKeyboard()
    .text(t(lang, "settingsLanguage"), "menu:settings:lang")
    .row()
    .text(t(lang, "settingsDeleteAccount"), "menu:settings:delete")
    .row()
    .text(t(lang, "menuBack"), "menu:back");

  await ctx.reply(t(lang, "settingsTitle"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

/** Show the Settings sub-menu (callback entry). */
export async function handleSettingsOpen(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  await renderSettings(ctx);
}

/** Show the Settings sub-menu (command entry — via /settings). */
export async function showSettingsMenu(ctx: BotContext): Promise<void> {
  await renderSettings(ctx);
}

/** Show the language picker. Mirrors the onboarding language keyboard. */
export async function handleSettingsLanguageOpen(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  ctx.session.menuState = "settings_lang";

  const lang = ctx.session.language;
  const keyboard = new InlineKeyboard()
    .text("English", "menu:lang:en")
    .text("Русский", "menu:lang:ru")
    .text("Українська", "menu:lang:uk")
    .row()
    .text(t(lang, "menuBack"), "menu:back");

  await ctx.reply(t(lang, "settingsLanguagePick"), { reply_markup: keyboard });
}

/** Persist the new language choice and return to the main menu. */
export async function handleSettingsLanguageSet(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("menu:lang:")) return;

  const newLang = data.slice("menu:lang:".length) as Language;
  if (!VALID_LANGUAGES.has(newLang)) return;

  await ctx.answerCallbackQuery();

  ctx.session.language = newLang;
  ctx.session.menuState = "idle";

  await prisma.user.update({
    where: { telegramId: BigInt(ctx.from!.id) },
    data: { language: newLang },
  });

  await ctx.reply(t(newLang, "settingsLanguageSaved"));
  await showMainMenu(ctx);
}

/** Show GDPR account deletion confirmation prompt. */
export async function handleDeleteAccountConfirm(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;

  const keyboard = new InlineKeyboard()
    .text(t(lang, "deleteAccountYes"), "menu:settings:delete:yes")
    .row()
    .text(t(lang, "deleteAccountNo"), "menu:back");

  await ctx.reply(t(lang, "deleteAccountConfirm"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

/**
 * GDPR "Right to be Forgotten" handler.
 *
 * Deletes the User row — Prisma cascading deletes automatically remove:
 *   - Profile (including pgvector embedding)
 *   - All Match rows where this user is userA or userB
 *
 * Then resets the grammY session to defaults so no stale data lingers in memory.
 */
export async function handleDeleteAccountExecute(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  await prisma.user.delete({ where: { telegramId } });

  // Reset the in-memory session to defaults — no user data survives.
  Object.assign(ctx.session, {
    ...DEFAULT_SESSION,
    pendingPhotos: [],
    visualVotes: [],
    menuState: "idle",
    matchFlow: "idle",
    activeMatchId: null,
  });

  await ctx.reply(t(lang, "deleteAccountDone"), { parse_mode: "Markdown" });
}
