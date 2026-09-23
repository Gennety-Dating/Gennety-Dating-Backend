import { createHash } from "node:crypto";
import { prisma } from "@gennety/db";
import {
  SUPPORTED_LANGUAGES,
  t,
  TIME_AGREEMENT_ACTIVITY_NAME_MAX_CHARS,
  TIME_AGREEMENT_ACTIVITY_RESOLVED_DISMISS_MINUTES,
  TIME_AGREEMENT_ACTIVITY_RESTART_HOURS,
  TIME_AGREEMENT_ACTIVITY_SLOTS_MAX,
  type Language,
} from "@gennety/shared";
import { isSlotSelectable } from "../handlers/matching/scheduler.js";
import { resolveZone, zonedParts } from "./profiler-schedule.js";
import { LOCALE_TAGS } from "./datetime-entity.js";
import {
  apnsConfigured,
  type LiveActivityStartInput,
  type LiveActivityUpdateInput,
} from "./apns.js";
import { sendLiveActivityStartToUser, sendLiveActivityUpdateToUser } from "./push.js";
import { isUniqueViolation } from "./ticket-wallet.js";

/**
 * The time-agreement lock-screen card — the iOS `time_agreement` Live Activity
 * (decision 2026-09-23, founder's time-agreement screen approved 2026-09-22).
 *
 * The §3.6 twin of `venue-change-activity.ts`, and built the same way for the
 * same reasons; read that file's header first, this one only states what
 * differs. One card per person per match, showing the calendar from THAT
 * person's side. Three phases, in priority order:
 *
 *   `match`   — the time just locked (`negotiating_venue` / `scheduled` with an
 *               `agreedTime`). Sent as the card's END, with a 15-minute linger
 *               so it can be read.
 *   `partner` — the calendar is open and the partner has marked a time I have
 *               not ("your move").
 *   `waiting` — the calendar is open, I have marked and the partner has not.
 *
 * Anything else ends the card at once: no grid yet, nobody has marked, the
 * match is cancelled or expired, or every mark has slipped inside the five-hour
 * lead.
 *
 * **Why this card exists at all.** A native user got NO notification when the
 * partner proposed a time or when the time locked — the whole of §3.6 was
 * announced over Telegram, which a mobile-first account does not have. So,
 * unlike the venue twin, this card's UPDATE can carry an alert
 * (`LiveActivityUpdateInput.alert`), and it does so under one rule: only when
 * the card becomes or stays "your move" BECAUSE THE PARTNER MOVED. My own edits
 * never buzz at me, which is why the partner's slots are hashed separately from
 * the content (`time_agreement_activities.partner_hash`) — inside one content
 * hash "they added a time" and "I added a time" are the same event.
 *
 * **The lock screen names the partner**, the same founder exception the venue
 * card carries (first name only, nominative, no photo, no age).
 */

export const TIME_AGREEMENT_ACTIVITY_TYPE = "time_agreement" as const;

/**
 * The Swift `ActivityAttributes` type name, verbatim — ActivityKit resolves a
 * push-to-start by this string and silently drops one it cannot match.
 */
export const TIME_AGREEMENT_ATTRIBUTES_TYPE = "TimeAgreementActivity";

export type TimeAgreementPhase = "waiting" | "partner" | "match";

/**
 * The card's mutable half, exactly as the Swift `ContentState` declares it —
 * key for key, in this order. Every key is always present (null / [] when it
 * does not apply) so the client decodes it with a plain `Codable` struct.
 *
 * Times are UNIX SECONDS, ascending. Not ISO strings: the payload has an
 * undocumented 4096-byte ceiling above which Apple drops it without an error,
 * and four numbers cost a quarter of four timestamps.
 */
export interface TimeAgreementContentState {
  phase: TimeAgreementPhase;
  partnerFirstName: string | null;
  partnerGender: "male" | "female" | null;
  /** My own still-offerable marks, the earliest two. */
  mySlots: number[];
  /** The partner's still-offerable marks I have NOT made, the earliest two. */
  partnerSlots: number[];
  /** Set only on the `match` end. */
  agreedTime: number | null;
  /** The recipient's own zone — the clock the app draws these instants on. */
  timeZone: string | null;
}

