import { createHash } from "node:crypto";
import { prisma } from "@gennety/db";
import {
  SUPPORTED_LANGUAGES,
  t,
  venuePlacesPhrase,
  VENUE_CHANGE_ACTIVITY_NAME_MAX_CHARS,
  VENUE_CHANGE_ACTIVITY_PICK_NAMES_MAX,
  VENUE_CHANGE_ACTIVITY_RESOLVED_DISMISS_MINUTES,
  VENUE_CHANGE_ACTIVITY_RESTART_HOURS,
  type Language,
} from "@gennety/shared";
import {
  KEEP_KEY,
  loadVenueChangeActivityMatch,
  venueChangeActivitySlice,
  type VenueChangeActivityMatch,
  type VenueChangeActivitySlice,
} from "../handlers/matching/venue-change.js";
import { venueChangeSideWaiting } from "../workers/peer-wait-venue-change.js";
import {
  apnsConfigured,
  type LiveActivityStartInput,
  type LiveActivityUpdateInput,
} from "./apns.js";
import { sendLiveActivityStartToUser, sendLiveActivityUpdateToUser } from "./push.js";
import { isUniqueViolation } from "./ticket-wallet.js";

/**
 * The venue-change lock-screen card — the iOS `venue_change` Live Activity
 * (decision 2026-09-22, founder canvas «Редизайн смены места»).
 *
 * One card per person per match, showing the §3.7b board from THAT person's
 * side. Three phases, in priority order:
 *
 *   `match`   — the round is agreed and this side still has a move on it
 *               (`myAction` pay / pay_or_decline / pay_or_offer). Deadline:
 *               the agreement's own expiry.
 *   `partner` — the partner has marked at least one place this side has not
 *               ("your move"). Deadline: the board's cutoff (T − 5h).
 *   `waiting` — this side is blocked on the partner, exactly as
 *               `venueChangeSideWaiting` defines it: I have marks and they have
 *               none, OR the round is agreed and the partner is the one who has
 *               to pay (then `agreedName` is set and the deadline is the
 *               agreement's expiry).
 *
 * Anything else — no phase applies, the board is closed (past the cutoff, the
 * feature off, the match no longer scheduled), the round settled or lapsed —
 * ENDS the card.
 *
 * **Driven by diff, not by event.** Every board write (and the 2-minute
 * lifecycle sweep) recomputes what both cards SHOULD show and compares it with
 * what was last sent (`venue_change_activities`): nothing running → push-start;
 * content changed → update; nothing applies → end; identical → nothing at all.
 * So a caller never has to know which transition it caused, and calling this
 * after a write that changed nothing visible costs one read.
 *
 * **The lock screen names the partner.** `partnerFirstName` is on the card's
 * public surface — the one deliberate exception to "the lock screen identifies
 * nobody" (`date-day-activity.ts`), made by the founder for this card only: the
 * card is about what one person proposed to the other, and "your match suggests
 * two places" reads as a system notice rather than as a person. No photo, no age.
 */

export const VENUE_CHANGE_ACTIVITY_TYPE = "venue_change" as const;

/**
 * The Swift `ActivityAttributes` type name, verbatim — ActivityKit resolves a
 * push-to-start by this string and silently drops one it cannot match. See
 * `DATE_DAY_ATTRIBUTES_TYPE`.
 */
export const VENUE_CHANGE_ATTRIBUTES_TYPE = "VenueChangeActivity";

export type VenueChangePhase = "waiting" | "partner" | "match";

/**
 * The card's mutable half, exactly as the Swift `ContentState` declares it.
 * Every key is always present (null / 0 / [] when it does not apply) so the
 * client can decode it with a plain `Codable` struct; the payload stays far
 * under Apple's 4096-byte ceiling because names are capped
 * (`VENUE_CHANGE_ACTIVITY_NAME_MAX_CHARS`) — frozen by a test.
 */
export interface VenueChangeContentState {
  phase: VenueChangePhase;
  partnerFirstName: string | null;
  partnerGender: "male" | "female" | null;
  /** The one place I marked, when I marked exactly one. */
  myPickName: string | null;
  myPickCount: number;
  /** The partner's marks I have NOT made, at most three names. */
  partnerPickNames: string[];
  partnerPickCount: number;
  /** The agreed venue — `match`, and `waiting` on the partner's payment. */
  agreedName: string | null;
  /** Unix seconds; also the `stale-date`. */
  deadline: number | null;
}

