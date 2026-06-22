import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { openaiFetch } from "../services/openai-fetch.js";
import {
  computeNextTouch,
  MAX_RE_ENGAGEMENT_STEP,
  reEngagementStopPatch,
} from "./re-engagement-schedule.js";

/**
 * Re-engagement worker for abandoned onboarding sessions.
 *
 * Implements a 5-step retention loop with decreasing frequency. Each user
 * carries a `reEngagementStep` counter (0…5) and a precomputed
 * `reEngagementNextAt` moment. The worker simply picks users whose next-at
 * has passed, sends the contextual hook, advances the step, and schedules
 * the following touch via `computeNextTouch()`.
 *
 * Schedule anchors (Kyiv local, see re-engagement-schedule.ts):
 *   step 1: +15 min    (hot reminder)
 *   step 2: +2 h
 *   step 3: same-day evening 19:00
 *   step 4: next-day evening 19:00
 *   step 5: day+2 afternoon 14:00
 *   step 6+: chain exhausted (reEngagementNextAt set to null)
 *
 * Hard quiet-hours 23:00–09:00 Kyiv are enforced inside `computeNextTouch`
 * by deferring the send to the following 13:00 Kyiv.
 *
 * Chain reset: any user activity (consent click, language pick, any
 * conversational reply, photo upload) resets step to 0 and schedules a new
 * touch 1. Onboarding completion nulls the next-at and halts the chain.
 */

export interface ReEngagementOptions {
  /** Max users to process per tick (default: 50) */
  batchSize?: number;
  /** Injectable fetch for testing */
  fetchFn?: typeof fetch;
  /** Override "now" for testing */
  now?: Date;
}

interface ChatMessage {
  role: string;
  content: string | null;
}

/**
 * Run one tick of the re-engagement worker. Returns the number of touches
 * actually delivered in this tick.
 */
export async function reEngagementTick(
  api: Api<RawApi>,
  options: ReEngagementOptions = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 50;
  const fetchFn = options.fetchFn ?? openaiFetch;

  const dueUsers = await prisma.user.findMany({
    where: {
      status: "onboarding",
      onboardingStep: { not: "completed" },
      reEngagementNextAt: { not: null, lte: now },
      // M-17: synthetic mobile users (negative telegramId) get re-engagement
      // pushes via Expo, not Telegram DMs.
      telegramId: { gt: 0n },
    },
    select: {
      telegramId: true,
      onboardingStep: true,
      messageHistory: true,
      language: true,
      firstName: true,
      lastMessageAt: true,
      reEngagementStep: true,
    },
    take: batchSize,
  });

  let sent = 0;

  for (const user of dueUsers) {
    if (user.onboardingStep === "completed") {
      await prisma.user.update({
        where: { telegramId: user.telegramId },
        data: reEngagementStopPatch,
      });
      continue;
    }

    const currentStep = user.reEngagementStep;
    const nextStep = currentStep + 1;

    const anchor = user.lastMessageAt ?? now;
    const following =
      nextStep > MAX_RE_ENGAGEMENT_STEP
        ? null
        : computeNextTouch(nextStep + 1, anchor, now);

    const claim = await prisma.user.updateMany({
      where: {
        telegramId: user.telegramId,
        status: "onboarding",
        onboardingStep: { not: "completed" },
        reEngagementStep: currentStep,
        reEngagementNextAt: { not: null, lte: now },
      },
      data: {
        reEngagementStep: nextStep,
        reEngagementNextAt: following,
        // Intentionally NOT touching lastMessageAt — the bot's own sends are
        // not user activity. Chain anchor stays at the original drop-off.
      },
    });
    if (claim.count === 0) continue;

    try {
      const hookText = await generateHookMessage(
        { ...user, upcomingStep: nextStep },
        fetchFn,
      );

      await api.sendMessage(Number(user.telegramId), hookText, {
        parse_mode: "Markdown",
      });
      sent++;
    } catch (err) {
      console.warn(
        `Re-engagement send failed for ${user.telegramId}:`,
        (err as Error).message,
      );
    }
  }

  return sent;
}

