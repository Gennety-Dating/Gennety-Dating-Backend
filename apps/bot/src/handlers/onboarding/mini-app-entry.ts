import { InlineKeyboard } from "grammy";
import { prisma, type User } from "@gennety/db";
import type { Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { buildMiniAppUrl } from "../../services/mini-app-url.js";

/**
 * The single entry point into onboarding (PRODUCT_SPEC §1.1).
 *
 * Every user whose onboarding has not been handed off to the chat collector
 * yet lands here, no matter how they touched the bot — `/start`, a stray text
 * message, or a stale inline button from a previous account. Before this the
 * chat carried its own consent card and language picker, which duplicated the
 * Mini App's first two screens and, because the router's step switch had no
 * Mini App gate at all, could be entered by anyone who typed instead of
 * tapping the button — skipping the sign-up fork, the dating city, the theme
 * pick and the AI-memory choice, and dead-ending at the finalize gate that
 * requires a city the chat flow cannot collect.
 *
 * The prompt is self-healing for an account with no `User` row: the Mini App's
 * `GET /v1/telegram-onboarding/state` resolves the caller through
 * `findOrCreateTelegramUser`, so tapping the button creates the row and starts
 * the current flow rather than erroring.
 */

type OnboardingEntryUser = Pick<User, "language" | "theme" | "isEmailVerified">;

const ENTRY_USER_SELECT = {
  language: true,
  theme: true,
  isEmailVerified: true,
} as const;

function onboardingMiniAppUrl(lang: Language, theme: User["theme"]): string {
  return buildMiniAppUrl("onboarding", {
    lang,
    theme,
    query: { source: "telegram", v: Date.now().toString(36) },
  });
}

function onboardingMiniAppCopy(
  lang: Language,
  emailVerified: boolean,
): { message: string; button: string } {
  if (lang === "ru") {
    return {
      button: "Открыть Gennety",
      message: emailVerified
        ? "Почта уже подтверждена. Открой полноэкранный Mini App — он быстро доведёт вход до конца, а потом я продолжу здесь."
        : "Запустим Gennety в полноэкранном Mini App. Там будет короткий вход, а потом я продолжу онбординг прямо здесь.",
    };
  }
  if (lang === "uk") {
    return {
      button: "Відкрити Gennety",
      message: emailVerified
        ? "Пошту вже підтверджено. Відкрий повноекранний Mini App — він швидко завершить вхід, а потім я продовжу тут."
        : "Запустимо Gennety у повноекранному Mini App. Там буде короткий вхід, а потім я продовжу онбординг тут.",
    };
  }
  if (lang === "de") {
    return {
      button: "Gennety öffnen",
      message: emailVerified
        ? "Deine E-Mail ist bereits bestätigt. Öffne die Vollbild-Mini-App, um den Einstieg abzuschließen. Danach mache ich hier weiter."
        : "Öffnen wir Gennety als Vollbild-Mini-App. Dort erledigst du den kurzen Einstieg, danach setze ich das Onboarding hier fort.",
    };
  }
  if (lang === "pl") {
    return {
      button: "Otwórz Gennety",
      message: emailVerified
        ? "Twój e-mail jest już potwierdzony. Otwórz pełnoekranową Mini App, aby dokończyć wejście, a potem będę kontynuować tutaj."
        : "Otwórzmy Gennety w pełnoekranowej Mini App. Tam przejdziesz krótki proces wejścia, a potem będę kontynuować onboarding tutaj.",
    };
  }
  return {
    button: "Open Gennety",
    message: emailVerified
      ? "Your email is already verified. Open the full-screen Mini App to finish the handoff, then I'll continue here."
      : "Let's open Gennety in a full-screen Mini App. It handles the short entry flow, then I'll continue onboarding here.",
  };
}

/** Send the Mini App entry card for a user row the caller already loaded. */
export async function sendOnboardingMiniAppPrompt(
  ctx: BotContext,
  user: OnboardingEntryUser | null,
): Promise<void> {
  const lang = (ctx.session.language ?? user?.language ?? "en") as Language;
  const copy = onboardingMiniAppCopy(lang, Boolean(user?.isEmailVerified));
  const keyboard = new InlineKeyboard().webApp(
    copy.button,
    onboardingMiniAppUrl(lang, user?.theme ?? "dark"),
  );
  await ctx.reply(copy.message, { reply_markup: keyboard });
}

/**
 * Router-side entry: the user tapped or typed something while still on an
 * onboarding step the Mini App owns. Loads the row itself (the router's hot
 * path deliberately selects only the three columns it needs) and falls back to
 * session defaults when there is no row at all.
 */
export async function sendOnboardingEntry(ctx: BotContext): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});

  const telegramId = ctx.from?.id;
  const user = telegramId
    ? await prisma.user.findUnique({
        where: { telegramId: BigInt(telegramId) },
        select: ENTRY_USER_SELECT,
      })
    : null;

  await sendOnboardingMiniAppPrompt(ctx, user);
}
