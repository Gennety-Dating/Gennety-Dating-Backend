import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { VOICE_CORE } from "@gennety/shared";
import type { Language } from "@gennety/shared";
import { env } from "../config.js";
import { openaiFetch } from "../services/openai-fetch.js";
import { sendVerificationReminder } from "../handlers/onboarding/verification.js";
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

  // Registration v2 (mandatory liveness): a user who finalized onboarding but
  // hasn't passed Persona sits at status='onboarding', onboardingStep='completed'
  // — outside the main chain above (which stops at 'completed'). Nudge them
  // through the same decaying cadence until the pipeline activates them or the
  // chain exhausts. `pending_review` and `rejected` are deliberately excluded:
  // those users already did their part (or got the rejection guidance) and must
  // not be nagged to "verify".
  if (env.MANDATORY_VERIFICATION_ENABLED) {
    const stalled = await prisma.user.findMany({
      where: {
        status: "onboarding",
        onboardingStep: "completed",
        verificationStatus: { in: ["pending", "unverified"] },
        reEngagementNextAt: { not: null, lte: now },
        telegramId: { gt: 0n },
      },
      select: {
        id: true,
        telegramId: true,
        language: true,
        reEngagementStep: true,
      },
      take: batchSize,
    });

    for (const user of stalled) {
      const currentStep = user.reEngagementStep;
      const nextStep = currentStep + 1;
      const following =
        nextStep > MAX_RE_ENGAGEMENT_STEP
          ? null
          : computeNextTouch(nextStep + 1, now, now);

      const claim = await prisma.user.updateMany({
        where: {
          telegramId: user.telegramId,
          status: "onboarding",
          onboardingStep: "completed",
          reEngagementStep: currentStep,
          reEngagementNextAt: { not: null, lte: now },
        },
        data: { reEngagementStep: nextStep, reEngagementNextAt: following },
      });
      if (claim.count === 0) continue;

      try {
        await sendVerificationReminder(
          api as unknown as Api,
          Number(user.telegramId),
          (user.language ?? "en") as Language,
          user.id,
        );
        sent++;
      } catch (err) {
        console.warn(
          `Verification-stall nudge failed for ${user.telegramId}:`,
          (err as Error).message,
        );
      }
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
      return "Quick 15-min check-in. A calm one-liner — 'ещё тут?' energy, nothing more.";
    case 2:
      return "Second check-in (~2h later). Still low-key; just note the profile is almost done.";
    case 3:
      return "Same-day evening. Plainly: two minutes to wrap it up whenever there's a moment.";
    case 4:
      return "Next-day evening. A touch warmer — a friend who remembered, no pressure.";
    case 5:
      return "Final nudge, day after. Honest, quiet, low-pressure — the last message they'll get.";
    default:
      return "Warm, low-key reminder.";
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

  const prompt = `${VOICE_CORE}

Right now you're doing ONE thing: a user started onboarding and dropped off before finishing their profile. Send a single short message to bring them back — the same voice you'd use in any normal chat with them, not a "campaign" blast.

User info:
- Name: ${name || "unknown"}
- Language: ${lang}
- Where they are: ${stepCtx}
- Touch ${user.upcomingStep} of ${MAX_RE_ENGAGEMENT_STEP}: ${toneHint}

Recent conversation:
${lastMessages || "(no messages yet)"}

Write it in ${lang}. 1–2 short sentences, one idea. Reference something concrete from the conversation if there is one; otherwise keep it simple. Emoji default is ZERO (at most one, only if it truly lands). No begging, no hype, no "заходи скорее!".

CRITICAL: Use strictly gender-neutral language. We do NOT know the user's gender. In Russian/Ukrainian/Polish, avoid gendered past-tense verb forms (e.g. do NOT use «упоминал/упоминала», «отвечал/отвечала», «відповів/відповіла», "wróciłeś/wróciłaś"). Rephrase to avoid gendered forms entirely — use infinitives, nouns, or impersonal constructions instead.

Good examples (register, not to copy):
- "эй, ты ещё тут? профиль почти готов — осталась пара шагов."
- "almost there — профиль на финишной прямой. вернёшься, когда будет минута?"
- "still there? profile's basically done, just needs the last bit."

Bad examples (DON'T do this):
- "Уважаемый пользователь, напоминаем вам..." (corporate)
- "Incredibly exciting matches await you!" / "У нас уже есть мэтчи 👀 Давай дооформим!" (hype, exclamation, emoji spam)
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
  const lead = name ? `${name}, ` : "";
  // Fallbacks follow VOICE.md: understatement over hype, emoji default zero
  // (only the warm final touch carries one 🤍), no exclamation-mark hype, no
  // corporate phrasing, native per language. Kept gender-neutral (drop-off =
  // gender unknown). Tone softens as the chain progresses.
  if (lang === "ru") {
    switch (touchIndex) {
      case 1:
        return `эй${greeting}, ещё тут? профиль почти готов — осталась пара шагов.`;
      case 2:
        return `${lead}вернёшься, когда будет минута? допишем профиль.`;
      case 3:
        return `${lead}вечером как раз пара минут, чтобы дооформить профиль.`;
      case 4:
        return `${lead}профиль всё ещё ждёт — по нему и подбираем пару.`;
      default:
        return `${lead}последнее напоминание: без готового профиля не выйдет подобрать пару. будем рады, если вернёшься 🤍`;
    }
  }
  if (lang === "uk") {
    switch (touchIndex) {
      case 1:
        return `гей${greeting}, ще тут? профіль майже готовий — лишилось пару кроків.`;
      case 2:
        return `${lead}повертайся, коли буде хвилинка — допишемо профіль.`;
      case 3:
        return `${lead}увечері якраз пара хвилин, щоб дооформити профіль.`;
      case 4:
        return `${lead}профіль ще чекає — саме за ним і добираємо пару.`;
      default:
        return `${lead}останнє нагадування: без готового профілю не вийде підібрати пару. будемо раді, якщо повернешся 🤍`;
    }
  }
  if (lang === "de") {
    switch (touchIndex) {
      case 1:
        return `hey${greeting}, noch da? dein Profil ist fast fertig — nur ein paar Schritte fehlen.`;
      case 2:
        return `${lead}komm zurück, wenn du kurz Zeit hast — wir machen dein Profil fertig.`;
      case 3:
        return `${lead}abends passt gut, um das Profil abzuschließen. dauert zwei Minuten.`;
      case 4:
        return `${lead}dein Profil wartet noch — darüber matchen wir.`;
      default:
        return `${lead}letzter Reminder: ohne fertiges Profil können wir dich nicht matchen. schön, wenn du zurückkommst 🤍`;
    }
  }
  if (lang === "pl") {
    switch (touchIndex) {
      case 1:
        return `hej${greeting}, jesteś tam? twój profil jest prawie gotowy — zostało parę kroków.`;
      case 2:
        return `${lead}wróć, gdy masz chwilę — dokończymy profil.`;
      case 3:
        return `${lead}wieczorem w sam raz domknąć profil. zajmie dwie minuty.`;
      case 4:
        return `${lead}profil wciąż czeka — to na jego podstawie dobieramy parę.`;
      default:
        return `${lead}ostatnie przypomnienie: bez gotowego profilu nie dobierzemy pary. będzie miło, jeśli wrócisz 🤍`;
    }
  }
  switch (touchIndex) {
    case 1:
      return `hey${greeting}, still there? your profile's almost done — just a couple steps left.`;
    case 2:
      return `${lead}come back when you have a minute — let's finish your profile.`;
    case 3:
      return `${lead}evening's a good time to wrap this up. takes two minutes.`;
    case 4:
      return `${lead}your profile's still waiting — it's what we match on.`;
    default:
      return `${lead}last nudge — without a finished profile we can't match you. would be good to have you 🤍`;
  }
}