/**
 * Human-readable description of what the user was asked to do at each step.
 * Injected into the OpenAI prompt so the message is contextually relevant.
 */
function getStepContext(step: string): string {
  switch (step) {
    case "consent":
      return "They opened the bot but haven't agreed to the privacy policy yet.";
    case "language":
      return "They agreed to the privacy policy but haven't picked their language yet.";
    case "conversational":
      return "They started filling in their profile (email, name, photos, etc.) but dropped off midway.";
    default:
      return "They started onboarding but haven't finished.";
  }
}

/**
 * Tone hint for the LLM prompt based on which touch in the chain we're firing.
 * Each successive touch is a touch less urgent — retention loop, not nagging.
 */
function getTouchToneHint(touchIndex: number): string {
  switch (touchIndex) {
    case 1:
      return "This is a QUICK 15-min check-in. Casual, one-liner, like 'hey, still there?'";
    case 2:
      return "Second check-in (~2h later). Still casual, maybe hint at what they'll miss.";
    case 3:
      return "Evening nudge the same day. Tone: 'take 2 min to finish before bed'.";
    case 4:
      return "Next-day evening. A touch warmer, like a friend who remembered.";
    case 5:
      return "Final nudge, day after that. Honest and low-pressure — the last message they'll get.";
    default:
      return "Warm, friendly reminder.";
  }
}

/**
 * Generate a personalised re-engagement message using the user's
 * conversation history, onboarding step, and the touch index in the chain.
 */
async function generateHookMessage(
  user: {
    onboardingStep: string;
    messageHistory: unknown[];
    language: string | null;
    firstName: string | null;
    upcomingStep: number;
  },
  fetchFn: typeof fetch,
): Promise<string> {
  const history = (user.messageHistory ?? []).map(
    (m) => m as unknown as ChatMessage,
  );

  const lastMessages = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-6)
    .map((m) => `${m.role}: ${m.content ?? ""}`)
    .join("\n");

  const lang = user.language ?? "en";
  const name = user.firstName ?? "";
  const stepCtx = getStepContext(user.onboardingStep);
  const toneHint = getTouchToneHint(user.upcomingStep);

  const prompt = `You are Gennety Dating's re-engagement assistant. A user dropped off during onboarding.

User info:
- Name: ${name || "unknown"}
- Language: ${lang}
- Where they are: ${stepCtx}
- Touch ${user.upcomingStep} of ${MAX_RE_ENGAGEMENT_STEP}: ${toneHint}

Recent conversation:
${lastMessages || "(no messages yet)"}

Write a SHORT, casual message (1-2 sentences max) to bring them back. Like a friend checking in — not a bot. Mention something specific from the conversation if you can. Use 1 emoji max. Write in ${lang}.

Tone: casual, warm, no cringe. No "Здравствуйте" or formal phrases. Talk like a cool older friend.

CRITICAL: Use strictly gender-neutral language. We do NOT know the user's gender. In Russian/Ukrainian/Polish, avoid gendered past-tense verb forms (e.g. do NOT use «упоминал/упоминала», «отвечал/отвечала», «відповів/відповіла», "wróciłeś/wróciłaś"). Rephrase to avoid gendered forms entirely — use infinitives, nouns, or impersonal constructions instead.

Good examples:
- "Эй, [name]! Помнишь свои хобби? У нас уже есть мэтчи 👀 Давай дооформим профиль!"
- "Almost there! Profile is almost done. Come back and let's get you matched."

Bad examples (DON'T do this):
- "Уважаемый пользователь, напоминаем вам..."
- "Incredibly exciting matches await you!"
- Any message with gendered past-tense forms in Russian/Ukrainian/Polish (упоминал, ответил, зашёл, wróciłeś/wróciłaś, etc.)

Output ONLY the message text.`;

  try {
    const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.8,
        max_completion_tokens: 150,
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI ${res.status}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return (
      json.choices?.[0]?.message?.content?.trim() ??
      getFallbackMessage(name, lang, user.upcomingStep)
    );
  } catch (err) {
    console.warn("Re-engagement LLM call failed, using fallback:", err);
    return getFallbackMessage(name, lang, user.upcomingStep);
  }
}