/** One side's board plus the peer-wait verdict — everything derivation reads. */
export interface VenueChangeSideState extends VenueChangeActivitySlice {
  waiting: boolean;
}

export type DesiredVenueChangeActivity =
  | {
      kind: "show";
      content: VenueChangeContentState;
      /** The partner's only new mark is "keep the current place" (for the alert). */
      partnerKeepOnly: boolean;
    }
  /**
   * Touch nothing. A hidden express mint (§3.7b) is silent until it is paid —
   * that surprise is the product — so neither card may move while one is
   * pending: ending the partner's card would announce it, and a card for the
   * minter would narrate a purchase she is making in the app at that moment.
   * It resolves within 30 minutes (settle → end; revert → the diff resumes).
   */
  | { kind: "hold" }
  | {
      kind: "none";
      /** Set when the round RESOLVED — the card lingers briefly to be read. */
      resolution: "settled" | "lapsed" | null;
      /** What the card says while it lingers; null keeps its last look. */
      finalContent: VenueChangeContentState | null;
    };

const PAYING_ACTIONS = new Set(["pay", "pay_or_decline", "pay_or_offer"]);

function unixSeconds(date: Date | null): number | null {
  return date ? Math.floor(date.getTime() / 1000) : null;
}

function clipName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > VENUE_CHANGE_ACTIVITY_NAME_MAX_CHARS
    ? `${trimmed.slice(0, VENUE_CHANGE_ACTIVITY_NAME_MAX_CHARS - 1).trimEnd()}…`
    : trimmed;
}

function genderOf(raw: string | null): "male" | "female" | null {
  return raw === "male" || raw === "female" ? raw : null;
}

/** Builds the content in ONE key order, so equal content hashes equally. */
function contentState(
  side: VenueChangeSideState,
  fields: Partial<Omit<VenueChangeContentState, "partnerFirstName" | "partnerGender">> & {
    phase: VenueChangePhase;
  },
): VenueChangeContentState {
  const firstName = side.partnerFirstName?.trim();
  return {
    phase: fields.phase,
    partnerFirstName: firstName ? clipName(firstName) : null,
    partnerGender: genderOf(side.partnerGender),
    myPickName: fields.myPickName ?? null,
    myPickCount: fields.myPickCount ?? 0,
    partnerPickNames: fields.partnerPickNames ?? [],
    partnerPickCount: fields.partnerPickCount ?? 0,
    agreedName: fields.agreedName ?? null,
    deadline: fields.deadline ?? null,
  };
}

const NONE: DesiredVenueChangeActivity = { kind: "none", resolution: null, finalContent: null };

/** What one side's card should show right now. Pure. */
export function deriveVenueChangeActivity(side: VenueChangeSideState): DesiredVenueChangeActivity {
  if (!side.matchScheduled) return NONE;

  if (side.status === "settled") {
    // The venue that now stands, with no deadline — the round is over, and the
    // brief linger should say how it ended rather than repeat the ask.
    return {
      kind: "none",
      resolution: "settled",
      finalContent: side.settledName
        ? contentState(side, { phase: "match", agreedName: clipName(side.settledName) })
        : null,
    };
  }
  if (side.status === "lapsed") return { kind: "none", resolution: "lapsed", finalContent: null };
  if (side.closedReason !== null) return NONE;

  if (side.status === "agreed") {
    if (side.expressPending) return { kind: "hold" };
    if (!side.agreedName) return NONE;
    const agreed = {
      agreedName: clipName(side.agreedName),
      deadline: unixSeconds(side.agreedExpiresAt),
    };
    if (side.myAction && PAYING_ACTIONS.has(side.myAction)) {
      return { kind: "show", content: contentState(side, { phase: "match", ...agreed }), partnerKeepOnly: false };
    }
    if (side.waiting) {
      return { kind: "show", content: contentState(side, { phase: "waiting", ...agreed }), partnerKeepOnly: false };
    }
    return NONE;
  }

  if (side.status === "liking") {
    const mine = new Set(side.myLikes.map((l) => l.key));
    const mineFields = {
      myPickName: side.myLikes.length === 1 ? clipName(side.myLikes[0]!.name) : null,
      myPickCount: side.myLikes.length,
      deadline: unixSeconds(side.cutoff),
    };
    const partnerOnly = side.peerLikes.filter((l) => !mine.has(l.key));
    if (partnerOnly.length > 0) {
      return {
        kind: "show",
        content: contentState(side, {
          phase: "partner",
          ...mineFields,
          partnerPickNames: partnerOnly
            .slice(0, VENUE_CHANGE_ACTIVITY_PICK_NAMES_MAX)
            .map((l) => clipName(l.name)),
          partnerPickCount: partnerOnly.length,
        }),
        partnerKeepOnly: partnerOnly.length === 1 && partnerOnly[0]!.key === KEEP_KEY,
      };
    }
    if (side.waiting) {
      return { kind: "show", content: contentState(side, { phase: "waiting", ...mineFields }), partnerKeepOnly: false };
    }
  }
  // Includes a multi-overlap waiting on /confirm: both sides marked the same
  // places and neither is "waiting" nor looking at a new mark — the app, not
  // the lock screen, is where one of them picks.
  return NONE;
}

