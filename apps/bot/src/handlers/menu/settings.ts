import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma, type Theme } from "@gennety/db";
import { t, type Language, DEFAULT_SESSION, SUPPORTED_LANGUAGES } from "@gennety/shared";
import { showMainMenu } from "./main.js";
import { sendVerificationCTABare } from "../onboarding/verification.js";
import { buildLanguageKeyboard } from "../language-keyboard.js";
import { sendDeleteFreezeVideoNote } from "../../services/delete-freeze-video.js";
import { unpinStatusBanner } from "../../services/status-banner.js";
import { applyEmergencyCancellationPeerBoost } from "../../utils/elo-calculator.js";

/**
 * Match statuses that are "in flight" — a live proposal, a scheduling handshake,
 * or a booked date. Freezing (or deleting) a participant must cancel these so a
 * partner is never left waiting on someone who has left.
 */
const IN_FLIGHT_MATCH_STATUSES = [
  "proposed",
  "negotiating",
  "negotiating_venue",
  "scheduled",
] as const;

const VALID_LANGUAGES = new Set<Language>(SUPPORTED_LANGUAGES);
const VALID_THEMES = new Set<Theme>(["light", "dark"]);

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
  if (!VALID_THEMES.has(newTheme)) return;

  await ctx.answerCallbackQuery();
  ctx.session.menuState = "idle";

  await prisma.user.update({
    where: { telegramId: BigInt(ctx.from!.id) },
    data: { theme: newTheme, themeChosenAt: new Date() },
  });

  const lang = ctx.session.language;
  await ctx.reply(t(lang, "settingsThemeSaved"));
  await showMainMenu(ctx);
}

/**
 * Step 1 — user tapped "Delete Account".
 *
 * Before doing anything irreversible we offer the softer alternative: a founder
 * video note (кружок) explains why freezing beats deleting, then a two-button
 * fork — a red "delete anyway" and a blue "freeze" (with a snowflake) — so the
 * destructive path is visually distinct from the safe one. No state is touched
 * here; a stray tap is a pure no-op until the user picks a branch.
 */
export async function handleDeleteAccountStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;

  // Best-effort founder кружок — skipped gracefully when no asset exists for
  // this language; the fork below is always sent regardless.
  if (ctx.chat) {
    await sendDeleteFreezeVideoNote(ctx.api, ctx.chat.id, lang);
  }

  const keyboard = new InlineKeyboard()
    .text(t(lang, "deleteFreezeBtn"), "menu:settings:freeze")
    .primary()
    .row()
    .text(t(lang, "deleteProceedBtn"), "menu:settings:delete:proceed")
    .danger();

  await ctx.reply(t(lang, "deleteFreezeIntro"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

/**
 * Cancel every in-flight match a leaving user is part of, so no partner is
 * stranded. Each cancelled partner gets a neutral notice (the blind-decision
 * invariant doesn't apply — there's nothing to reveal) plus the same small
 * priority/Elo comp used for emergency cancellations. Best-effort throughout;
 * one failed DM must never block the freeze.
 */
async function cancelInFlightMatchesForLeavingUser(
  ctx: BotContext,
  userId: string,
): Promise<void> {
  const matches = await prisma.match.findMany({
    where: {
      status: { in: [...IN_FLIGHT_MATCH_STATUSES] },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    select: {
      id: true,
      userAId: true,
      userBId: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });

  for (const match of matches) {
    try {
      await prisma.match.update({
        where: { id: match.id },
        data: { status: "cancelled" },
      });
    } catch (err) {
      console.warn("[freeze] match cancel failed:", err);
      continue;
    }

    const isA = match.userAId === userId;
    const partnerId = isA ? match.userBId : match.userAId;
    const partner = isA ? match.userB : match.userA;

    await applyEmergencyCancellationPeerBoost(partnerId);

    if (partner.telegramId > 0n) {
      const partnerLang = (partner.language ?? "en") as Language;
      await ctx.api
        .sendMessage(Number(partner.telegramId), t(partnerLang, "freezePartnerNotice"))
        .catch((err: unknown) => {
          console.warn("[freeze] partner notice failed:", err);
        });
    }
  }
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
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) {
    await showMainMenu(ctx);
    return;
  }

  await cancelInFlightMatchesForLeavingUser(ctx, user.id);

  await prisma.user.update({
    where: { telegramId },
    data: { status: "frozen" },
  });

  await unpinStatusBanner(ctx.api, telegramId);

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
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;

  const keyboard = new InlineKeyboard()
    .text(t(lang, "deleteFinalNoSoft"), "menu:back")
    .success()
    .row()
    .text(t(lang, "deleteFinalNoHard"), "menu:back")
    .success()
    .row()
    .text(t(lang, "deleteFinalYes"), "menu:settings:delete:yes")
    .danger();

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

  // Notify + comp any partner in an in-flight match before the cascade wipes the
  // match rows, so a hard delete doesn't silently strand them either.
  const leaving = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (leaving) {
    await cancelInFlightMatchesForLeavingUser(ctx, leaving.id);
  }

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
