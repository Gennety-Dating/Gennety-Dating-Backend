import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma, type Theme } from "@gennety/db";
import { t, type Language, DEFAULT_SESSION, SUPPORTED_LANGUAGES } from "@gennety/shared";
import { showMainMenu } from "./main.js";
import { buildLanguageKeyboard } from "../language-keyboard.js";
import { deleteUserAccount } from "../../services/account-deletion.js";
import { freezeAccount } from "../../services/account-status-transitions.js";
import { setUserLanguage, setUserTheme } from "../../services/user-preferences.js";
import {
  consumePendingAccountAction,
  invalidatePendingAccountAction,
  newAccountActionNonce,
  setPendingAccountAction,
} from "./account-action.js";

const VALID_LANGUAGES = new Set<Language>(SUPPORTED_LANGUAGES);
const VALID_THEMES = new Set<Theme>(["light", "dark"]);

/**
 * Shared settings rendering logic.
 *
 * There is deliberately no "Verify your account" entry here. Verification is
 * mandatory since Registration v2, so it is not a setting: a user who hasn't
 * passed it never reaches this screen (the gate in `services/verification-gate.ts`
 * holds them), and a user who has passed it has nothing to do. The two cases
 * that used to need this button now carry their own affordances — the
 * verification card itself, and the rejection DM.
 */
async function renderSettings(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;

  const keyboard = new InlineKeyboard();
  keyboard
    .text(t(lang, "settingsLanguage"), "menu:settings:lang")
    .row()
    .text(t(lang, "settingsTheme"), "menu:settings:theme")
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
  if (!VALID_LANGUAGES.has(newLang)) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }

  await ctx.answerCallbackQuery();

  ctx.session.language = newLang;
  ctx.session.menuState = "idle";

  await setUserLanguage(BigInt(ctx.from!.id), newLang);

  await ctx.reply(t(newLang, "settingsLanguageSaved"));
  await showMainMenu(ctx);
}

/**
 * Show the light/dark theme picker. Mirrors the language flow: a small inline
 * choice that updates `User.theme` server-side. The picked theme rides the
 * `&theme=` query param the bot appends to every Mini App launch URL (and the
 * server-rendered cards read `User.theme` directly), so the choice propagates
 * everywhere without a separate Mini App.
 */
export async function handleSettingsThemeOpen(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  ctx.session.menuState = "settings_theme";

  const lang = ctx.session.language;
  const keyboard = new InlineKeyboard()
    .text(t(lang, "themeDarkOption"), "menu:theme:dark")
    .text(t(lang, "themeLightOption"), "menu:theme:light")
    .row()
    .text(t(lang, "menuBack"), "menu:back");

  await ctx.reply(t(lang, "settingsThemePick"), { reply_markup: keyboard });
}

/** Persist the new theme choice and return to the main menu. */
export async function handleSettingsThemeSet(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("menu:theme:")) return;

  const newTheme = data.slice("menu:theme:".length) as Theme;
  if (!VALID_THEMES.has(newTheme)) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }

  await ctx.answerCallbackQuery();
  ctx.session.menuState = "idle";

  await setUserTheme(BigInt(ctx.from!.id), newTheme);

  const lang = ctx.session.language;
  await ctx.reply(t(lang, "settingsThemeSaved"));
  await showMainMenu(ctx);
}

/**
 * Step 1 — user tapped "Delete Account".
 *
 * Before doing anything irreversible we offer the softer alternative: text
 * explains why freezing beats deleting, then a two-button fork — a red
 * "delete anyway" and a blue "freeze" (with a snowflake) — so the destructive
 * path is visually distinct from the safe one. No state is touched here; a
 * stray tap is a pure no-op until the user picks a branch.
 */
export async function handleDeleteAccountStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  await invalidatePendingAccountAction(ctx);

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { status: true },
  });
  const nonce = newAccountActionNonce();
  const keyboard = new InlineKeyboard();
  if (user?.status === "active" || user?.status === "paused") {
    keyboard
      .text(t(lang, "deleteFreezeBtn"), `menu:settings:freeze:${nonce}`)
      .primary()
      .row();
  }
  keyboard
    .text(t(lang, "deleteProceedBtn"), `menu:settings:delete:proceed:${nonce}`)
    .danger();

  const message = await ctx.reply(t(lang, "deleteFreezeIntro"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
  setPendingAccountAction(ctx, "freeze_or_delete", nonce, message.message_id);
}

/**
 * Freeze branch — the soft-delete alternative.
 *
 * Keeps the User/Profile/embedding/verification/coordinates intact, cancels any
 * in-flight matches, removes the pinned status banner, and flips the user to
 * `frozen` so they leave the matching pool. On their next /start they are
 * silently reactivated straight into their ready profile (see `handlers/start.ts`).
 */
export async function handleFreezeAccount(ctx: BotContext): Promise<void> {
  if (
    !(await consumePendingAccountAction(
      ctx,
      "freeze_or_delete",
      "menu:settings:freeze:",
    ))
  ) return;
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const result = await freezeAccount({ telegramId }, ctx.api);
  if (result.kind === "forbidden" || result.kind === "not_found") {
    await ctx.reply(t(lang, "statusActionUnavailable"));
    await showMainMenu(ctx);
    return;
  }

  // Drop the fork buttons so the screen can't be re-tapped.
  await ctx.editMessageReplyMarkup().catch(() => {});

  ctx.session.menuState = "idle";
  await ctx.reply(t(lang, "freezeConfirmed"), { parse_mode: "Markdown" });
}

/**
 * Step 2 — user chose to delete anyway. Final confirmation with the destructive
 * option visually isolated: one red "Yes, I'm 100% sure" against two green
 * back-out buttons, so an accidental delete takes deliberate effort.
 */
export async function handleDeleteAccountConfirm(ctx: BotContext): Promise<void> {
  if (
    !(await consumePendingAccountAction(
      ctx,
      "freeze_or_delete",
      "menu:settings:delete:proceed:",
    ))
  ) return;
  const lang = ctx.session.language;
  const nonce = newAccountActionNonce();

  const keyboard = new InlineKeyboard()
    .text(t(lang, "deleteFinalNoSoft"), "menu:back")
    .success()
    .row()
    .text(t(lang, "deleteFinalNoHard"), "menu:back")
    .success()
    .row()
    .text(t(lang, "deleteFinalYes"), `menu:settings:delete:yes:${nonce}`)
    .danger();

  const message = await ctx.reply(t(lang, "deleteAccountConfirm"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
  setPendingAccountAction(ctx, "delete_final", nonce, message.message_id);
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
  if (
    !(await consumePendingAccountAction(
      ctx,
      "delete_final",
      "menu:settings:delete:yes:",
    ))
  ) return;
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const leaving = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!leaving) {
    await showMainMenu(ctx);
    return;
  }

  try {
    const result = await deleteUserAccount(leaving.id, ctx.api);
    if (!result.deleted) {
      await showMainMenu(ctx);
      return;
    }
  } catch (err) {
    console.error("[settings] account deletion failed:", err);
    await ctx.reply(t(lang, "deleteAccountFailed"));
    return;
  }

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
