import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { openaiFetch } from "../services/openai-fetch.js";
import { t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { previewWeeklyBatch } from "../services/match-engine.js";
import { isQuietHours } from "./quiet-hours.js";

/**
 * Pre-match announcement worker.
 *
 * Runs ~24 hours before the weekly matching batch (default: Saturday 18:00).
 * Sends each active user a casual, warm teaser: "We've been looking for your
 * match all week — check in tomorrow evening."
 *
 * Idempotency: skips users whose `lastPreMatchAnnounceAt` is within the last
 * 6 days, so re-running the cron or a crash/retry doesn't double-send.
 *
 * Quiet hours are respected as always.
 */

/** Only re-send the teaser after this cooldown (6 days = ~one week cycle). */
export const ANNOUNCE_COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000;

export interface PreMatchAnnounceOptions {
  fetchFn?: typeof fetch;
  now?: Date;
  batchSize?: number;
}

export interface AnnounceResult {
  announced: number;
}

type PlannedNotificationKind = "matched" | "standby";

export async function preMatchAnnounceTick(
  api: Api<RawApi>,
  options: PreMatchAnnounceOptions = {},
): Promise<AnnounceResult> {
  const now = options.now ?? new Date();
  if (isQuietHours(now)) return { announced: 0 };

  const fetchFn = options.fetchFn ?? openaiFetch;
  const batchSize = options.batchSize ?? 100;
  const cooldownCutoff = new Date(now.getTime() - ANNOUNCE_COOLDOWN_MS);
  const plan = await previewWeeklyBatch();

  const plannedKinds = new Map<string, PlannedNotificationKind>();
  for (const pair of plan.finalPairs) {
    plannedKinds.set(pair.userAId, "matched");
    plannedKinds.set(pair.userBId, "matched");
  }
  for (const userId of plan.missedUserIds) {
    plannedKinds.set(userId, "standby");
  }

  const plannedUserIds = [...plannedKinds.keys()].slice(0, batchSize);
  if (plannedUserIds.length === 0) {
    return { announced: 0 };
  }

  const users = await prisma.user.findMany({
    where: {
      status: "active",
      id: { in: plannedUserIds },
      OR: [
        { lastPreMatchAnnounceAt: null },
        { lastPreMatchAnnounceAt: { lt: cooldownCutoff } },
      ],
    },
    select: {
      id: true,
      telegramId: true,
      language: true,
      firstName: true,
      lastPreMatchAnnounceAt: true,
    },
    take: batchSize,
  });

  let announced = 0;

  for (const user of users) {
    const plannedKind = plannedKinds.get(user.id);
    if (!plannedKind) continue;
    if (user.telegramId <= 0n) continue;

    try {
      const text = plannedKind === "matched"
        ? await generateAnnounce(user, fetchFn)
        : getStandbyFallback(user.language ?? "en");
      const claim = await prisma.user.updateMany({
        where: {
          id: user.id,
          status: "active",
          OR: [
            { lastPreMatchAnnounceAt: null },
            { lastPreMatchAnnounceAt: { lt: cooldownCutoff } },
          ],
        },
        data: { lastPreMatchAnnounceAt: now },
      });
      if (claim.count === 0) continue;
      await api.sendMessage(Number(user.telegramId), text, {
        parse_mode: "Markdown",
      });
      announced++;
    } catch (err) {
      console.warn(
        `[pre-match-announce] send failed for ${user.telegramId}:`,
        (err as Error).message,
      );
    }
  }

  return { announced };
}

async function generateAnnounce(
  user: { firstName: string | null; language: string | null },
  fetchFn: typeof fetch,
): Promise<string> {
  const lang = user.language ?? "en";
  const name = user.firstName ?? "";

  const prompt = `You are Gennety Dating's assistant. Tomorrow evening the weekly matching batch runs — the user will receive their curated match.

User info:
- Name: ${name || "unknown"}
- Language: ${lang}

Write a SHORT teaser message (2-3 sentences max) telling them we've been searching for their perfect match all week and they'll get it tomorrow evening. Make it feel exciting and personal — like a friend who's about to reveal a secret. 1-2 emojis max. Write in ${lang}.

Tone: warm, a little mysterious, zero corporate-speak.

CRITICAL: Use strictly gender-neutral language. We do NOT know the user's gender. Avoid any gendered verb forms or adjectives referring to the user. Use neutral imperatives and impersonal constructions.

Good example:
- "Эй, [name]! Мы целую неделю искали для тебя идеальную пару 🔍 Завтра вечером — покажем. Готовься 👀"
- "Hey [name]! We've spent the whole week hunting down your perfect match. Tomorrow evening, we're pulling back the curtain 👀"

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
        temperature: 0.85,
        max_completion_tokens: 160,
      }),
    });

    if (!res.ok) throw new Error(`OpenAI ${res.status}`);

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return (
      json.choices?.[0]?.message?.content?.trim() ??
      getAnnounceFallback(name, lang)
    );
  } catch {
    return getAnnounceFallback(name, lang);
  }
}

export function getAnnounceFallback(name: string, lang: string): string {
  const g = name ? `, ${name}` : "";
  switch (lang) {
    case "ru":
      return `Эй${g}! Мы целую неделю искали для тебя идеальную пару 🔍 Завтра вечером — покажем. Готовься 👀`;
    case "uk":
      return `Гей${g}! Ми цілий тиждень шукали для тебе ідеальну пару 🔍 Завтра ввечері — покажемо. Готуйся 👀`;
    default:
      return `Hey${g}! We've spent the whole week finding your perfect match 🔍 Tomorrow evening — we'll reveal them. Stay tuned 👀`;
  }
}

export function getStandbyFallback(lang: Language): string {
  return t(lang, "matchStandbyStatus");
}
