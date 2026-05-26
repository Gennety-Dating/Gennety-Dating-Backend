import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { t, type Language, DEFAULT_SESSION, SUPPORTED_LANGUAGES } from "@gennety/shared";
import { showMainMenu } from "./main.js";
import { sendVerificationCTABare } from "../onboarding/verification.js";
import { buildLanguageKeyboard } from "../language-keyboard.js";

const VALID_LANGUAGES = new Set<Language>(SUPPORTED_LANGUAGES);

/**
 * Verification statuses for which the "Verify now" button should appear in
 * Settings:
 *   - `unverified` → user tapped Skip during onboarding; can recover the
 *     skip Elo penalty by completing Persona now.
 *   - `rejected` → face-match pipeline rejected the photos; user uploaded
 *     replacements and should be able to retry Persona.
 *   - `pending` → user opened the Persona link but never finished (closed
 *     the tab). Shows a "Continue verification" path so they can resume.
 *
 * Hidden for `verified` (already done — button would be confusing) and
 * `pending_review` (admin is manually moderating; user-triggered retries
 * would race the moderation queue).
 */
const VERIFY_BUTTON_STATUSES = new Set(["unverified", "rejected", "pending"]);

/** Shared settings rendering logic. */
async function renderSettings(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { verificationStatus: true },
  });
  const showVerify = user
    ? VERIFY_BUTTON_STATUSES.has(user.verificationStatus)
    : false;

  const keyboard = new InlineKeyboard();
  if (showVerify) {
    keyboard.text(t(lang, "settingsVerify"), "menu:settings:verify").row();
  }
  keyboard
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

/**
 * Re-send the Persona verification CTA from Settings. Reuses the same
 * `sendVerificationCTABare` helper used at the end of onboarding so the
 * Persona URL, copy and Skip-penalty semantics stay in one place.
 *
 * If the user's status has already flipped to `verified` (race against the
 * webhook) or to `pending_review` (admin moderation), we surface a copy
 * line instead of opening a fresh inquiry — a second hosted-flow link
 * would just confuse them.
 */
export async function handleSettingsVerify(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { verificationStatus: true },
  });
  if (!user) return;

  if (!VERIFY_BUTTON_STATUSES.has(user.verificationStatus)) {
    await ctx.reply(t(lang, "settingsVerifyNotNeeded"));
    return;
  }

  const sent = await sendVerificationCTABare(
    ctx.api,
    ctx.chat!.id,
    telegramId,
    lang,
  );
  if (!sent) {
    // Persona disabled or misconfigured (env vars missing). Surface
    // something rather than going silent so the user isn't stranded.
    await ctx.reply(t(lang, "settingsVerifyUnavailable"));
  }
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
  await ctx.reply(t(lang, "settingsLanguagePick"), {
    reply_markup: buildLanguageKeyboard("menu:lang", {
      back: { text: t(lang, "menuBack"), callbackData: "menu:back" },
    }),
  });
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
    menuState: "idle",
    matchFlow: "idle",
    activeMatchId: null,
  });

  await ctx.reply(t(lang, "deleteAccountDone"), { parse_mode: "Markdown" });
}
