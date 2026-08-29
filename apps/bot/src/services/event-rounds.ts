/**
 * Party Mode — the in-event pairing engine (LAUNCH_EVENTS_PRODUCT_SPEC §9).
 *
 * Every ~35 minutes at a live event, everyone present who is not sitting out is
 * paired with someone they have not met yet tonight, given a named spot and a
 * two-digit code to say out loud, and left alone. There is no message field
 * anywhere in this file or the screen it feeds: Party Mode lives INSIDE the
 * NO IN-APP CHAT invariant rather than being a carve-out from it, because the
 * conversation it arranges happens in a room.
 *
 * The file is split pure-then-impure on purpose. Everything that decides WHO
 * is paired WITH WHOM is a function of its arguments, so it is tested without
 * a database, a clock or an event — and the tick below is thin enough that
 * reading it tells you the whole side-effect story.
 *
 * Three properties are load-bearing and each is easy to undo by accident:
 *
 *   1. **The allocator is the product's own** — `scorePair` + `greedyPair`,
 *      the same two functions the Thursday drop runs. §6.6 (Campus Radar)
 *      states the rule: a second pairing implementation is a second definition
 *      of a good match, and the two diverge silently. What differs here is the
 *      candidate SET and one softened factor, never the formula.
 *   2. **The league gate is lifted, not removed** (`EVENT_LEAGUE_FLOOR`). A
 *      mixer's job is breadth; `V_league` floors at 0.05 in the weekly engine,
 *      which at a party of forty people would quietly refuse most of the room.
 *      Lifting the floor keeps same-league pairs at 1.0 and stops a big
 *      attractiveness gap from being fatal.
 *   3. **Nothing here is ever penalised.** A lapsed round writes no Elo, no
 *      `silentIgnoreCount`, no `standbyCount` — an event is a party, not a
 *      contract, and the §3.1c rule that scripted outcomes must not become
 *      data applies with more force to outcomes nobody agreed to at all.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@gennety/db";
import {
  formatProfilerAnswersBlock,
  generateEventMissionsPrompt,
  scoreProfilerAnswers,
  t,
  type Language,
} from "@gennety/shared";

import {
  composeScore,
  computePairwiseDistances,
  greedyPair,
  loadExcludedPairs,
  preferencesAgree,
  scorePair,
  type BatchUser,
  type ScoredPair,
} from "./match-engine.js";
import { parseNumberedLines } from "./date-bump.js";
import { callOpenAIText } from "./openai.js";
import { sendPushToUser } from "./push.js";

const LOG_PREFIX = "[event-rounds]";

/**
 * The floor `V_league` is lifted to inside an event. The weekly engine floors
 * at 0.05, i.e. "effectively never matched" — correct when the product is
 * choosing ONE person for someone, and wrong in a room where the alternative
 * to a slightly mismatched pairing is standing alone for twenty minutes.
 */
export const EVENT_LEAGUE_FLOOR = 0.4;

/**
 * What one unpaired round is worth as a priority bump in the next one. Sits in
 * `composeScore`'s `starvationBonus` slot deliberately: it is the same idea
 * (someone the allocator passed over should be easier to pair next time),
 * scoped to the event and held in memory, so it can never leak into
 * `Profile.standbyCount` and distort the weekly famine measure.
 */
export const EVENT_SIT_OUT_BONUS = 0.08;

/** Cap the bump so a run of bad luck cannot outrank compatibility outright. */
export const EVENT_SIT_OUT_BONUS_CAP = 0.24;

export interface RoundConfig {
  /** Minutes between round openings. */
  intervalMin: number;
  /** How long a round stays open before it lapses. */
  durationMin: number;
  /** Minutes after `startsAt` that the first round opens. */
  firstRoundOffsetMin: number;
}

export interface RoundPlan {
  index: number;
  opensAt: Date;
  closesAt: Date;
}

