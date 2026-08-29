import { InlineKeyboard, type Api } from "grammy";
import type { MessageEntity } from "grammy/types";
import type { BotContext } from "../../session.js";
import { prisma, type MatchStatus, type Theme } from "@gennety/db";
import { computeStatusSnapshot, t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { menuToggleStateFor, type MenuToggleState } from "../../services/user-status.js";
import { findActiveMatchForTelegramId } from "../../services/active-match.js";
import { buildMiniAppUrl } from "../../services/mini-app-url.js";
import { citySwitchLabel, isMarketPending } from "./city-switch.js";

/** Minimal descriptor for the conditional "My date" menu row. */
export interface ActiveDateDescriptor {
  status: MatchStatus;
  agreedTime: Date | null;
}

/**
 * Label for the "My date" row. A `scheduled` date shows a live countdown
 * (reusing the status-banner rounding so it matches the pinned banner);
 * earlier stages show a generic "being planned" line.
 */
function buildMyDateLabel(
  lang: Language,
  activeDate: ActiveDateDescriptor,
  now: Date,
): string {
  if (activeDate.status !== "scheduled" || !activeDate.agreedTime) {
    return t(lang, "menuMyDatePlanning");
  }
  const snap = computeStatusSnapshot({ now, nextMatchAt: activeDate.agreedTime });
  switch (snap.phase) {
    case "days":
      return t(lang, "menuMyDateDays", { d: snap.days ?? 0, h: snap.hours ?? 0 });
    case "hours":
      return t(lang, "menuMyDateHours", { h: snap.hours ?? 0, m: snap.minutes ?? 0 });
    case "minutes":
      return t(lang, "menuMyDateMinutes", { m: snap.minutes ?? 0 });
    default:
      // `processing` = agreed time is now/just-passed; the date is imminent.
      return t(lang, "menuMyDateSoon");
  }
}

/** Build the main menu inline keyboard. Pause/Resume label depends on current user status. */
export function buildMainMenuKeyboard(
  ctx: BotContext,
  status: MenuToggleState,
  videoReward = false,
  theme: Theme = "dark",
): InlineKeyboard {
  return buildMainMenuKeyboardFor(ctx.session.language, status, videoReward, theme);
}

function buildMainMenuKeyboardFor(
  lang: Language,
  status: MenuToggleState,
  videoReward: boolean,
  theme: Theme,
  activeDate: ActiveDateDescriptor | null = null,
  now: Date = new Date(),
  marketPending = false,
): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Conditional row for an account registered in a city we haven't launched:
  // matching is same-city, so nothing else in this menu can work for them until
  // they move to a launched market (PRODUCT_SPEC §1.1). It leads because it is
  // the only thing standing between them and a match; such a user cannot have a
  // live match, so it never competes with the "My date" anchor below.
  if (marketPending) {
    kb.text(citySwitchLabel(lang), "menu:city").primary().row();
  }

  // Conditional first row: a primary-styled "My date" entry, shown ONLY while
  // the user has a live match. The native `primary` style + optional animated
  // icon make it the visual anchor of the menu (grammY 1.42 builder methods —
  // no raw-markup cast needed). Opens the date hub (`menu:date`).
  if (activeDate) {
    kb.text(buildMyDateLabel(lang, activeDate, now), "menu:date").primary();
    if (env.CUSTOM_EMOJI_DATE_ID) kb.icon(env.CUSTOM_EMOJI_DATE_ID);
    kb.row();
  }

  // My Profile is now a single combined view+edit screen (the old separate
  // "Edit Profile" button was merged in — `menu:edit` still routes there for
  // any stale keyboards).
  kb.text(t(lang, "menuMyProfile"), "menu:profile").row();

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

  // Ticket wallet entry — only when the Date Ticket feature is live. Kept as
  // a message (not a direct web_app row) on purpose: the balance shown there
  // is the whole reason someone taps it, and founder preference is to keep
  // that number visible before the Mini App opens.
  if (env.TICKET_FEATURE_ENABLED) {
    kb.text(t(lang, "menuMyTickets"), "menu:tickets").row();
  }

  // Gennety Premium entry — only when the Premium feature is live. Opens the
  // Mini App directly: `premium.html` already renders the "active until" /
  // benefits state itself from its own GET /v1/premium/state call, so the
  // hub message this used to send only repeated what the Mini App shows one
  // tap later. Falls back to the callback-driven hub (still handled in
  // router.ts) when WEBAPP_URL isn't a real HTTPS host — Telegram rejects a
  // non-HTTPS web_app button outright — and that same callback is also how
  // the concierge agent's `open_screen("premium")` tool hands the screen over
  // via text/voice (a bot reply can only contain a button, never open a
  // WebView on its own).
  if (env.PREMIUM_FEATURE_ENABLED) {
    const premiumUrl = buildMiniAppUrl("premium", { lang, theme });
    if (premiumUrl.startsWith("https://")) {
      kb.webApp(t(lang, "menuPremium"), premiumUrl).row();
    } else {
      kb.text(t(lang, "menuPremium"), "menu:premium").row();
    }
  }

  // Referral entry ("Give a date, get a date") — only when the feature is
  // live. Same reasoning as Premium: `referral.html` renders the ladder +
  // share button itself, so the row opens it directly instead of through a
  // title/tagline message. Same HTTPS fallback and the same open_screen
  // caveat apply (referral isn't in SCREEN_ENTRIES today, but the callback
  // stays live as the dev fallback and for any future caller).
  if (env.REFERRAL_FEATURE_ENABLED) {
    const referralUrl = buildMiniAppUrl("referral", { lang, theme });
    if (referralUrl.startsWith("https://")) {
      kb.webApp(t(lang, "menuInviteFriend"), referralUrl).row();
    } else {
      kb.text(t(lang, "menuInviteFriend"), "menu:referral").row();
    }
  }

  return kb.text(t(lang, "menuHelp"), "menu:help");
}

