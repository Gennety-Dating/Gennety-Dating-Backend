import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../session.js";
import { prisma, type User } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { t } from "@gennety/shared";
import { env } from "../config.js";
import { showMainMenu } from "./menu/main.js";
import { showEditProfileMenu } from "./menu/edit-profile.js";
import { showMyProfile } from "./menu/my-profile.js";
import { showSettingsMenu } from "./menu/settings.js";
import { sendConsentPrompt } from "./onboarding/consent.js";
import { computeDevBypassFields } from "./dev-bypass.js";
import { startPoll } from "../services/verification-poller.js";
import { pinStatusBanner } from "../services/status-banner.js";
import { buildLanguageKeyboard } from "./language-keyboard.js";
import {
  AUTH_REGISTRATION_START_PREFIX,
  consumeWebRegistrationLink,
  WEB_REGISTRATION_START_PREFIX,
} from "../services/web-registration.js";

/**
 * Deep-link payload set on Persona's `redirect-uri` so the bot knows the
 * user has just returned from completing the Persona hosted flow. Triggers
 * the auto-poll for verification status. See
 * `services/verification-poller.ts`.
 */
const VERIFY_DONE_START_PARAM = "verify_done";

const start = new Composer<BotContext>();

function looksLikeEmailPrompt(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    lower.includes("email") ||
    lower.includes("почт") ||
    lower.includes("пошта") ||
    lower.includes("університетськ") ||
    lower.includes("университетск") ||
    lower.includes("uni-mail") ||
    lower.includes("uczeln")
  );
}

function containsPreVerifiedEmailGate(
  history: Array<{ role: string; content: string | null }>,
): boolean {
  return history.some((message) => {
    if (message.role !== "system" || !message.content) return false;
    const lower = message.content.toLowerCase();
    return (
      lower.includes("must provide a corporate university email") ||
      lower.includes("do not skip email verification")
    );
  });
}

function containsToolCall(
  history: Array<{
    role: string;
    tool_calls?: Array<{ function?: { name?: string } }>;
  }>,
  toolName: string,
): boolean {
  return history.some((message) =>
    message.tool_calls?.some((call) => call.function?.name === toolName),
  );
}

function looksLikeContextDumpInstruction(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    lower.includes("copy the prompt") ||
    lower.includes("paste it into chatgpt") ||
    lower.includes("скопируй промпт") ||
    lower.includes("вставь его в chatgpt") ||
    lower.includes("скопіюй промпт") ||
    lower.includes("skopiuj prompt") ||
    lower.includes("kopiere den prompt")
  );
}

type RegistrationPayload =
  | { kind: "web"; token: string; prefix: typeof WEB_REGISTRATION_START_PREFIX }
  | { kind: "auth"; token: string; prefix: typeof AUTH_REGISTRATION_START_PREFIX }
  | null;

function parseRegistrationPayload(payload: string): RegistrationPayload {
  if (payload.startsWith(AUTH_REGISTRATION_START_PREFIX)) {
    return {
      kind: "auth",
      prefix: AUTH_REGISTRATION_START_PREFIX,
      token: payload.slice(AUTH_REGISTRATION_START_PREFIX.length),
    };
  }
  if (payload.startsWith(WEB_REGISTRATION_START_PREFIX)) {
    return {
      kind: "web",
      prefix: WEB_REGISTRATION_START_PREFIX,
      token: payload.slice(WEB_REGISTRATION_START_PREFIX.length),
    };
  }
  return null;
}

function webAppRoot(): string {
  const raw = env.WEBAPP_URL.replace(/\/$/, "");
  if (raw.endsWith("/index.html")) return raw.slice(0, -"/index.html".length);
  if (raw.endsWith("/calendar")) return raw.slice(0, -"/calendar".length);
  return raw;
}

function onboardingMiniAppUrl(source: "telegram" | "web", lang: Language): string {
  const url = new URL(`${webAppRoot()}/onboarding.html`);
  url.searchParams.set("source", source);
  url.searchParams.set("lang", lang);
  url.searchParams.set("v", Date.now().toString(36));
  return url.toString();
}

function onboardingMiniAppCopy(
  lang: Language,
  source: "telegram" | "web",
  emailVerified: boolean,
): { message: string; button: string } {
  if (lang === "ru") {
    return {
      button: "Открыть Gennety",
      message:
        source === "web" || emailVerified
          ? "Почта уже подтверждена. Открой полноэкранный Mini App — он быстро доведёт вход до конца, а потом я продолжу здесь."
          : "Запустим Gennety в полноэкранном Mini App. Там будет короткий вход, а потом я продолжу онбординг прямо здесь.",
    };
  }
  if (lang === "uk") {
    return {
      button: "Відкрити Gennety",
      message:
        source === "web" || emailVerified
          ? "Пошту вже підтверджено. Відкрий повноекранний Mini App — він швидко завершить вхід, а потім я продовжу тут."
          : "Запустимо Gennety у повноекранному Mini App. Там буде короткий вхід, а потім я продовжу онбординг тут.",
    };
  }
  return {
    button: "Open Gennety",
    message:
      source === "web" || emailVerified
        ? "Your email is already verified. Open the full-screen Mini App to finish the handoff, then I'll continue here."
        : "Let's open Gennety in a full-screen Mini App. It handles the short entry flow, then I'll continue onboarding here.",
  };
}

