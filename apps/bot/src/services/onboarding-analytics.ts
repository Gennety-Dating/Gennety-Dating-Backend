import { prisma } from "@gennety/db";

/**
 * Onboarding funnel telemetry (see `OnboardingStepEvent` in the Prisma schema).
 *
 * The collector is the single choke point for both the Telegram bot and the
 * `/v1/onboarding/*` mobile path, so recording transitions here instruments the
 * whole conversational funnel at once. Two questions drive everything the
 * founder dashboard (Hermes) needs:
 *   - drop-off — the step a still-`onboarding` user stopped at (their latest
 *     `asked` with no matching `answered`/`skipped`);
 *   - hesitation — `dwellMs`, how long they sat on a step before resolving it.
 *
 * These writes are deliberately best-effort and run AFTER the collector's save
 * transaction commits: a telemetry hiccup must never abort a user's onboarding
 * save, so `recordStepTransition` swallows its own errors.
 */

export type OnboardingStepKind = "asked" | "answered" | "skipped";

/** Derive the coarse client from the (synthetic-negative for mobile) id. */
export function platformFromTelegramId(telegramId: bigint): "telegram" | "mobile" {
  return telegramId < 0n ? "mobile" : "telegram";
}

interface StepTransition {
  userId: string;
  /** The step the user just finished, if the question advanced this turn. */
  resolved?: { step: string; kind: "answered" | "skipped" } | null;
  /** The step that just became current; `complete` / null records nothing. */
  askedNext?: string | null;
  language?: string | null;
  platform?: string | null;
}

/**
 * Record one onboarding step transition as up to two append-only rows: an
 * `answered`/`skipped` row for the finished step (tagged with the hesitation
 * gap since its latest `asked`) and an `asked` row for the step now surfaced.
 * Never throws.
 */
export async function recordStepTransition(t: StepTransition): Promise<void> {
  const language = t.language ?? null;
  const platform = t.platform ?? null;
  try {
    if (t.resolved) {
      const asked = await prisma.onboardingStepEvent.findFirst({
        where: { userId: t.userId, step: t.resolved.step, kind: "asked" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      const dwellMs = asked
        ? Math.max(0, Date.now() - asked.createdAt.getTime())
        : null;
      await prisma.onboardingStepEvent.create({
        data: {
          userId: t.userId,
          step: t.resolved.step,
          kind: t.resolved.kind,
          dwellMs,
          language,
          platform,
        },
      });
    }
    if (t.askedNext && t.askedNext !== "complete") {
      await prisma.onboardingStepEvent.create({
        data: {
          userId: t.userId,
          step: t.askedNext,
          kind: "asked",
          language,
          platform,
        },
      });
    }
  } catch (err) {
    console.warn("[onboarding-analytics] recordStepTransition failed", err);
  }
}