/** Render the persistent main menu for a completed user. */
export async function showMainMenu(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      status: true,
      theme: true,
      profile: { select: { videoBonusTicketAt: true, homeCityKey: true } },
    },
  });
  const status = menuToggleStateFor(user?.status);
  const videoReward = videoRewardAvailable(user?.profile?.videoBonusTicketAt ?? null);
  const activeDate = await loadActiveDate(telegramId);
  const marketPending = isMarketPending(user?.profile?.homeCityKey);

  const { text, options } = buildMainMenuPayload(
    lang,
    status,
    videoReward,
    user?.theme ?? "dark",
    activeDate,
    marketPending,
  );
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
    select: {
      status: true,
      theme: true,
      profile: { select: { videoBonusTicketAt: true, homeCityKey: true } },
    },
  });
  const status = menuToggleStateFor(user?.status);
  const videoReward = videoRewardAvailable(user?.profile?.videoBonusTicketAt ?? null);
  const activeDate = await loadActiveDate(telegramId);
  const marketPending = isMarketPending(user?.profile?.homeCityKey);

  const { text, options } = buildMainMenuPayload(
    lang,
    status,
    videoReward,
    user?.theme ?? "dark",
    activeDate,
    marketPending,
  );
  await api.sendMessage(chatId, text, options);
}

/** True when a profile video earns a free Date Ticket (feature on, not yet claimed). */
function videoRewardAvailable(videoBonusTicketAt: Date | null): boolean {
  return env.TICKET_FEATURE_ENABLED && !videoBonusTicketAt;
}

/**
 * Resolve the caller's live match into the minimal descriptor the menu row
 * needs (one extra query per menu render — same order of magnitude as the
 * existing user lookup). `null` when there is no in-flight match.
 */
async function loadActiveDate(telegramId: bigint): Promise<ActiveDateDescriptor | null> {
  const active = await findActiveMatchForTelegramId(telegramId);
  if (!active) return null;
  return { status: active.match.status, agreedTime: active.match.agreedTime };
}

function buildMainMenuPayload(
  lang: Language,
  status: MenuToggleState,
  videoReward: boolean,
  theme: Theme,
  activeDate: ActiveDateDescriptor | null = null,
  marketPending = false,
): { text: string; options: Record<string, unknown> } {
  const menuEmojiId = env.CUSTOM_EMOJI_MENU_ID;
  const keyboard = buildMainMenuKeyboardFor(
    lang,
    status,
    videoReward,
    theme,
    activeDate,
    new Date(),
    marketPending,
  );

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
        reply_markup: keyboard,
      },
    };
  }

  return {
    text: t(lang, "menuTitle"),
    options: {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    },
  };
}