/** One side's calendar, reduced to what its card needs. */
export interface TimeAgreementSideState {
  userId: string;
  language: string | null;
  timeZone: string | null;
  partnerFirstName: string | null;
  partnerGender: string | null;
  /** The match's own status — `negotiating` is the live calendar. */
  status: string;
  /** `startScheduling` has written the grid. */
  gridOpen: boolean;
  /** My marks that are still offerable (outside the five-hour lead). */
  mySlots: Date[];
  /** The partner's offerable marks, mine included — the derivation subtracts. */
  peerSlots: Date[];
  agreedTime: Date | null;
}

export type DesiredTimeAgreementActivity =
  | { kind: "show"; content: TimeAgreementContentState }
  | {
      kind: "none";
      /** Set when the time LOCKED — the card lingers briefly to be read. */
      resolution: "locked" | null;
      /** What the card says while it lingers; null keeps its last look. */
      finalContent: TimeAgreementContentState | null;
    };

/**
 * The statuses in which a locked time is still news worth ending the card on.
 *
 * Deliberately not "anything past `negotiating`". A `cancelled` or `expired`
 * match has no time to celebrate, and a `completed` one is a date that already
 * happened — all three end the card the plain way, with no linger.
 */
const LOCKED_STATUSES = new Set(["negotiating_venue", "scheduled"]);

const NONE: DesiredTimeAgreementActivity = { kind: "none", resolution: null, finalContent: null };

function unixSeconds(date: Date | null): number | null {
  return date ? Math.floor(date.getTime() / 1000) : null;
}

function unixSecondsList(dates: Date[]): number[] {
  return dates
    .slice()
    .sort((a, b) => a.getTime() - b.getTime())
    .slice(0, TIME_AGREEMENT_ACTIVITY_SLOTS_MAX)
    .map((d) => Math.floor(d.getTime() / 1000));
}

function clipName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > TIME_AGREEMENT_ACTIVITY_NAME_MAX_CHARS
    ? `${trimmed.slice(0, TIME_AGREEMENT_ACTIVITY_NAME_MAX_CHARS - 1).trimEnd()}…`
    : trimmed;
}

function genderOf(raw: string | null): "male" | "female" | null {
  return raw === "male" || raw === "female" ? raw : null;
}

/** Builds the content in ONE key order, so equal content hashes equally. */
function contentState(
  side: TimeAgreementSideState,
  fields: { phase: TimeAgreementPhase; mySlots?: Date[]; partnerSlots?: Date[]; agreedTime?: Date | null },
): TimeAgreementContentState {
  const firstName = side.partnerFirstName?.trim();
  return {
    phase: fields.phase,
    partnerFirstName: firstName ? clipName(firstName) : null,
    partnerGender: genderOf(side.partnerGender),
    mySlots: unixSecondsList(fields.mySlots ?? []),
    partnerSlots: unixSecondsList(fields.partnerSlots ?? []),
    agreedTime: unixSeconds(fields.agreedTime ?? null),
    timeZone: side.timeZone,
  };
}

/**
 * What one side's card should show right now. Pure.
 *
 * **The overlap that is waiting on a final pick shows nothing** — both sides
 * marked the same two times, so neither is "waiting" (either of them can close
 * it by re-submitting one) and neither has a new time from the other to look
 * at. The app is where that gets settled, exactly as the venue board's
 * `/confirm` overlap is.
 */
export function deriveTimeAgreementActivity(
  side: TimeAgreementSideState,
): DesiredTimeAgreementActivity {
  if (LOCKED_STATUSES.has(side.status) && side.agreedTime) {
    return {
      kind: "none",
      resolution: "locked",
      finalContent: contentState(side, { phase: "match", agreedTime: side.agreedTime }),
    };
  }
  if (side.status !== "negotiating" || !side.gridOpen) return NONE;

  const mine = new Set(side.mySlots.map((d) => d.getTime()));
  const partnerOnly = side.peerSlots.filter((d) => !mine.has(d.getTime()));
  if (partnerOnly.length > 0) {
    return {
      kind: "show",
      content: contentState(side, {
        phase: "partner",
        mySlots: side.mySlots,
        partnerSlots: partnerOnly,
      }),
    };
  }
  if (side.mySlots.length > 0 && side.peerSlots.length === 0) {
    return { kind: "show", content: contentState(side, { phase: "waiting", mySlots: side.mySlots }) };
  }
  return NONE;
}

export interface TimeAgreementActivityUser {
  id: string;
  language: string | null;
  firstName: string | null;
  gender: string | null;
  profile: { timeZone: string | null } | null;
}