export function venueChangeSideState(
  match: VenueChangeActivityMatch,
  side: "A" | "B",
  now: Date,
): VenueChangeSideState {
  return { ...venueChangeActivitySlice(match, side, now), waiting: venueChangeSideWaiting(match, side) };
}

/** Both sides' desired cards for one match row. Pure. */
export function desiredVenueChangeActivities(
  match: VenueChangeActivityMatch,
  now: Date,
): Record<"A" | "B", { userId: string; state: VenueChangeSideState; desired: DesiredVenueChangeActivity }> {
  const one = (side: "A" | "B") => {
    const state = venueChangeSideState(match, side, now);
    return { userId: state.userId, state, desired: deriveVenueChangeActivity(state) };
  };
  return { A: one("A"), B: one("B") };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** What was last sent to one side (`venue_change_activities`). */
export interface VenueChangeActivityRecord {
  phase: string;
  contentHash: string;
  startedAt: Date;
}

export type VenueChangeActivityOp =
  | { op: "noop" }
  | { op: "start" | "update" | "restart"; content: VenueChangeContentState; hash: string }
  | { op: "end"; dismiss: "resolved" | "now"; finalContent: VenueChangeContentState | null };

const RESTART_AFTER_MS = VENUE_CHANGE_ACTIVITY_RESTART_HOURS * 60 * 60 * 1000;

export function venueChangeContentHash(content: VenueChangeContentState): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 32);
}

/**
 * start / update / restart / end / nothing. Pure.
 *
 * The restart exists because iOS freezes a Live Activity 8 hours after it
 * started, while a board can stay open for days: a card that still applies at
 * 7.5h is ended and push-started afresh (a new alert, a new 8-hour life). It is
 * checked BEFORE the content comparison so that an unchanged card is renewed
 * too — unchanged is exactly the card that would otherwise go dead.
 */