/**
 * Which round is due right now, if any.
 *
 * A pure function of the event's own start time and the clock, so a round's
 * identity does not depend on when the worker happened to tick — two ticks a
 * minute apart inside the same window agree on the index, and `@@unique(
 * eventId, index)` turns that agreement into the double-open guard (§12).
 *
 * Returns null before the first round, after the event ends, and — the case
 * worth stating — in the gap BETWEEN rounds, which is most of the evening: a
 * round is open for `durationMin` of every `intervalMin`, and the rest is the
 * part where people are talking to each other rather than to their phones.
 */
export function planCurrentRound(
  event: { startsAt: Date; endsAt: Date },
  now: Date,
  config: RoundConfig,
): RoundPlan | null {
  const intervalMs = config.intervalMin * 60_000;
  const durationMs = config.durationMin * 60_000;
  if (intervalMs <= 0 || durationMs <= 0) return null;

  const firstOpensAt = event.startsAt.getTime() + config.firstRoundOffsetMin * 60_000;
  const elapsed = now.getTime() - firstOpensAt;
  if (elapsed < 0) return null;

  const index = Math.floor(elapsed / intervalMs) + 1; // 1-based
  const opensAt = new Date(firstOpensAt + (index - 1) * intervalMs);
  const closesAt = new Date(opensAt.getTime() + durationMs);

  // Past the window: we are between rounds, not in one.
  if (now.getTime() >= closesAt.getTime()) return null;
  // A round may not open after the event has ended, and may not run past it.
  if (opensAt.getTime() >= event.endsAt.getTime()) return null;

  return {
    index,
    opensAt,
    closesAt: closesAt > event.endsAt ? event.endsAt : closesAt,
  };
}

/** `"a:b"` — the house key convention, always written in both directions. */
export function pairKey(a: string, b: string): string {
  return `${a}:${b}`;
}

export interface RoundSelectionInput {
  /** Everyone checked in, not paused, not already in an unexpired pairing. */
  attendees: BatchUser[];
  /** Lifetime pair ban ∪ blocks, both directions (`loadExcludedPairs`). */
  excludedPairKeys: ReadonlySet<string>;
  /** Who has already met whom TONIGHT, both directions. */
  metThisEvent: ReadonlySet<string>;
  /** Cosine distances keyed `"a:b"` for the ordered pair as enumerated. */
  distances: ReadonlyMap<string, number>;
  /** How many rounds each attendee has sat out so far, for the priority bump. */
  sitOutCounts: ReadonlyMap<string, number>;
  leagueFloor?: number;
}

export interface RoundSelection {
  pairs: ScoredPair[];
  /** Everyone the allocator could not place — the odd one out, and anyone
   * whose only remaining partners are banned or already met tonight. */
  unpaired: string[];
}

/**
 * Choose this round's pairings.
 *
 * Pure: hand it the room and it tells you who talks to whom. The three
 * exclusions are applied at ENUMERATION rather than as a post-filter, so a
 * banned pair can never be the highest-scoring edge that starves a legal one.
 */
export function selectRoundPairings(input: RoundSelectionInput): RoundSelection {
  const floor = input.leagueFloor ?? EVENT_LEAGUE_FLOOR;
  const edges: ScoredPair[] = [];

  for (let i = 0; i < input.attendees.length; i += 1) {
    for (let j = i + 1; j < input.attendees.length; j += 1) {
      const a = input.attendees[i]!;
      const b = input.attendees[j]!;

      // Gender preference only — deliberately NOT `areMutuallyCompatible`,
      // whose same-city rule would exclude someone standing in the venue.
      if (!preferencesAgree(a, b)) continue;

      const key = pairKey(a.id, b.id);
      const mirror = pairKey(b.id, a.id);
      if (input.excludedPairKeys.has(key) || input.excludedPairKeys.has(mirror)) continue;
      if (input.metThisEvent.has(key) || input.metThisEvent.has(mirror)) continue;

      const distance = input.distances.get(key) ?? input.distances.get(mirror);
      // No embedding distance means no vector for one of them. Skipping is the
      // honest answer: `scorePair` would read the missing side as maximally
      // dissimilar, which is a claim about the person rather than about us.
      if (distance === undefined) continue;

      const scored = scorePair(a, b, distance);
      const sitOut =
        (input.sitOutCounts.get(a.id) ?? 0) + (input.sitOutCounts.get(b.id) ?? 0);
      const score = composeScore({
        ...scored.breakdown,
        league: Math.max(scored.breakdown.league, floor),
        // The weekly famine bonus is meaningless in a room and would import a
        // month of drop history into one evening's ordering; the party's own
        // sit-out bump takes the slot instead.
        starvationBonus: Math.min(sitOut * EVENT_SIT_OUT_BONUS, EVENT_SIT_OUT_BONUS_CAP),
      });

      edges.push({ userAId: a.id, userBId: b.id, score, breakdown: scored.breakdown });
    }
  }

  const pairs = greedyPair(edges);
  const placed = new Set<string>();
  for (const pair of pairs) {
    placed.add(pair.userAId);
    placed.add(pair.userBId);
  }

  return {
    pairs,
    unpaired: input.attendees.map((u) => u.id).filter((id) => !placed.has(id)),
  };
}