export interface TimeAgreementActivityMatch {
  id: string;
  status: string;
  proposedTimes: Date[];
  availableTimesA: Date[];
  availableTimesB: Date[];
  agreedTime: Date | null;
  userA: TimeAgreementActivityUser;
  userB: TimeAgreementActivityUser;
}

const USER_SELECT = {
  id: true,
  language: true,
  firstName: true,
  gender: true,
  profile: { select: { timeZone: true } },
} as const;

export function loadTimeAgreementActivityMatch(
  matchId: string,
): Promise<TimeAgreementActivityMatch | null> {
  return prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      status: true,
      proposedTimes: true,
      availableTimesA: true,
      availableTimesB: true,
      agreedTime: true,
      userA: { select: USER_SELECT },
      userB: { select: USER_SELECT },
    },
  }) as unknown as Promise<TimeAgreementActivityMatch | null>;
}

/**
 * One side's slice. `isSlotSelectable` is the calendar's own rule, imported
 * rather than re-stated: a mark that has slipped inside the five-hour lead is
 * no longer offerable, so it must stop counting here too — otherwise the card
 * would keep saying "your move" about a time the server would now refuse.
 */
export function timeAgreementSideState(
  match: TimeAgreementActivityMatch,
  side: "A" | "B",
  now: Date,
): TimeAgreementSideState {
  const isA = side === "A";
  const me = isA ? match.userA : match.userB;
  const peer = isA ? match.userB : match.userA;
  const offerable = (slots: Date[]) => slots.filter((d) => isSlotSelectable(d, now));
  return {
    userId: me.id,
    language: me.language,
    timeZone: me.profile?.timeZone ?? null,
    partnerFirstName: peer.firstName,
    partnerGender: peer.gender,
    status: match.status,
    gridOpen: match.proposedTimes.length > 0,
    mySlots: offerable(isA ? match.availableTimesA : match.availableTimesB),
    peerSlots: offerable(isA ? match.availableTimesB : match.availableTimesA),
    agreedTime: match.agreedTime,
  };
}

/** Both sides' desired cards for one match row. Pure. */
export function desiredTimeAgreementActivities(
  match: TimeAgreementActivityMatch,
  now: Date,
): Record<
  "A" | "B",
  { userId: string; state: TimeAgreementSideState; desired: DesiredTimeAgreementActivity }