export function decideVenueChangeActivity(
  record: VenueChangeActivityRecord | null,
  desired: DesiredVenueChangeActivity,
  now: Date,
): VenueChangeActivityOp {
  if (desired.kind === "hold") return { op: "noop" };
  if (desired.kind === "none") {
    if (!record) return { op: "noop" };
    return {
      op: "end",
      dismiss: desired.resolution ? "resolved" : "now",
      finalContent: desired.finalContent,
    };
  }
  const hash = venueChangeContentHash(desired.content);
  if (!record) return { op: "start", content: desired.content, hash };
  if (now.getTime() - record.startedAt.getTime() >= RESTART_AFTER_MS) {
    return { op: "restart", content: desired.content, hash };
  }
  if (record.contentHash === hash) return { op: "noop" };
  return { op: "update", content: desired.content, hash };
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
 * The alert a push-to-start must carry (Apple requires one: the card appears
 * without the person having opened anything). Short, in the recipient's own
 * language, and the partner's name only ever as the subject — the server
 * declines no names, so nothing here may need a case ("ждём {name}" would).
 */
export function venueChangeAlert(
  lang: Language,
  content: VenueChangeContentState,
  partnerKeepOnly: boolean,
): { title: string; body: string } {
  const title = t(lang, "venueActivityStartTitle");
  const name = content.partnerFirstName ?? t(lang, "venueActivityPartnerFallback");
  switch (content.phase) {
    case "partner": {
      const first = content.partnerPickNames[0];
      if (partnerKeepOnly && first) {
        return { title, body: t(lang, "venueActivityStartPartnerKeep", { name, venue: first }) };
      }
      const what =
        content.partnerPickCount === 1 && first
          ? first
          : venuePlacesPhrase(lang, content.partnerPickCount);
      return { title, body: t(lang, "venueActivityStartPartner", { name, what }) };
    }
    case "match":
      return { title, body: t(lang, "venueActivityStartMatch", { venue: content.agreedName ?? "" }) };
    case "waiting":
      return { title, body: t(lang, "venueActivityStartWaiting") };
  }
}

export function venueChangeStartInput(
  matchId: string,
  content: VenueChangeContentState,
  lang: Language,
  partnerKeepOnly: boolean,
): LiveActivityStartInput {
  return {
    attributesType: VENUE_CHANGE_ATTRIBUTES_TYPE,
    attributes: { matchId },
    contentState: content as unknown as Record<string, unknown>,
    alert: venueChangeAlert(lang, content, partnerKeepOnly),
    ...(content.deadline ? { staleDate: content.deadline } : {}),
  };
}

export function venueChangeUpdateInput(content: VenueChangeContentState): LiveActivityUpdateInput {
  return {
    event: "update",
    contentState: content as unknown as Record<string, unknown>,
    ...(content.deadline ? { staleDate: content.deadline } : {}),
  };
}

/**
 * The end. A RESOLVED round lingers for a few minutes so it can be read; a
 * board that merely closed leaves at once (a dismissal date of "now" — an end
 * without one would sit on the lock screen for up to four hours).
 */
export function venueChangeEndInput(
  dismiss: "resolved" | "now",
  finalContent: VenueChangeContentState | null,
  now: Date,
): LiveActivityUpdateInput {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return {
    event: "end",
    ...(finalContent ? { contentState: finalContent as unknown as Record<string, unknown> } : {}),
    dismissalDate:
      dismiss === "resolved"
        ? nowSeconds + VENUE_CHANGE_ACTIVITY_RESOLVED_DISMISS_MINUTES * 60
        : nowSeconds,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Push-start a card. The row is written FIRST, as a claim — a second
 * push-to-start would not replace the running card, it would open another one
 * beside it — and released if APNs did not take the push, so the next board
 * write tries again. Users without a `start` token (every Telegram-only
 * account) cost one lookup and no write.
 */
async function startCard(
  matchId: string,
  side: VenueChangeSideState,
  op: { content: VenueChangeContentState; hash: string },
  partnerKeepOnly: boolean,
  now: Date,
): Promise<void> {
  const startToken = await prisma.liveActivityToken.findUnique({
    where: {
      userId_activityType_kind: {
        userId: side.userId,
        activityType: VENUE_CHANGE_ACTIVITY_TYPE,
        kind: "start",
      },
    },
    select: { id: true },
  });
  if (!startToken) return;

  try {
    await prisma.venueChangeActivity.create({
      data: {
        matchId,
        userId: side.userId,
        phase: op.content.phase,
        contentHash: op.hash,
        startedAt: now,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return; // another sync started it first
    throw err;
  }

  const sent = await sendLiveActivityStartToUser(
    side.userId,
    VENUE_CHANGE_ACTIVITY_TYPE,
    venueChangeStartInput(matchId, op.content, languageOf(side.language), partnerKeepOnly),
  ).catch(() => false);
  if (!sent) {
    await prisma.venueChangeActivity
      .deleteMany({
        where: { matchId, userId: side.userId, contentHash: op.hash, startedAt: now },
      })
      .catch(() => undefined);
  }
}

async function applyOp(
  matchId: string,
  side: VenueChangeSideState,
  desired: DesiredVenueChangeActivity,
  record: VenueChangeActivityRecord | null,
  op: VenueChangeActivityOp,
  now: Date,
): Promise<void> {
  const userId = side.userId;
  const partnerKeepOnly = desired.kind === "show" && desired.partnerKeepOnly;

  switch (op.op) {
    case "noop":
      return;

    case "start":
      await startCard(matchId, side, op, partnerKeepOnly, now);
      return;

    case "update": {
      if (!record) return;
      // Compare-and-set on the hash we read: a concurrent sync that already
      // moved the row wins, and this one stands down.
      const claimed = await prisma.venueChangeActivity.updateMany({
        where: { matchId, userId, contentHash: record.contentHash },
        data: { phase: op.content.phase, contentHash: op.hash },
      });
      if (claimed.count === 0) return;
      const sent = await sendLiveActivityUpdateToUser(
        userId,
        VENUE_CHANGE_ACTIVITY_TYPE,
        venueChangeUpdateInput(op.content),
        // Only the token of THIS card: registered for this match, and after the
        // push-start that created it.
        { matchId, registeredSince: record.startedAt },
      ).catch(() => false);
      if (!sent) {
        // Not delivered — most often because the card was push-started seconds
        // ago and has not registered its update token yet. Put the old hash
        // back so the 2-minute sweep delivers this content once it has.
        await prisma.venueChangeActivity
          .updateMany({
            where: { matchId, userId, contentHash: op.hash },
            data: { phase: record.phase, contentHash: record.contentHash },
          })
          .catch(() => undefined);
      }
      return;
    }

    case "end": {
      if (!record) return;
      const claimed = await prisma.venueChangeActivity.deleteMany({
        where: { matchId, userId, contentHash: record.contentHash },
      });
      if (claimed.count === 0) return;
      await sendLiveActivityUpdateToUser(
        userId,
        VENUE_CHANGE_ACTIVITY_TYPE,
        venueChangeEndInput(op.dismiss, op.finalContent, now),
        { matchId },
      ).catch(() => false);
      return;
    }

    case "restart": {
      if (!record) return;
      const claimed = await prisma.venueChangeActivity.deleteMany({
        where: { matchId, userId, contentHash: record.contentHash, startedAt: record.startedAt },
      });
      if (claimed.count === 0) return;
      await sendLiveActivityUpdateToUser(
        userId,
        VENUE_CHANGE_ACTIVITY_TYPE,
        venueChangeEndInput("now", null, now),
        { matchId },
      ).catch(() => false);
      await startCard(matchId, side, op, partnerKeepOnly, now);
      return;
    }
  }
}

/** End a card whose match (or whose place in it) is gone, and drop its row. */
async function endOrphan(
  matchId: string,
  userId: string,
  record: VenueChangeActivityRecord,
  now: Date,
): Promise<void> {
  const claimed = await prisma.venueChangeActivity.deleteMany({
    where: { matchId, userId, contentHash: record.contentHash },
  });
  if (claimed.count === 0) return;
  await sendLiveActivityUpdateToUser(
    userId,
    VENUE_CHANGE_ACTIVITY_TYPE,
    venueChangeEndInput("now", null, now),
    { matchId },
  ).catch(() => false);
}

async function runSync(matchId: string, now: Date): Promise<void> {
  if (!apnsConfigured()) return;

  const [match, records] = await Promise.all([
    loadVenueChangeActivityMatch(matchId),
    prisma.venueChangeActivity.findMany({
      where: { matchId },
      select: { userId: true, phase: true, contentHash: true, startedAt: true },
    }),
  ]);
  const byUser = new Map(records.map((r) => [r.userId, r]));

  if (match) {
    const desired = desiredVenueChangeActivities(match, now);
    for (const side of [desired.A, desired.B]) {
      const record = byUser.get(side.userId) ?? null;
      byUser.delete(side.userId);
      const op = decideVenueChangeActivity(record, side.desired, now);
      await applyOp(matchId, side.state, side.desired, record, op, now);
    }
  }

  for (const [userId, record] of byUser) {
    await endOrphan(matchId, userId, record, now);
  }
}

/**
 * One queue per match. Two board writes a moment apart would otherwise each
 * read "no card running" and push-start two cards; serialized, the second one
 * reads the first one's row and sends an update (or nothing). Across processes
 * the row claims above still hold, and the sweep repairs whatever is left.
 */
const queues = new Map<string, Promise<void>>();

/**
 * Bring both sides' card in line with the board. Never throws. Returns once
 * this match's queue has drained up to and including this sync.
 */
export function syncVenueChangeActivities(matchId: string, now?: Date): Promise<void> {
  const previous = queues.get(matchId) ?? Promise.resolve();
  const run = previous
    .then(() => runSync(matchId, now ?? new Date()))
    .catch((err) => {
      console.warn(`[venue-change-activity] sync failed match=${matchId}:`, err);
    });
  queues.set(matchId, run);
  void run.then(() => {
    if (queues.get(matchId) === run) queues.delete(matchId);
  });
  return run;
}

/**
 * The 2-minute half (date-lifecycle tick): the transitions no board write
 * announces — the T-5h cutoff, a cancelled or finished match, the feature flag
 * turned off, the ~7.5h restart, and an update that could not be delivered yet.
 * Walks only the cards believed to be running, so the table IS the work list.
 */
export async function sweepVenueChangeActivities(now: Date = new Date()): Promise<number> {
  if (!apnsConfigured()) return 0;
  const rows = await prisma.venueChangeActivity.findMany({
    select: { matchId: true },
    distinct: ["matchId"],
  });
  for (const { matchId } of rows) {
    await syncVenueChangeActivities(matchId, now);
  }
  return rows.length;
}
