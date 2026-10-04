import { InlineKeyboard } from "grammy";
import { prisma, type User } from "@gennety/db";
import type { Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { buildMiniAppUrl } from "../../services/mini-app-url.js";



type OnboardingEntryUser = Pick<User, "language" | "theme" | "isEmailVerified"> & {
  /** Non-null while the user is waiting for their city to open. */
  cityWaitlistEntry?: { city: string } | null;
};

const ENTRY_USER_SELECT = {
  language: true,
  theme: true,
  isEmailVerified: true,
  cityWaitlistEntry: { select: { city: true } },
} as const;

function onboardingMiniAppUrl(lang: Language, theme: User["theme"]): string {
  return buildMiniAppUrl("onboarding", {
    lang,
    theme,
    query: { source: "telegram", v: Date.now().toString(36) },
  });
}

/**
 * The card a user on the city waitlist gets instead of "let's finish the entry
 * flow" — which for them is not true. Registration is over until we open their
 * city; the button re-opens the Mini App on the waitlist screen, which is also
 * where they can pick a different city.
 */
function waitlistMiniAppCopy(
  lang: Language,
  city: string,
): { message: string; button: string } {
  switch (lang) {
    case "ru":
      return {
        button: "Открыть Gennety",
        message:
          `Ты в списке ожидания: в городе ${city} Gennety пока не работает. ` +
          "Напишем первым, как только откроемся там. Если хочешь ходить на свидания в другом городе — открой Gennety и выбери его.",
      };
    case "uk":
      return {
        button: "Відкрити Gennety",
        message:
          `Ти в списку очікування: у місті ${city} Gennety поки не працює. ` +
          "Напишемо першим, щойно відкриємось там. Якщо хочеш ходити на побачення в іншому місті — відкрий Gennety і обери його.",
      };
    case "de":
      return {
        button: "Gennety öffnen",
        message:
          `Du stehst auf der Warteliste: In ${city} ist Gennety noch nicht am Start. ` +
          "Wir melden uns bei dir zuerst, sobald wir dort öffnen. Wenn du in einer anderen Stadt auf Dates gehen möchtest, öffne Gennety und wähle sie aus.",
      };
    case "pl":
      return {
        button: "Otwórz Gennety",
        message:
          `Jesteś na liście oczekujących: w mieście ${city} Gennety jeszcze nie działa. ` +
          "Napiszemy do Ciebie jako do pierwszej osoby, gdy tylko tam ruszymy. Jeśli chcesz chodzić na randki w innym mieście — otwórz Gennety i wybierz je.",
      };
    default:
      return {
        button: "Open Gennety",
        message:
          `You're on the waitlist: Gennety isn't live in ${city} yet. ` +
          "We'll write to you first the moment we open there. If you're ready to date in another city, open Gennety and pick one.",
      };
  }
}

function onboardingMiniAppCopy(
  lang: Language,
  emailVerified: boolean,
): { message: string; button: string } {
  if (lang === "ru") {
    return {
      button: "Открыть Gennety",
      message: emailVerified
        ? "Почта уже подтверждена. Открой Gennety — там быстро закончим вход, потом вернёмся сюда."
        : "Открой Gennety — там быстрый вход, потом вернёмся сюда.",
    };
  }
  if (lang === "uk") {
    return {
      button: "Відкрити Gennety",
      message: emailVerified
        ? "Пошту вже підтверджено. Відкрий Gennety — там швидко завершимо вхід, потім повернемося сюди."
        : "Відкрий Gennety — там швидкий вхід, потім повернемося сюди.",
    };
  }
  if (lang === "de") {
    return {
      button: "Gennety öffnen",
      message: emailVerified
        ? "Deine E-Mail ist schon bestätigt. Öffne Gennety — dort schließen wir den Einstieg schnell ab, dann geht es hier weiter."
        : "Öffne Gennety — dort geht der Einstieg schnell, dann geht es hier weiter.",
    };
  }
  if (lang === "pl") {
    return {
      button: "Otwórz Gennety",
      message: emailVerified
        ? "Twój e-mail jest już potwierdzony. Otwórz Gennety — tam szybko dokończymy wejście, potem wrócimy tutaj."
        : "Otwórz Gennety — tam szybkie wejście, potem wrócimy tutaj.",
    };
  }
  return {
    button: "Open Gennety",
    message: emailVerified
      ? "Your email is already verified. Open Gennety to finish signing in quickly, then we'll come back here."
      : "Open Gennety — a quick sign-in there, then we'll come back here.",
  };
}

/** Send the Mini App entry card for a user row the caller already loaded. */
export async function sendOnboardingMiniAppPrompt(
  ctx: BotContext,
  user: OnboardingEntryUser | null,
): Promise<void> {
  const lang = (ctx.session.language ?? user?.language ?? "en") as Language;
  const waitlistCity = user?.cityWaitlistEntry?.city ?? null;
  const copy = waitlistCity
    ? waitlistMiniAppCopy(lang, waitlistCity)
    : onboardingMiniAppCopy(lang, Boolean(user?.isEmailVerified));
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
