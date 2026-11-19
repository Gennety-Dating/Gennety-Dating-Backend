import { Prisma, prisma } from "@gennety/db";
import { SUGGESTED_REPLIES } from "@gennety/shared";
import { inHoldout, readSuggestedReplies, type SuggestedRepliesAttachment } from "../suggested-replies.js";
import { suggestedRepliesUsers } from "../feature-preview.js";
import type { InsightDraft } from "./detectors.js";
import type { MetricRow } from "./rollup-math.js";

/**
 * Pulse metrics of suggested replies (docs/product/domains/suggested-replies.md,
 * Phase 4). Server-side only — the stored chips, the next turn, match events
 * and ideas — so no client events and no analytics consent question.
 *
 * Covers the app chat (`messages`). The Telegram agent keeps its turns in
 * `users.message_history`, so its chips are counted in the logs only
 * (`[replies] telegram …`) until that agent moves onto message rows.
 */

export interface ReplyChatRow {
  sessionId: string;
  userId: string;
  startedAt: Date;
  userTurns: number;
  assistantRows: number;
  sets: SuggestedRepliesAttachment[];
}

/** A step offline by the person: a yes to a pair, a date that happened, an idea saved. */
export interface OfflineStepRow {
  userId: string;
  at: Date;
}

const OFFLINE_EVENTS = ["ACCEPTED", "DATE_COMPLETED"] as const;

export async function loadReplyChats(from: Date, to: Date, excluded: ReadonlySet<string>): Promise<ReplyChatRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{ session_id: string; user_id: string; started_at: Date; user_turns: bigint; assistant_rows: bigint; sets: unknown[] | null }>
  >(Prisma.sql`
    SELECT m.session_id, m.user_id, min(m.created_at) AS started_at,
           count(*) FILTER (WHERE m.role = 'user') AS user_turns,
           count(*) FILTER (WHERE m.role = 'assistant') AS assistant_rows,
           jsonb_agg(m.attachment) FILTER (WHERE m.attachment->>'kind' = 'suggested_replies') AS sets
    FROM messages m
    WHERE m.session_id IS NOT NULL AND m.created_at >= ${from} AND m.created_at < ${to}
    GROUP BY m.session_id, m.user_id
  `);
  return rows
    .filter((r) => !excluded.has(r.user_id))
    .map((r) => ({
      sessionId: r.session_id,
      userId: r.user_id,
      startedAt: r.started_at,
      userTurns: Number(r.user_turns),
      assistantRows: Number(r.assistant_rows),
      sets: (r.sets ?? []).map(readSuggestedReplies).filter((s): s is SuggestedRepliesAttachment => s !== null),
    }));
}

