import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../session.js";
import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import { env } from "../config.js";
import { showMainMenu } from "./menu/main.js";
import { showEditProfileMenu } from "./menu/edit-profile.js";
import { showMyProfile } from "./menu/my-profile.js";
import { showSettingsMenu } from "./menu/settings.js";
import { sendConsentPrompt } from "./onboarding/consent.js";
import { computeDevBypassFields } from "./dev-bypass.js";

const start = new Composer<BotContext>();

start.command("start", async (ctx) => {
  const telegramId = BigInt(ctx.from!.id);

  // Upsert user — create if new, load existing state if returning
  let user = await prisma.user.findUnique({ where: { telegramId } });

  if (!user) {
    // First-touch attribution: capture deep-link start_param from
    // `/start <param>` (e.g. `https://t.me/bot?start=ig_story`). Stored
    // once, never overwritten on later /start invocations so the
    // attribution is stable across re-onboarding.
    const startPayload = ctx.match?.toString().trim();
    const referralSource =
      startPayload && startPayload.length > 0 && startPayload.length <= 64
        ? `tg:${startPayload}`
        : null;

    // Dev-only: skip the corporate-email step for whitelisted Telegram IDs.
    // See `dev-bypass.ts` for the rationale.
    const bypassFields = computeDevBypassFields(telegramId, env.DEV_OTP_BYPASS_TELEGRAM_IDS);
    if (bypassFields) {
      console.warn(
        `[dev-bypass] Creating user ${telegramId} with synthetic verified email ` +
          `(DEV_OTP_BYPASS_TELEGRAM_IDS). DO NOT ship this configuration to prod.`,
      );
    }

    user = await prisma.user.create({
      data: { telegramId, firstName: null, referralSource, ...(bypassFields ?? {}) },
    });
  }

  // Sync session from DB
  ctx.session.onboardingStep = user.onboardingStep as typeof ctx.session.onboardingStep;
  if (user.language) {
    ctx.session.language = user.language as typeof ctx.session.language;
  }

  // If user already completed onboarding, greet them and open the main menu.
  if (user.onboardingStep === "completed") {
    ctx.session.menuState = "idle";
    await ctx.reply(t(ctx.session.language, "onboardingComplete"));
    await showMainMenu(ctx);
    return;
  }

  // Consent gatekeeper — must agree before anything else
  if (user.onboardingStep === "consent") {
    await sendConsentPrompt(ctx);
    return;
  }

  // If user is at language step, show language picker
  if (user.onboardingStep === "language") {
    const keyboard = new InlineKeyboard()
      .text("English", "lang:en")
      .text("Русский", "lang:ru")
      .text("Українська", "lang:uk");

    await ctx.reply("👋 Pick your language / Выбери язык / Обери мову:", {
      reply_markup: keyboard,
    });
    return;
  }

  // Conversational state — welcome the user back.
  // Avoid spending an OpenAI call just to say "let's continue": re-send the
  // last assistant message from history instead. If there isn't one, fall
  // back to the agent (rare edge case).
  if (user.onboardingStep === "conversational") {
    const history = (user.messageHistory ?? []) as unknown[] as Array<{
      role: string;
      content: string | null;
    }>;
    const lastAssistant = [...history]
      .reverse()
      .find((m) => m?.role === "assistant" && m.content);

    if (lastAssistant?.content) {
      const lang = ctx.session.language ?? "en";
      const welcomeBack =
        lang === "ru"
          ? "👋 С возвращением! Продолжаем:"
          : lang === "uk"
            ? "👋 З поверненням! Продовжуємо:"
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

    // No prior assistant message (e.g. onboarding was just started) — fall
    // back to calling the agent so the user isn't stuck.
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