/**
 * Where each pair meets, and the two digits they say to find each other.
 *
 * Round-robin over the venue's spot list so a room of six spots spreads six
 * pairs across it rather than piling them on the bar. The code is unique
 * within the round only — it is a human handshake shouted across a room, not
 * an identifier, and two digits is what someone can hold in their head.
 */
export function assignSpots(
  pairs: readonly ScoredPair[],
  spots: readonly string[],
  roundIndex: number,
): Array<{ pair: ScoredPair; spotLabel: string; code: number }> {
  const list = spots.length > 0 ? spots : ["Somewhere in the room"];
  return pairs.map((pair, i) => ({
    pair,
    spotLabel: list[i % list.length]!,
    // 10..99, walked deterministically from the round index so two pairs in
    // one round never collide and the sequence is reproducible in a test.
    code: 10 + ((roundIndex * 7 + i * 13) % 90),
  }));
}

/**
 * Both mission lines for one pairing, in one model call.
 *
 * Fails OPEN by contract: the caller may render a card with no mission, and a
 * round must never block on OpenAI (§12). The static ladder is not a
 * placeholder for a better one — it is what the party gets when the model is
 * down, and it has to be worth reading on its own.
 */
export const STATIC_MISSIONS: Readonly<Record<string, readonly string[]>> = {
  en: [
    "Find out which of you has the worse taste in music. Settle it.",
    "Swap the best thing that happened to you this week.",
    "Agree on where you'd both rather be right now.",
  ],
  ru: [
    "Выясните, у кого из вас хуже вкус в музыке. Решите спор.",
    "Расскажите друг другу лучшее, что случилось с вами на этой неделе.",
    "Договоритесь, где вам обоим хотелось бы сейчас оказаться.",
  ],
  uk: [
    "З'ясуйте, у кого з вас гірший смак у музиці. Вирішіть суперечку.",
    "Розкажіть одне одному найкраще, що трапилося цього тижня.",
    "Домовтеся, де б вам обом хотілося зараз опинитися.",
  ],
  de: [
    "Findet heraus, wer von euch den schlechteren Musikgeschmack hat.",
    "Erzählt euch das Beste, was euch diese Woche passiert ist.",
    "Einigt euch darauf, wo ihr beide jetzt lieber wärt.",
  ],
  pl: [
    "Sprawdźcie, kto z was ma gorszy gust muzyczny. Rozstrzygnijcie to.",
    "Opowiedzcie sobie najlepszą rzecz z tego tygodnia.",
    "Ustalcie, gdzie wolelibyście teraz być.",
  ],
};

export function staticMission(language: string | null | undefined, seed: number): string {
  const lines = STATIC_MISSIONS[language ?? "en"] ?? STATIC_MISSIONS.en!;
  return lines[Math.abs(seed) % lines.length]!;
}

// ── Impure: the tick ─────────────────────────────────────────────────────

/** Prisma's own `select` for a party attendee, typed so a future field added
 * to `BatchUser` becomes a compile error HERE rather than a silent zero. */