> {
  const one = (side: "A" | "B") => {
    const state = timeAgreementSideState(match, side, now);
    return { userId: state.userId, state, desired: deriveTimeAgreementActivity(state) };
  };
  return { A: one("A"), B: one("B") };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** What was last sent to one side (`time_agreement_activities`). */
export interface TimeAgreementActivityRecord {
  phase: string;
  contentHash: string;
  /** Hash of `partnerSlots` alone — the only change that may raise an alert. */
  partnerHash: string;
  startedAt: Date;
}

export type TimeAgreementActivityOp =
  | { op: "noop" }
  | {
      op: "start" | "update" | "restart";
      content: TimeAgreementContentState;
      hash: string;
      partnerHash: string;
      /** The update must ring: the partner moved and it is now my turn. */
      alert: boolean;
    }
  | {
      op: "end";
      dismiss: "resolved" | "now";
      finalContent: TimeAgreementContentState | null;
      /** The end must ring: the time locked and this side was the one waiting. */
      alert: boolean;
    };

const RESTART_AFTER_MS = TIME_AGREEMENT_ACTIVITY_RESTART_HOURS * 60 * 60 * 1000;

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

export function timeAgreementContentHash(content: TimeAgreementContentState): string {
  return hashOf(content);
}

/** The partner's half of the card, hashed apart — see the file header. */
export function timeAgreementPartnerHash(content: TimeAgreementContentState): string {
  return hashOf(content.partnerSlots);
}

/**
 * start / update / restart / end / nothing, and whether it rings. Pure.
 *
 * The restart is the venue card's, verbatim: iOS freezes a Live Activity 8
 * hours after it started while a calendar stays open for up to 48, so a card
 * that still applies at 7.5h is ended and push-started afresh. Checked BEFORE
 * the content comparison — an unchanged card is exactly the one that would
 * otherwise go dead.
 *
 * **The two alert rules, and they are the point of this card:**
 *  - an UPDATE rings only when the new phase is `partner` AND either the stored
 *    phase was not `partner` or the partner's slots changed. So "they proposed
 *    a time" rings and "I edited my own picks" does not, even though both
 *    rewrite the content.
 *  - the END that carries `match` rings only for the side whose STORED phase
 *    was `waiting` — that side did not act, so the lock is news to them; the
 *    other side is the one who just tapped it.
 */
export function decideTimeAgreementActivity(
  record: TimeAgreementActivityRecord | null,
  desired: DesiredTimeAgreementActivity,
  now: Date,
): TimeAgreementActivityOp {
  if (desired.kind === "none") {
    if (!record) return { op: "noop" };
    return {
      op: "end",
      dismiss: desired.resolution ? "resolved" : "now",
      finalContent: desired.finalContent,
      alert: desired.resolution === "locked" && record.phase === "waiting",
    };
  }
  const hash = timeAgreementContentHash(desired.content);
  const partnerHash = timeAgreementPartnerHash(desired.content);
  if (!record) return { op: "start", content: desired.content, hash, partnerHash, alert: true };
  if (now.getTime() - record.startedAt.getTime() >= RESTART_AFTER_MS) {
    return { op: "restart", content: desired.content, hash, partnerHash, alert: true };
  }
  if (record.contentHash === hash) return { op: "noop" };
  return {
    op: "update",
    content: desired.content,
    hash,
    partnerHash,
    alert:
      desired.content.phase === "partner" &&
      (record.phase !== "partner" || record.partnerHash !== partnerHash),
  };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

function languageOf(raw: string | null): Language {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(raw ?? "")
    ? (raw as Language)
    : "en";
}

/**
 * "ср, 18:30" — a slot on the RECIPIENT's wall clock, in their language.
 *
 * The zone is the recipient's own (`profile.timeZone`, the same value the
 * calendar GET returns), falling back to the market's. The weekday is dropped
 * when the slot is today: "сегодня в 18:30" is what the phrase already means to
 * someone reading it at 13:00, and a weekday there reads as a different day.
 */
export function timeAgreementSlotPhrase(
  slotSeconds: number,
  lang: Language,
  timeZone: string | null,
  now: Date,
): string {
  // `resolveZone` falls back to `DEFAULT_TIME_ZONE`, which IS `CALENDAR_TIME_ZONE`
  // — the market the grid is written in, and the right clock for a profile that
  // has no city resolved yet.
  const zone = resolveZone(timeZone);
  const slot = new Date(slotSeconds * 1000);
  const a = zonedParts(slot, zone);
  const b = zonedParts(now, zone);
  const today = a.year === b.year && a.month === b.month && a.day === b.day;
  return new Intl.DateTimeFormat(LOCALE_TAGS[lang], {
    ...(today ? {} : { weekday: "short" as const }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: zone,
  }).format(slot);
}

/**
 * The alert a push-to-start must carry (Apple requires one), and the one an
 * update or end carries when it has news. Short, in the recipient's own
 * language, and the partner's name only ever as the SUBJECT — the server
 * declines no names, so nothing here may need a case.
 */
export function timeAgreementAlert(
  lang: Language,
  content: TimeAgreementContentState,
  now: Date,
): { title: string; body: string } {
  const title = t(lang, "timeActivityStartTitle");
  const name = content.partnerFirstName;
  const when = (seconds: number | null | undefined): string =>
    seconds == null ? "" : timeAgreementSlotPhrase(seconds, lang, content.timeZone, now);
  switch (content.phase) {
    case "partner":
      return {
        title,
        body: t(lang, "timeActivityStartPartner", {
          name: name ?? t(lang, "venueActivityPartnerFallback"),
          when: when(content.partnerSlots[0]),
        }),
      };
    case "waiting":
      return {
        title,
        body: name
          ? t(lang, "timeActivityStartWaiting", { name })
          : t(lang, "timeActivityStartWaitingNoName"),
      };
    case "match":
      return { title, body: t(lang, "timeActivityStartMatch", { when: when(content.agreedTime) }) };
  }
}

export function timeAgreementStartInput(
  matchId: string,
  content: TimeAgreementContentState,
  lang: Language,
  now: Date,
): LiveActivityStartInput {
  return {
    attributesType: TIME_AGREEMENT_ATTRIBUTES_TYPE,
    attributes: { matchId },
    contentState: content as unknown as Record<string, unknown>,
    alert: timeAgreementAlert(lang, content, now),
  };
}

/**
 * An update. No `stale-date`: unlike the venue board, whose cutoff is a real
 * instant the card counts down to, nothing here expires at a known moment —
 * marks slip inside the five-hour lead one by one, and the 2-minute sweep
 * re-derives the card when they do.
 */
export function timeAgreementUpdateInput(
  content: TimeAgreementContentState,
  alert: { title: string; body: string } | null,
): LiveActivityUpdateInput {
  return {
    event: "update",
    contentState: content as unknown as Record<string, unknown>,
    ...(alert ? { alert } : {}),
  };
}

/**
 * The end. A LOCKED time lingers for a few minutes so it can be read; a
 * calendar that merely closed leaves at once (a dismissal date of "now" — an
 * end without one sits on the lock screen for up to four hours).
 */
export function timeAgreementEndInput(
  dismiss: "resolved" | "now",
  finalContent: TimeAgreementContentState | null,
  now: Date,
  alert: { title: string; body: string } | null = null,
): LiveActivityUpdateInput {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return {
    event: "end",
    ...(finalContent ? { contentState: finalContent as unknown as Record<string, unknown> } : {}),
    dismissalDate:
      dismiss === "resolved"
        ? nowSeconds + TIME_AGREEMENT_ACTIVITY_RESOLVED_DISMISS_MINUTES * 60
        : nowSeconds,
    ...(alert ? { alert } : {}),
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Push-start a card. The row is written FIRST, as a claim — a second
 * push-to-start would not replace the running card, it would open another one
 * beside it — and released if APNs did not take the push, so the next calendar
 * write tries again. Users without a `start` token (every Telegram-only
 * account) cost one lookup and no write.
 */
async function startCard(
  matchId: string,
  side: TimeAgreementSideState,
  op: { content: TimeAgreementContentState; hash: string; partnerHash: string },
  now: Date,
): Promise<void> {
  const startToken = await prisma.liveActivityToken.findUnique({
    where: {
      userId_activityType_kind: {
        userId: side.userId,
        activityType: TIME_AGREEMENT_ACTIVITY_TYPE,
        kind: "start",
      },
    },
    select: { id: true },
  });
  if (!startToken) return;

  try {
    await prisma.timeAgreementActivity.create({
      data: {
        matchId,
        userId: side.userId,
        phase: op.content.phase,
        contentHash: op.hash,
        partnerHash: op.partnerHash,
        startedAt: now,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return; // another sync started it first
    throw err;
  }

  const sent = await sendLiveActivityStartToUser(
    side.userId,
    TIME_AGREEMENT_ACTIVITY_TYPE,
    timeAgreementStartInput(matchId, op.content, languageOf(side.language), now),
  ).catch(() => false);
  if (!sent) {
    await prisma.timeAgreementActivity
      .deleteMany({
        where: { matchId, userId: side.userId, contentHash: op.hash, startedAt: now },
      })
      .catch(() => undefined);
  }
}

async function applyOp(
  matchId: string,
  side: TimeAgreementSideState,
  record: TimeAgreementActivityRecord | null,
  op: TimeAgreementActivityOp,
  now: Date,
): Promise<void> {
  const userId = side.userId;
  const lang = languageOf(side.language);

  switch (op.op) {
    case "noop":
      return;

    case "start":
      await startCard(matchId, side, op, now);
      return;

    case "update": {
      if (!record) return;
      // Compare-and-set on the hash we read: a concurrent sync that already
      // moved the row wins, and this one stands down.
      const claimed = await prisma.timeAgreementActivity.updateMany({
        where: { matchId, userId, contentHash: record.contentHash },
        data: { phase: op.content.phase, contentHash: op.hash, partnerHash: op.partnerHash },
      });
      if (claimed.count === 0) return;
      const sent = await sendLiveActivityUpdateToUser(
        userId,
        TIME_AGREEMENT_ACTIVITY_TYPE,
        timeAgreementUpdateInput(op.content, op.alert ? timeAgreementAlert(lang, op.content, now) : null),
        // Only the token of THIS card: registered for this match, and after the
        // push-start that created it.
        { matchId, registeredSince: record.startedAt },
      ).catch(() => false);
      if (!sent) {
        // Not delivered — most often because the card was push-started seconds
        // ago and has not registered its update token yet. Put the old row back
        // so the 2-minute sweep delivers this content once it has.
        await prisma.timeAgreementActivity
          .updateMany({
            where: { matchId, userId, contentHash: op.hash },
            data: {
              phase: record.phase,
              contentHash: record.contentHash,
              partnerHash: record.partnerHash,
            },
          })
          .catch(() => undefined);
      }
      return;
    }

    case "end": {
      if (!record) return;
      const claimed = await prisma.timeAgreementActivity.deleteMany({
        where: { matchId, userId, contentHash: record.contentHash },
      });
      if (claimed.count === 0) return;
      await sendLiveActivityUpdateToUser(
        userId,
        TIME_AGREEMENT_ACTIVITY_TYPE,
        timeAgreementEndInput(
          op.dismiss,
          op.finalContent,
          now,
          op.alert && op.finalContent ? timeAgreementAlert(lang, op.finalContent, now) : null,
        ),
        { matchId },
      ).catch(() => false);
      return;
    }

    case "restart": {
      if (!record) return;
      const claimed = await prisma.timeAgreementActivity.deleteMany({
        where: { matchId, userId, contentHash: record.contentHash, startedAt: record.startedAt },
      });
      if (claimed.count === 0) return;
      await sendLiveActivityUpdateToUser(
        userId,
        TIME_AGREEMENT_ACTIVITY_TYPE,
        timeAgreementEndInput("now", null, now),
        { matchId },
      ).catch(() => false);
      await startCard(matchId, side, op, now);
      return;
    }
  }
}

/** End a card whose match (or whose place in it) is gone, and drop its row. */
async function endOrphan(
  matchId: string,
  userId: string,
  record: TimeAgreementActivityRecord,
  now: Date,
): Promise<void> {
  const claimed = await prisma.timeAgreementActivity.deleteMany({
    where: { matchId, userId, contentHash: record.contentHash },
  });
  if (claimed.count === 0) return;
  await sendLiveActivityUpdateToUser(
    userId,
    TIME_AGREEMENT_ACTIVITY_TYPE,
    timeAgreementEndInput("now", null, now),
    { matchId },
  ).catch(() => false);
}

async function runSync(matchId: string, now: Date): Promise<void> {
  if (!apnsConfigured()) return;

  const [match, records] = await Promise.all([
    loadTimeAgreementActivityMatch(matchId),
    prisma.timeAgreementActivity.findMany({
      where: { matchId },
      select: { userId: true, phase: true, contentHash: true, partnerHash: true, startedAt: true },
    }),
  ]);
  const byUser = new Map(records.map((r) => [r.userId, r]));

  if (match) {
    const desired = desiredTimeAgreementActivities(match, now);
    for (const side of [desired.A, desired.B]) {
      const record = byUser.get(side.userId) ?? null;
      byUser.delete(side.userId);
      const op = decideTimeAgreementActivity(record, side.desired, now);
      await applyOp(matchId, side.state, record, op, now);
    }
  }

  for (const [userId, record] of byUser) {
    await endOrphan(matchId, userId, record, now);
  }
}

/**
 * One queue per match. Two calendar writes a moment apart would otherwise each
 * read "no card running" and push-start two cards; serialized, the second one
 * reads the first one's row and sends an update (or nothing). Across processes
 * the row claims above still hold, and the sweep repairs whatever is left.
 */
const queues = new Map<string, Promise<void>>();

/**
 * Bring both sides' card in line with the calendar. Never throws. Returns once
 * this match's queue has drained up to and including this sync.
 */
export function syncTimeAgreementActivities(matchId: string, now?: Date): Promise<void> {
  const previous = queues.get(matchId) ?? Promise.resolve();
  const run = previous
    .then(() => runSync(matchId, now ?? new Date()))
    .catch((err) => {
      console.warn(`[time-agreement-activity] sync failed match=${matchId}:`, err);
    });
  queues.set(matchId, run);
  void run.then(() => {
    if (queues.get(matchId) === run) queues.delete(matchId);
  });
  return run;
}

/**
 * The 2-minute half (date-lifecycle tick): the transitions no calendar write
 * announces — a mark slipping inside the five-hour lead, a cancelled or expired
 * match, the grid reset by the venue-stage lapse, the ~7.5h restart, and an
 * update that could not be delivered yet. Walks only the cards believed to be
 * running, so the table IS the work list.
 */
export async function sweepTimeAgreementActivities(now: Date = new Date()): Promise<number> {
  if (!apnsConfigured()) return 0;
  const rows = await prisma.timeAgreementActivity.findMany({
    select: { matchId: true },
    distinct: ["matchId"],
  });
  for (const { matchId } of rows) {
    await syncTimeAgreementActivities(matchId, now);
  }
  return rows.length;
}