export function getFallbackMessage(
  name: string,
  lang: string,
  touchIndex = 1,
): string {
  const greeting = name ? ` ${name}` : "";
  // Keep fallbacks short and gender-neutral. Tone softens as the chain
  // progresses — final touch is the least pushy.
  if (lang === "ru") {
    switch (touchIndex) {
      case 1:
        return `Эй${greeting}, всё ещё с нами? Профиль почти готов 👀`;
      case 2:
        return `${name ? `${name}, ` : ""}возвращайся, когда будет минутка — закончим профиль ☕`;
      case 3:
        return `${name ? `${name}, ` : ""}вечер — отличное время дооформить профиль. Займёт пару минут 🌙`;
      case 4:
        return `${name ? `${name}, ` : ""}напоминаем: профиль ждёт. Пары подбираются по нему 💭`;
      default:
        return `${name ? `${name}, ` : ""}последнее напоминание — если не завершить профиль, мы не сможем подобрать пару. Будем рады видеть 🤍`;
    }
  }
  if (lang === "uk") {
    switch (touchIndex) {
      case 1:
        return `Гей${greeting}, ще з нами? Профіль майже готовий 👀`;
      case 2:
        return `${name ? `${name}, ` : ""}повертайся, коли буде хвилинка — закінчимо профіль ☕`;
      case 3:
        return `${name ? `${name}, ` : ""}вечір — чудовий час дооформити профіль. Займе пару хвилин 🌙`;
      case 4:
        return `${name ? `${name}, ` : ""}нагадуємо: профіль чекає. Пари добираються за ним 💭`;
      default:
        return `${name ? `${name}, ` : ""}останнє нагадування — без завершеного профілю не зможемо підібрати пару. Будемо раді побачити 🤍`;
    }
  }
  if (lang === "de") {
    switch (touchIndex) {
      case 1:
        return `Hey${greeting}, noch dabei? Dein Profil ist fast fertig 👀`;
      case 2:
        return `${name ? `${name}, ` : ""}komm zurück, wenn du kurz Zeit hast - wir schließen dein Profil ab ☕`;
      case 3:
        return `${name ? `${name}, ` : ""}abends lässt sich das Profil gut fertig machen. Dauert nur ein paar Minuten 🌙`;
      case 4:
        return `${name ? `${name}, ` : ""}kurzer Reminder: dein Profil ist die Basis für deine Matches 💭`;
      default:
        return `${name ? `${name}, ` : ""}letzter Reminder - ohne fertiges Profil können wir dich nicht matchen. Wir freuen uns auf dich 🤍`;
    }
  }
  if (lang === "pl") {
    switch (touchIndex) {
      case 1:
        return `Hej${greeting}, nadal z nami? Twój profil jest prawie gotowy 👀`;
      case 2:
        return `${name ? `${name}, ` : ""}wróć, gdy masz chwilę - dokończymy profil ☕`;
      case 3:
        return `${name ? `${name}, ` : ""}wieczór to dobry moment, żeby domknąć profil. Zajmie parę minut 🌙`;
      case 4:
        return `${name ? `${name}, ` : ""}krótkie przypomnienie: profil jest podstawą dopasowań 💭`;
      default:
        return `${name ? `${name}, ` : ""}ostatnie przypomnienie - bez gotowego profilu nie możemy dobrać pary. Chętnie Cię zobaczymy 🤍`;
    }
  }
  switch (touchIndex) {
    case 1:
      return `Hey${greeting}, still with us? Your profile is almost done 👀`;
    case 2:
      return `${name ? `${name}, ` : ""}come back when you have a minute — let's finish your profile ☕`;
    case 3:
      return `${name ? `${name}, ` : ""}evenings are a good time to wrap this up. Takes two minutes 🌙`;
    case 4:
      return `${name ? `${name}, ` : ""}quick reminder: your profile is what we match on 💭`;
    default:
      return `${name ? `${name}, ` : ""}last nudge — without a finished profile we can't match you. Would love to have you 🤍`;
  }
}