export async function loadOfflineSteps(from: Date, to: Date, userIds: readonly string[]): Promise<OfflineStepRow[]> {
  if (userIds.length === 0) return [];
  const until = new Date(to.getTime() + SUGGESTED_REPLIES.offlineStepWindowMs);
  const [events, ideas] = await Promise.all([
    prisma.matchEvent.findMany({
      where: { actorId: { in: [...userIds] }, actionType: { in: [...OFFLINE_EVENTS] }, createdAt: { gte: from, lt: until } },
      select: { actorId: true, createdAt: true },
    }),
    prisma.memoryIdea.findMany({
      where: { userId: { in: [...userIds] }, createdAt: { gte: from, lt: until } },
      select: { userId: true, createdAt: true },
    }),
  ]);
  return [
    ...events.map((e) => ({ userId: e.actorId, at: e.createdAt })),
    ...ideas.map((i) => ({ userId: i.userId, at: i.createdAt })),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────

function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface RepliesRollupInput {
  days: ReadonlySet<string>;
  chats: readonly ReplyChatRow[];
  steps: readonly OfflineStepRow[];
  /** Who has chips: null = everyone, a list = only those. */
  eligible: readonly string[] | null;
  holdout?: (userId: string) => boolean;
}

type Arm = "chips" | "holdout";

function armOf(userId: string, input: RepliesRollupInput): Arm | null {
  const on = input.eligible === null || input.eligible.includes(userId.toLowerCase());
  if (!on) return null;
  return (input.holdout ?? inHoldout)(userId) ? "holdout" : "chips";
}

function stepWithin(steps: ReadonlyMap<string, Date[]>, userId: string, after: Date): boolean {
  const end = after.getTime() + SUGGESTED_REPLIES.offlineStepWindowMs;
  return (steps.get(userId) ?? []).some((at) => at.getTime() >= after.getTime() && at.getTime() < end);
}

export function computeReplyRows(input: RepliesRollupInput): MetricRow[] {
  const stepsBy = new Map<string, Date[]>();
  for (const s of input.steps) {
    const list = stepsBy.get(s.userId) ?? [];
    list.push(s.at);
    stepsBy.set(s.userId, list);
  }

  const shown = new Map<string, { sets: number; rows: number }>();
  const kindShown = new Map<string, number>();
  const kindTapped = new Map<string, number>();
  const stepTaps = new Map<string, { taps: number; offline: number }>();
  const exits = new Map<string, { chats: number; closed: number }>();
  const turns = new Map<string, number[]>();
  const chatSteps = new Map<string, { chats: number; offline: number }>();

  for (const chat of input.chats) {
    const arm = armOf(chat.userId, input);
    if (!arm) continue;
    const day = dayKey(chat.startedAt);
    if (!input.days.has(day)) continue;

    const armKey = `${day}|${arm}`;
    turns.set(armKey, [...(turns.get(armKey) ?? []), chat.userTurns]);
    const cs = chatSteps.get(armKey) ?? { chats: 0, offline: 0 };
    cs.chats++;
    if (stepWithin(stepsBy, chat.userId, chat.startedAt)) cs.offline++;
    chatSteps.set(armKey, cs);

    if (arm !== "chips") continue;
    const withChips = chat.sets.filter((s) => s.items.length > 0);
    const sh = shown.get(day) ?? { sets: 0, rows: 0 };
    sh.sets += withChips.length;
    sh.rows += chat.assistantRows;
    shown.set(day, sh);

    if (withChips.length > 0) {
      const ex = exits.get(day) ?? { chats: 0, closed: 0 };
      ex.chats++;
      if (withChips.some((s) => s.items.find((i) => i.id === s.tapped)?.kind === "close")) ex.closed++;
      exits.set(day, ex);
    }
    for (const set of withChips) {
      for (const kind of new Set(set.items.map((i) => i.kind))) {
        kindShown.set(`${day}|${kind}`, (kindShown.get(`${day}|${kind}`) ?? 0) + 1);
      }
      const tapped = set.items.find((i) => i.id === set.tapped);
      if (!tapped) continue;
      kindTapped.set(`${day}|${tapped.kind}`, (kindTapped.get(`${day}|${tapped.kind}`) ?? 0) + 1);
      if (tapped.kind === "step" && set.tappedAt) {
        const tapDay = dayKey(new Date(set.tappedAt));
        const st = stepTaps.get(tapDay) ?? { taps: 0, offline: 0 };
        st.taps++;
        if (stepWithin(stepsBy, chat.userId, new Date(set.tappedAt))) st.offline++;
        stepTaps.set(tapDay, st);
      }
    }
  }

  const rows: MetricRow[] = [];
  for (const [day, v] of shown) {
    if (v.rows > 0) rows.push({ day, metric: "agent_replies_shown_share", dim: "", value: v.sets / v.rows, n: v.rows });
  }
  for (const [key, n] of kindShown) {
    const [day, kind] = key.split("|") as [string, string];
    rows.push({ day, metric: "agent_replies_tap_rate", dim: kind, value: (kindTapped.get(key) ?? 0) / n, n });
  }
  for (const [day, v] of stepTaps) {
    if (input.days.has(day)) rows.push({ day, metric: "agent_replies_offline_step_7d", dim: "", value: v.offline / v.taps, n: v.taps });
  }
  for (const [day, v] of exits) {
    rows.push({ day, metric: "agent_replies_exit_share", dim: "", value: v.closed / v.chats, n: v.chats });
  }
  for (const [key, list] of turns) {
    const [day, arm] = key.split("|") as [string, string];
    rows.push({ day, metric: "agent_chat_turns_p50", dim: arm, value: median(list), n: list.length });
  }
  for (const [key, v] of chatSteps) {
    const [day, arm] = key.split("|") as [string, string];
    rows.push({ day, metric: "agent_chat_offline_step_7d", dim: arm, value: v.offline / v.chats, n: v.chats });
  }
  return rows;
}

/**
 * `replies_loop`: over the last seven complete days, chats with chips are more
 * than 20% longer than the holdout's while their offline-step share is not
 * higher. The feature is turning into a hook.
 */
export function detectRepliesLoop(input: RepliesRollupInput & { asOf: string; minSample: number }): InsightDraft[] {
  const asOfMs = Date.parse(`${input.asOf}T00:00:00Z`);
  const windowStart = asOfMs - 6 * 24 * 60 * 60 * 1000;
  const arms: Record<Arm, { turns: number[]; offline: number }> = {
    chips: { turns: [], offline: 0 },
    holdout: { turns: [], offline: 0 },
  };
  const stepsBy = new Map<string, Date[]>();
  for (const s of input.steps) stepsBy.set(s.userId, [...(stepsBy.get(s.userId) ?? []), s.at]);
  for (const chat of input.chats) {
    const t = chat.startedAt.getTime();
    if (t < windowStart || t >= asOfMs + 24 * 60 * 60 * 1000) continue;
    const arm = armOf(chat.userId, input);
    if (!arm) continue;
    arms[arm].turns.push(chat.userTurns);
    if (stepWithin(stepsBy, chat.userId, chat.startedAt)) arms[arm].offline++;
  }
  const n = Math.min(arms.chips.turns.length, arms.holdout.turns.length);
  if (n < input.minSample) return [];
  const chipsTurns = median(arms.chips.turns);
  const holdTurns = median(arms.holdout.turns);
  const chipsOffline = arms.chips.offline / arms.chips.turns.length;
  const holdOffline = arms.holdout.offline / arms.holdout.turns.length;
  if (holdTurns <= 0 || chipsTurns <= holdTurns * 1.2 || chipsOffline > holdOffline) return [];
  return [
    {
      key: "replies_loop:agent_chat",
      kind: "replies_loop",
      severity: 2,
      scope: "agent_chat",
      title: "Подсказки удлиняют разговор, а шагов в офлайн не больше — ужесточить проверки или выключить",
      value: chipsTurns,
      baseline: holdTurns,
      n,
      smallSample: false,
      evidence: {
        turnsP50: { chips: chipsTurns, holdout: holdTurns },
        offlineShare: { chips: chipsOffline, holdout: holdOffline },
        chats: { chips: arms.chips.turns.length, holdout: arms.holdout.turns.length },
      },
      codeHint: "apps/bot/src/services/suggested-replies.ts (chipsGate, chipsSystemPrompt)",
    },
  ];
}

/** Everything the nightly rollup needs, loaded once. */
export async function loadRepliesRollup(from: Date, to: Date, excluded: ReadonlySet<string>) {
  const chats = await loadReplyChats(from, to, excluded);
  const steps = await loadOfflineSteps(from, to, [...new Set(chats.map((c) => c.userId))]);
  return { chats, steps, eligible: suggestedRepliesUsers() };
}