const ATTENDEE_SELECT = {
  id: true,
  age: true,
  gender: true,
  major: true,
  preference: true,
  universityDomain: true,
  profile: {
    select: {
      height: true,
      negativeConstraints: true,
      psychologicalSummary: true,
      energyAxis: true,
      orientationAxis: true,
      eloScore: true,
      standbyCount: true,
      homeCityKey: true,
      ageRangeMin: true,
      ageRangeMax: true,
      typePrefTags: true,
      appearanceTags: true,
      relationshipIntents: true,
    },
  },
} satisfies Prisma.UserSelect;

/**
 * Load the people actually in the room as `BatchUser`s.
 *
 * Deliberately NOT `loadEligibleUsers` and not `previewDropBatch`: those carry
 * the MATCHING pool's eligibility — the 24h candidate cooldown, the
 * single-live-match rule, the contact rail. Every one of those is wrong here.
 * Someone with a date already scheduled for Friday is exactly the sort of
 * person who should still be talking to people at a mixer on Wednesday, and
 * refusing to pair them would be the product enforcing a rule about matching
 * against an event that is not matching.
 *
 * What it does share is the field list: the mapping is typed as `BatchUser`,
 * so a field added to that interface fails to compile here rather than
 * arriving as an undefined the scorer reads as a zero.
 */
export async function loadAttendees(userIds: readonly string[]): Promise<BatchUser[]> {
  if (userIds.length === 0) return [];

  const rows = await prisma.user.findMany({
    where: { id: { in: [...userIds] } },
    select: ATTENDEE_SELECT,
  });

  const embeddingRows = await prisma.$queryRawUnsafe<
    Array<{ user_id: string; embedding: string | null }>
  >(
    `SELECT user_id, embedding::text AS embedding FROM profiles WHERE user_id = ANY($1::uuid[])`,
    rows.map((r) => r.id),
  );
  const embeddings = new Map(embeddingRows.map((r) => [r.user_id, r.embedding]));

  const attendees: BatchUser[] = [];
  for (const row of rows) {
    const embedding = embeddings.get(row.id);
    if (!embedding) continue; // No vector — cannot be scored, see above.
    attendees.push({
      id: row.id,
      age: row.age,
      gender: row.gender,
      major: row.major,
      preference: row.preference,
      universityDomain: row.universityDomain,
      height: row.profile?.height ?? null,
      negativeConstraints: row.profile?.negativeConstraints ?? null,
      psychologicalSummary: row.profile?.psychologicalSummary ?? null,
      energyAxis: row.profile?.energyAxis ?? null,
      orientationAxis: row.profile?.orientationAxis ?? null,
      embeddingLiteral: embedding,
      eloScore: row.profile?.eloScore ?? 500,
      standbyCount: row.profile?.standbyCount ?? 0,
      homeCityKey: row.profile?.homeCityKey ?? null,
      ageRangeMin: row.profile?.ageRangeMin ?? null,
      ageRangeMax: row.profile?.ageRangeMax ?? null,
      typePrefTags: row.profile?.typePrefTags ?? null,
      appearanceTags: row.profile?.appearanceTags ?? null,
      relationshipIntents: row.profile?.relationshipIntents ?? [],
    });
  }
  return attendees;
}

export { LOG_PREFIX as EVENT_ROUNDS_LOG_PREFIX };

// ── The tick ─────────────────────────────────────────────────────────────

/**
 * How many rounds each attendee has sat out, per event, held in memory.
 *
 * In memory on purpose, and this is the mirror image of `EventTicket.pausedAt`
 * next door: losing this counter fails in the SAFE direction (someone's
 * priority bump resets and they are paired on merit, which is the ordinary
 * case anyway), while losing an opt-out fails in the unsafe one. So the rule
 * from DECISIONS applies cleanly — before relying on an in-memory map, ask
 * what happens when it is gone, and only accept the answer if it is harmless.
 *
 * Cleared when an event stops being live, so a venue that runs a party a week
 * cannot accumulate a map.
 */
const sitOutByEvent = new Map<string, Map<string, number>>();