async function sendOnboardingMiniAppPrompt(
  ctx: BotContext,
  user: User,
  source: "telegram" | "web",
): Promise<void> {
  const lang = (ctx.session.language ?? user.language ?? "en") as Language;
  const copy = onboardingMiniAppCopy(lang, source, user.isEmailVerified);
  const keyboard = new InlineKeyboard().webApp(copy.button, onboardingMiniAppUrl(source, lang));
  await ctx.reply(copy.message, { reply_markup: keyboard });
}

start.command("start", async (ctx) => {
  const telegramId = BigInt(ctx.from!.id);
  const startPayload = ctx.match?.toString().trim() ?? "";
  const devBypassFields = computeDevBypassFields(
    telegramId,
    env.DEV_OTP_BYPASS_TELEGRAM_IDS,
  );

  let user: User | null = null;
  const registrationPayload = parseRegistrationPayload(startPayload);

  if (registrationPayload) {
    const result = await consumeWebRegistrationLink(registrationPayload.token, telegramId);

    if (result.kind !== "linked") {
      if (result.kind === "telegram_has_other_email") {
        await ctx.reply(
          `This Telegram account is already linked to ${result.email}. ` +
            "Please continue with that email or contact support.",
        );
        return;
      }
      if (result.kind === "email_linked_to_other_telegram") {
        await ctx.reply(
          "This email is already linked to another Telegram account. " +
            "Please open Gennety from that account or contact support.",
        );
        return;
      }
      await ctx.reply(
        "This registration link has expired or was already used. " +
          "Please return to gennety.com and request a new code.",
      );
      return;
    }

    user = result.user;
  } else {
    // Upsert user — create if new, load existing state if returning
    user = await prisma.user.findUnique({ where: { telegramId } });

    if (!user) {
      // First-touch attribution: capture deep-link start_param from
      // `/start <param>` (e.g. `https://t.me/bot?start=ig_story`). Stored
      // once, never overwritten on later /start invocations so the
      // attribution is stable across re-onboarding. The `verify_done`
      // payload is a control signal, not an attribution source — skip it.
      const referralSource =
        startPayload.length > 0 &&
        startPayload.length <= 64 &&
        startPayload !== VERIFY_DONE_START_PARAM
          ? `tg:${startPayload}`
          : null;

      // Dev-only: skip the corporate-email step for whitelisted Telegram IDs.
      // See `dev-bypass.ts` for the rationale.
      if (devBypassFields) {
        console.warn(
          `[dev-bypass] Creating user ${telegramId} with synthetic verified email ` +
            `(DEV_OTP_BYPASS_TELEGRAM_IDS). DO NOT ship this configuration to prod.`,
        );
      }

      user = await prisma.user.create({
        data: { telegramId, firstName: null, referralSource, ...(devBypassFields ?? {}) },
      });
    } else if (devBypassFields && (!user.isEmailVerified || !user.email)) {
      console.warn(
        `[dev-bypass] Updating existing user ${telegramId} with synthetic verified email ` +
          `(DEV_OTP_BYPASS_TELEGRAM_IDS). DO NOT ship this configuration to prod.`,
      );
      user = await prisma.user.update({
        where: { telegramId },
        data: {
          ...devBypassFields,
          emailOtp: null,
          emailOtpExpiresAt: null,
        },
      });
    }
  }

  // Sync session from DB
  ctx.session.onboardingStep = user.onboardingStep as typeof ctx.session.onboardingStep;
  if (user.language) {
    ctx.session.language = user.language as typeof ctx.session.language;
  }

  // Persona deep-link: `?start=verify_done` is set on the hosted flow's
  // redirect-uri so we know the user has just tapped Persona's "Done".
  // Acknowledge once and kick off the auto-poll. We must NOT fall through
  // to the normal /start handlers below — those would either greet the
  // user as if they'd just opened the bot ("welcome back!") or re-prompt
  // for a step they're past.
  if (startPayload === VERIFY_DONE_START_PARAM) {
    await ctx.reply(t(ctx.session.language, "verifyAutoPollStarted"));
    startPoll(user.id, telegramId, ctx.session.language, ctx.api);
    return;
  }

  // If user already completed onboarding, greet them and open the main menu.
  if (user.onboardingStep === "completed") {
    ctx.session.menuState = "idle";
    await ctx.reply(t(ctx.session.language, "onboardingComplete"));
    await showMainMenu(ctx);
    if (user.status === "active") {
      await pinStatusBanner(ctx.api, telegramId, ctx.session.language);
    }
    return;
  }

  if (env.WEBAPP_URL) {
    await sendOnboardingMiniAppPrompt(
      ctx,
      user,
      registrationPayload ? "web" : "telegram",
    );
    return;
  }

  // Consent gatekeeper — must agree before anything else
  if (user.onboardingStep === "consent") {
    await sendConsentPrompt(ctx);
    return;
  }

  // If user is at language step, show language picker
  if (user.onboardingStep === "language") {
    await ctx.reply(
      "👋 Pick your language / Выбери язык / Обери мову / Sprache wählen / Wybierz język:",
      { reply_markup: buildLanguageKeyboard("lang") },
    );
    return;
  }

  // Conversational state — welcome the user back.
  // Usually we avoid spending an OpenAI call just to say "let's continue":
  // re-send the last assistant message from history. But when a dev bypass
  // or mobile-first verification has since populated `isEmailVerified`, a
  // stale pre-bypass "send your email" prompt would trap the user. In that
  // case, fall through to the agent so the verified-email system note can
  // advance them to profile basics.
  if (user.onboardingStep === "conversational") {
    const history = (user.messageHistory ?? []) as unknown[] as Array<{
      role: string;
      content: string | null;
      tool_calls?: Array<{ function?: { name?: string } }>;
    }>;
    const lastAssistant = [...history]
      .reverse()
      .find((m) => m?.role === "assistant" && m.content);
    const verifiedEmailOnFile = Boolean(user.isEmailVerified && user.email);
    const staleEmailGate =
      verifiedEmailOnFile &&
      ((lastAssistant?.content ? looksLikeEmailPrompt(lastAssistant.content) : false) ||
        containsPreVerifiedEmailGate(history));
    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
      select: { height: true, partnerPreferences: true },
    });
    const profileReadyForContextDump = Boolean(
      user.firstName &&
        user.age &&
        user.gender &&
        user.preference &&
        profile?.height &&
        profile.partnerPreferences,
    );
    const contextPromptAlreadyShown =
      containsToolCall(history, "request_context_dump") ||
      (lastAssistant?.content
        ? looksLikeContextDumpInstruction(lastAssistant.content)
        : false);
    const staleProfilePrompt =
      profileReadyForContextDump && !contextPromptAlreadyShown;

    if (lastAssistant?.content && !staleEmailGate && !staleProfilePrompt) {
      const lang = ctx.session.language ?? "en";
      const welcomeBack =
        lang === "ru"
          ? "👋 С возвращением! Продолжаем:"
          : lang === "uk"
            ? "👋 З поверненням! Продовжуємо:"
            : lang === "de"
              ? "👋 Willkommen zurück! Weiter geht's:"
              : lang === "pl"
                ? "👋 Witaj z powrotem! Kontynuujemy:"
                : "👋 Welcome back! Let's continue:";
      try {
        await ctx.reply(`${welcomeBack}\n\n${lastAssistant.content}`, {
          parse_mode: "Markdown",
        });
      } catch {
        await ctx.reply(
          `${welcomeBack}\n\n${lastAssistant.content.replace(/[*_`[\]]/g, "")}`,
        );
      }
      return;
    }

    if (staleEmailGate) {
      await prisma.user.update({
        where: { telegramId },
        data: { messageHistory: [] },
      });
    }

    // No prior assistant message (e.g. onboarding was just started), or a
    // stale pre-bypass email gate was cleared — call the agent so the user
    // isn't stuck.
    const { runAgentTurn } = await import("../services/onboarding-agent.js");
    const result = await runAgentTurn(
      telegramId,
      "[User returned and pressed /start. Continue onboarding from where we left off.]",
    );
    await ctx.reply(result.reply, { parse_mode: "Markdown" });
    return;
  }

  // Fallback — show language picker
  const { sendStepPrompt } = await import("./onboarding/prompts.js");
  await sendStepPrompt(ctx);
});

// /menu — summon the main menu at any time (only valid for completed users).
start.command("menu", async (ctx) => {
  if (ctx.session.onboardingStep !== "completed") {
    await ctx.reply(t(ctx.session.language, "finishOnboardingFirst"));
    return;
  }
  ctx.session.menuState = "idle";
  await showMainMenu(ctx);
});

// /edit — open the Edit Profile screen directly.
start.command("edit", async (ctx) => {
  if (ctx.session.onboardingStep !== "completed") {
    await ctx.reply(t(ctx.session.language, "finishOnboardingFirst"));
    return;
  }
  ctx.session.menuState = "idle";
  await showEditProfileMenu(ctx);
});

// /profile — show the user's profile.
start.command("profile", async (ctx) => {
  if (ctx.session.onboardingStep !== "completed") {
    await ctx.reply(t(ctx.session.language, "finishOnboardingFirst"));
    return;
  }
  await showMyProfile(ctx);
});

// /settings — open settings.
start.command("settings", async (ctx) => {
  if (ctx.session.onboardingStep !== "completed") {
    await ctx.reply(t(ctx.session.language, "finishOnboardingFirst"));
    return;
  }
  await showSettingsMenu(ctx);
});

export { start };
