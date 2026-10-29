import { prisma } from "@gennety/db";
import { t, type DateLifecycleState, type Language } from "@gennety/shared";

import { ACTIVE_MATCH_STATUSES, pickCurrentMatch } from "./active-match-priority.js";
import { deriveDateState, sideOf } from "./date-state.js";
import { pendingMorningAfterFor } from "./morning-after.js";
import { MATCH_CRON_SCHEDULE, parseDropCron } from "./next-batch.js";

/**
 * The chat agent's «how the app works» card (decision journal 2026-10-29).
 *
 * 2026-10-28 the founder asked the agent in the iOS chat how the app works. The
 * agent answered with `open_screen('help')` and said a Help button had
 * appeared — but the app has no Help screen (`menu:help` draws nothing on
 * iOS), so it insisted three times on a button that was not there. The loop of
 * the product is five steps; in prose it does not land.
 *
 * Now the agent calls `show_app_guide`: the reply carries a strip of five step
 * cards — evening match → blind decision → ticket, time and place → the date →
 * the morning after — with «you are here» on the person's real stage, read
 * from their live match the same way the canvas reads it (`deriveDateState`).
 *
 * Writes nothing. Stored on the reply (`messages.attachment`, kind
 * `app_guide`) so the history draws it again; returned as `guide`, never as
 * `attachment` (that one is the wishlist card). Capability-gated by
 * `X-Gennety-Chat-Cards: guide`; Telegram (`menu-agent.ts`) never sees it.
 */

export const APP_GUIDE_KIND = "app_guide";
/** Token an app build lists in `X-Gennety-Chat-Cards` when it draws this card. */
export const GUIDE_CARD_CLIENT_TOKEN = "guide";
export const SHOW_APP_GUIDE_TOOL_NAME = "show_app_guide";

/** The loop in order. The app picks each step's glyph by this key. */
export const GUIDE_STEP_KEYS = ["match", "blind", "plan", "date", "morning"] as const;
export type GuideStepKey = (typeof GUIDE_STEP_KEYS)[number];

export interface GuideStep {
  key: GuideStepKey;
  title: string;
  line: string;
}

/** Stored on `messages.attachment` — and, minus `kind`, what the app gets. */
export interface AppGuide {
  kind: typeof APP_GUIDE_KIND;
  steps: GuideStep[];
  /** The person's step when the card was made; null when it could not be read. */
  here: GuideStepKey | null;
  hereLabel: string;
}

/** `ChatAppGuide` in the OpenAPI contract. */
export interface AppGuideView {
  steps: GuideStep[];
  here: GuideStepKey | null;
  hereLabel: string;
}

/* ── the tool ───────────────────────────────────────────────────────────── */