export function resetEventRoundMemory(eventId?: string): void {
  if (eventId) sitOutByEvent.delete(eventId);
  else sitOutByEvent.clear();
}

export interface EventRoundTickResult {
  eventsScanned: number;
  roundsOpened: number;
  roundsClosed: number;
  pairingsCreated: number;
  unpaired: number;
}

export interface EventRoundDeps {
  /** Injected so the tick is testable without APNs and so the demo can replay. */
  notify?: (userId: string, payload: EventRoundNotification) => Promise<void>;
  /** Injected so a test never reaches OpenAI. */
  missions?: (input: MissionRequest) => Promise<[string, string]>;
  config?: Partial<RoundConfig>;
}

export interface EventRoundNotification {
  eventId: string;
  roundIndex: number;
  spotLabel: string;
  code: number;
  partnerFirstName: string | null;
  mission: string | null;
  language: string | null;
}

export interface MissionRequest {
  a: MissionParticipant;
  b: MissionParticipant;
  minutes: number;
  seed: number;
}

export interface MissionParticipant {
  id: string;
  firstName: string | null;
  language: string | null;
  summary: string | null;
  profilerBlock: string | null;
}

export const DEFAULT_ROUND_CONFIG: RoundConfig = {
  intervalMin: 35,
  durationMin: 20,
  firstRoundOffsetMin: 30,
};

/**
 * Open whatever round is due and close whatever has lapsed, for every live
 * event. Idempotent by construction: `planCurrentRound` is a pure function of
 * the clock, and `@@unique([eventId, index])` makes the create-round-and-its-
 * pairings transaction the thing that either wins or writes nothing at all.
 */
export async function runEventRoundTick(
  now: Date = new Date(),
  deps: EventRoundDeps = {},
): Promise<EventRoundTickResult> {
  const config = { ...DEFAULT_ROUND_CONFIG, ...(deps.config ?? {}) };
  const result: EventRoundTickResult = {
    eventsScanned: 0,
    roundsOpened: 0,
    roundsClosed: 0,
    pairingsCreated: 0,
    unpaired: 0,
  };

  const live = await prisma.event.findMany({
    where: { status: "live" },
    select: { id: true, startsAt: true, endsAt: true },
  });
  result.eventsScanned = live.length;

  // Close first. A round that has lapsed must stop being "open" before the next
  // one is created, or a client polling mid-tick briefly sees two.
  const closed = await prisma.eventRound.updateMany({
    where: { status: "open", closesAt: { lte: now }, eventId: { in: live.map((e) => e.id) } },
    data: { status: "closed" },
  });
  result.roundsClosed = closed.count;

  for (const event of live) {
    const plan = planCurrentRound(event, now, config);
    if (!plan) continue;

    const existing = await prisma.eventRound.findUnique({
      where: { eventId_index: { eventId: event.id, index: plan.index } },
      select: { id: true },
    });
    if (existing) continue; // Already open (or closed) — this tick has nothing to do.

    const opened = await openRound(event, plan, config, deps);
    if (opened.created > 0) result.roundsOpened += 1;
    result.pairingsCreated += opened.created;
    result.unpaired += opened.unpaired;
  }

  return result;
}

async function openRound(
  event: { id: string; startsAt: Date; endsAt: Date },
  plan: RoundPlan,
  config: RoundConfig,
  deps: EventRoundDeps,
): Promise<{ created: number; unpaired: number }> {
  const tickets = await prisma.eventTicket.findMany({
    where: { eventId: event.id, status: "checked_in", pausedAt: null },
    select: { userId: true },
  });
  const attendeeIds = tickets.map((t) => t.userId);
  // One person in the room is not a round. Creating an empty one would burn
  // the index and make the NEXT tick think this round already happened.
  if (attendeeIds.length < 2) return { created: 0, unpaired: 0 };

  const [attendees, excludedPairKeys, priorPairings] = await Promise.all([
    loadAttendees(attendeeIds),
    loadExcludedPairs(attendeeIds),
    prisma.eventRoundPairing.findMany({
      where: { eventId: event.id },
      select: { userAId: true, userBId: true },
    }),
  ]);
  if (attendees.length < 2) return { created: 0, unpaired: 0 };

  const metThisEvent = new Set<string>();
  for (const p of priorPairings) {
    metThisEvent.add(pairKey(p.userAId, p.userBId));
    metThisEvent.add(pairKey(p.userBId, p.userAId));
  }

  const distances = await computePairwiseDistances(attendees);
  const sitOutCounts = sitOutByEvent.get(event.id) ?? new Map<string, number>();

  const selection = selectRoundPairings({
    attendees,
    excludedPairKeys,
    metThisEvent,
    distances,
    sitOutCounts,
  });
  if (selection.pairs.length === 0) return { created: 0, unpaired: selection.unpaired.length };

  const spots = await loadEventSpots(event.id);
  const assigned = assignSpots(selection.pairs, spots, plan.index);

  const profiles = await loadMissionParticipants(attendeeIds);
  const missionFor = deps.missions ?? generateMissions;
  const missions = await mapWithConcurrency(assigned, 5, async (entry, i) => {
    const a = profiles.get(entry.pair.userAId);
    const b = profiles.get(entry.pair.userBId);
    if (!a || !b) return ["", ""] as [string, string];
    try {
      return await missionFor({ a, b, minutes: config.durationMin, seed: plan.index + i });
    } catch (err) {
      console.error(`${LOG_PREFIX} mission generation failed:`, err);
      return [
        staticMission(a.language, plan.index + i),
        staticMission(b.language, plan.index + i),
      ] as [string, string];
    }
  });

  let roundId: string;
  try {
    roundId = await prisma.$transaction(async (tx) => {
      const round = await tx.eventRound.create({
        data: {
          eventId: event.id,
          index: plan.index,
          opensAt: plan.opensAt,
          closesAt: plan.closesAt,
          status: "open",
        },
        select: { id: true },
      });
      await tx.eventRoundPairing.createMany({
        data: assigned.map((entry, i) => ({
          roundId: round.id,
          eventId: event.id,
          userAId: entry.pair.userAId,
          userBId: entry.pair.userBId,
          spotLabel: entry.spotLabel,
          code: entry.code,
          missionA: missions[i]?.[0] || null,
          missionB: missions[i]?.[1] || null,
        })),
      });
      return round.id;
    });
  } catch (err) {
    // The unique index did its job: another tick opened this round while we
    // were talking to OpenAI. Its pairings are the real ones; ours were never
    // written, so there is nothing to undo and nothing to announce.
    console.warn(`${LOG_PREFIX} round ${plan.index} for ${event.id} already opened:`, err);
    return { created: 0, unpaired: 0 };
  }

  // Sit-out bookkeeping AFTER the round is durable, so a lost race cannot
  // inflate anyone's priority for a round that never existed.
  const counts = sitOutByEvent.get(event.id) ?? new Map<string, number>();
  for (const id of selection.unpaired) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const entry of assigned) {
    counts.delete(entry.pair.userAId);
    counts.delete(entry.pair.userBId);
  }
  sitOutByEvent.set(event.id, counts);

  await deliverRound(event.id, plan.index, assigned, missions, profiles, deps);
  console.log(
    `${LOG_PREFIX} event=${event.id} round=${plan.index} paired=${assigned.length} unpaired=${selection.unpaired.length} roundId=${roundId}`,
  );
  return { created: assigned.length, unpaired: selection.unpaired.length };
}