export const SHOW_APP_GUIDE_TOOL = {
  type: "function" as const,
  function: {
    name: SHOW_APP_GUIDE_TOOL_NAME,
    description:
      "Show how Gennety works as a native card under your reply: five step cards (evening match, blind decision, ticket + time + place, the date, the morning after) with «you are here» on the person's real stage. Call it whenever they ask how the app works, what happens next in general, or are confused about the flow. Takes no arguments. The card IS the explanation: your reply is one or two sentences saying where they are now and what happens next — never list the steps in words, never mention a Help screen or button.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  },
};

/* ── where the person is ────────────────────────────────────────────────── */

/**
 * The canvas state, plus a pending morning-after check, as a step of the loop.
 * A morning-after question still waiting outranks everything except a live
 * date: the person is answering for the last one before the next begins.
 */
export function guideStageOf(state: DateLifecycleState, morningAfterPending: boolean): GuideStepKey {
  switch (state) {
    case "DROP_PENDING_DECISION":
      return "blind";
    case "LOGISTICS_SCHEDULING":
      return "plan";
    case "DATE_SCHEDULED":
    case "DATE_RADAR_ACTIVE":
    case "DATE_BUMP_PENDING":
    case "DATE_IN_PROGRESS":
      return "date";
    case "POST_DATE_FEEDBACK":
      return "morning";
    case "IDLE_EXPLORING":
      return morningAfterPending ? "morning" : "match";
  }
}

const MATCH_SELECT = {
  status: true,
  userAId: true,
  userBId: true,
  acceptedByA: true,
  acceptedByB: true,
  agreedTime: true,
  feedbackPromptedAt: true,
  feedbackByA: true,
  feedbackByB: true,
} as const;

/**
 * The person's step now — the same match `GET /v1/date/state` picks (a live
 * one first, else a completed one still owing feedback). The bump is left out:
 * every date sub-state is one step here.
 */
export async function loadGuideStage(userId: string, now: Date = new Date()): Promise<GuideStepKey> {
  const live = await prisma.match.findMany({
    where: { status: { in: [...ACTIVE_MATCH_STATUSES] }, OR: [{ userAId: userId }, { userBId: userId }] },
    orderBy: { createdAt: "desc" },
    select: MATCH_SELECT,
  });
  const current =
    pickCurrentMatch(live) ??
    (await prisma.match.findFirst({
      where: {
        status: "completed",
        feedbackPromptedAt: { not: null },
        OR: [
          { userAId: userId, feedbackByA: null },
          { userBId: userId, feedbackByB: null },
        ],
      },
      orderBy: { agreedTime: "desc" },
      select: MATCH_SELECT,
    }));
  const side = current ? sideOf(current, userId) : null;
  const state = deriveDateState({ match: current && side ? current : null, side: side ?? "A", bump: null, now });
  const morning = state === "IDLE_EXPLORING" ? (await pendingMorningAfterFor(userId, now)) !== null : false;
  return guideStageOf(state, morning);
}

/* ── the card ───────────────────────────────────────────────────────────── */

/** «18:00» — the drop time from the cron the batch actually runs on. */
export function dropTimeLabel(schedule: string = MATCH_CRON_SCHEDULE): string {
  const { hour, minute } = parseDropCron(schedule);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function buildAppGuide(language: Language, here: GuideStepKey | null, dropTime: string = dropTimeLabel()): AppGuide {
  return {
    kind: APP_GUIDE_KIND,
    steps: [
      { key: "match", title: dropTime, line: t(language, "guideMatchLine") },
      { key: "blind", title: t(language, "guideBlindTitle"), line: t(language, "guideBlindLine") },
      { key: "plan", title: t(language, "guidePlanTitle"), line: t(language, "guidePlanLine") },
      { key: "date", title: t(language, "guideDateTitle"), line: t(language, "guideDateLine") },
      { key: "morning", title: t(language, "guideMorningTitle"), line: t(language, "guideMorningLine") },
    ],
    here,
    hereLabel: t(language, "guideHere"),
  };
}

/** What the model reads back from its call: where they are, and how to reply. */
export function appGuideToolResult(guide: AppGuide): string {
  return JSON.stringify({
    success: true,
    shown: "A card with the five steps is under your reply.",
    here: guide.here,
    instruction:
      "Reply in one or two sentences in their language: where they are now (the step marked «here») and what happens next for them. Do not list the steps, do not describe the card, do not mention a Help screen or button.",
  });
}

/** The stored JSON as a guide, or null for anything that is not one. */
export function readAppGuide(raw: unknown): AppGuide | null {
  if (!raw || typeof raw !== "object") return null;
  const guide = raw as Partial<AppGuide>;
  if (guide.kind !== APP_GUIDE_KIND || !Array.isArray(guide.steps)) return null;
  const steps = guide.steps.filter(
    (s): s is GuideStep =>
      !!s &&
      GUIDE_STEP_KEYS.includes((s as GuideStep).key) &&
      typeof (s as GuideStep).title === "string" &&
      typeof (s as GuideStep).line === "string",
  );
  if (steps.length === 0) return null;
  return {
    kind: APP_GUIDE_KIND,
    steps,
    here: GUIDE_STEP_KEYS.includes(guide.here as GuideStepKey) ? (guide.here as GuideStepKey) : null,
    hereLabel: typeof guide.hereLabel === "string" ? guide.hereLabel : "",
  };
}

export function appGuideView(guide: AppGuide): AppGuideView {
  return { steps: guide.steps, here: guide.here, hereLabel: guide.hereLabel };
}

/** What the model reads under its own earlier reply. */
export function appGuideNote(guide: AppGuide): string {
  return `[Guide card under this reply: the five steps of the app${guide.here ? `, «here» on ${guide.here}` : ""}. Don't show it again unless they ask.]`;
}