async function deliverRound(
  eventId: string,
  roundIndex: number,
  assigned: ReturnType<typeof assignSpots>,
  missions: Array<[string, string]>,
  profiles: Map<string, MissionParticipant>,
  deps: EventRoundDeps,
): Promise<void> {
  const notify = deps.notify ?? sendRoundPush;
  const sends: Array<Promise<void>> = [];

  assigned.forEach((entry, i) => {
    const a = profiles.get(entry.pair.userAId);
    const b = profiles.get(entry.pair.userBId);
    const base = { eventId, roundIndex, spotLabel: entry.spotLabel, code: entry.code };
    sends.push(
      notify(entry.pair.userAId, {
        ...base,
        partnerFirstName: b?.firstName ?? null,
        mission: missions[i]?.[0] || null,
        language: a?.language ?? null,
      }).catch((err) => console.error(`${LOG_PREFIX} notify failed:`, err)),
    );
    sends.push(
      notify(entry.pair.userBId, {
        ...base,
        partnerFirstName: a?.firstName ?? null,
        mission: missions[i]?.[1] || null,
        language: b?.language ?? null,
      }).catch((err) => console.error(`${LOG_PREFIX} notify failed:`, err)),
    );
  });

  await Promise.all(sends);
}

async function loadEventSpots(eventId: string): Promise<string[]> {
  const tiers = await prisma.eventTicketTier.findMany({
    where: { eventId },
    select: { title: true },
  });
  // v1: the venue's spot list is not its own admin surface yet, so the room is
  // divided by the tier titles the founder already named. Stated rather than
  // hidden — a real spot list is one admin field, and until it exists a party
  // with one tier puts everyone in one place, which is honest for a small room.
  return tiers.map((t) => t.title);
}

async function loadMissionParticipants(
  userIds: readonly string[],
): Promise<Map<string, MissionParticipant>> {
  const rows = await prisma.user.findMany({
    where: { id: { in: [...userIds] } },
    select: {
      id: true,
      firstName: true,
      language: true,
      profile: { select: { psychologicalSummary: true } },
      profilerAnswers: {
        select: { questionId: true, answerText: true, priority: true, skipped: true },
      },
    },
  });

  const map = new Map<string, MissionParticipant>();
  for (const row of rows) {
    const scored = scoreProfilerAnswers(
      row.profilerAnswers.map((a) => ({
        questionId: a.questionId,
        answerText: a.answerText,
        priority: a.priority as never,
        skipped: a.skipped,
      })),
    );
    const language = (row.language ?? "en") as Language;
    map.set(row.id, {
      id: row.id,
      firstName: row.firstName,
      language,
      summary: row.profile?.psychologicalSummary ?? null,
      profilerBlock: formatProfilerAnswersBlock(scored, language) || null,
    });
  }
  return map;
}

async function generateMissions(input: MissionRequest): Promise<[string, string]> {
  const language = (input.a.language ?? "en") as Language;
  const fallback: [string, string] = [
    staticMission(input.a.language, input.seed),
    staticMission(input.b.language, input.seed + 1),
  ];

  const prompt = generateEventMissionsPrompt({
    aFirstName: input.a.firstName ?? "",
    bFirstName: input.b.firstName ?? "",
    aSummary: input.a.summary,
    bSummary: input.b.summary,
    aProfilerBlock: input.a.profilerBlock,
    bProfilerBlock: input.b.profilerBlock,
    language,
    minutes: input.minutes,
  });

  const raw = await callOpenAIText(prompt, "Write the two missions now.", { maxTokens: 200 });
  const lines = parseNumberedLines(raw);
  // Two lines or the static pair — a single line would give one side a mission
  // and the other nothing, which reads as a bug rather than as brevity.
  return lines.length >= 2 ? [lines[0]!, lines[1]!] : fallback;
}

async function sendRoundPush(userId: string, n: EventRoundNotification): Promise<void> {
  const language = (n.language ?? "en") as Language;
  const title = t(language, "eventRoundPushTitle");
  const body = t(language, "eventRoundPushBody", {
    name: n.partnerFirstName ?? t(language, "eventRoundPushSomeone"),
    spot: n.spotLabel,
    code: String(n.code),
  });
  await sendPushToUser(userId, {
    title,
    body,
    // NOT in TIME_SENSITIVE_PUSH_TYPES, deliberately: the recipient is at a
    // party with their phone in their hand. Punching through Focus is for
    // something that matters when nobody is looking at the screen.
    data: { type: "event.round", eventId: n.eventId, roundIndex: n.roundIndex },
  });
}

/** Bounded fan-out — a party of forty is twenty model calls per round. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
