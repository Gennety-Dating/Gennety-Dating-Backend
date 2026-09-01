import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { sendLiveActivityStartToUser, sendLiveActivityUpdateToUser } from "./push.js";

/**
 * The «date day» Live Activity (IOS_APP_ROADMAP §4.1 / iOS task 4.2).
 *
 * Telegram gets the same beats as chat messages; iOS gets them on the lock
 * screen, driven from here. Every function below is a no-op for a user with no
 * registered token, which is the ordinary state for a Telegram-only account —
 * so these calls are safe to sprinkle through the date lifecycle without
 * branching on platform.
 *
 * **The lock screen still identifies nobody.** It is a public surface: anyone
 * who picks the phone up off a table sees it. What it carries is the PLACE and
 * the TIME, which is the whole utility of the card ("where am I going, how long
 * do I have"), and no age and no photo. Same rule as the decision activity
 * (§4.1), where the answer was to carry nothing at all.
 *
 * **One field crossed that line on purpose, and only halfway.** From the
 * spotter stage the payload carries the partner's FIRST name, because the
 * question that stage answers is "which of them is he". The client renders it
 * in exactly one place — the expanded Dynamic Island, which takes a deliberate
 * long press by the owner — and never on the lock screen, in the compact
 * island or in the minimal island. So the surface a stranger sees is unchanged;
 * what changed is that the owner can now ask. See
 * `DateDayContentState.partnerFirstName`.
 */

/**
 * The Swift `ActivityAttributes` type name, verbatim. ActivityKit matches a
 * push-to-start payload to a configuration by this string and silently drops
 * anything it cannot resolve, so renaming the struct on the client without
 * changing this constant produces a feature that fails in complete silence.
 */
export const DATE_DAY_ATTRIBUTES_TYPE = "DateDayActivity";

/**
 * Stages, in the order the lifecycle fires them.
 *
 * Two deliberate absences:
 *
 * - **`meeting` is not a stage at all.** The client marks the activity stale
 *   at `agreedTime` and the system re-renders it into the "you're there" look
 *   by itself — no push, so it still happens with the app killed, the network
 *   down and the phone in a pocket. A push for a transition the clock already
 *   describes would be a worse implementation, not a more complete one.
 * - **`chat_open` is declared but never sent yet.** The pre-date proxy chat
 *   exists only on Telegram (iOS task 4.5), so announcing "the chat is open"
 *   on a lock screen the app cannot follow up on would be the dead-button
 *   anti-pattern with extra steps. Wire it from `closeProxies`' sibling in
 *   `services/coordination.ts` when the native chat screen lands.
 *
 * Two more arrived with the four-stage card:
 *
 * - **`spotter`** at T-30m — the shared sign, the partner's arrival and, on the
 *   expanded island only, their first name.
 * - **`vibe_check`** at T+2h — three buttons and nothing else.
 *
 * **`icebreakers` was NOT renamed to `logistics`** even though that is what it
 * now means to the client. The string has been on the wire since 2026-08, and a
 * rename would produce an error NOWHERE: an older build silently falls through
 * to `icebreakers` by its unknown-value rule, and a newer one would just as
 * silently fail to understand an older server. The cost of renaming is risk;
 * the benefit is a synonym.
 *
 * **A field the client declares and this file never sends: `tableHint`.** The
 * card can show "by the window" on the spotter stage, and there is nowhere in
 * the product a person writes that down. Sending an invented one would be the
 * dead-button anti-pattern in text; the slot waits for the surface that fills
 * it, exactly as `chat_open` waited for the chat.
 */
export type DateDayStage =
  | "icebreakers"
  | "wingman"
  | "chat_open"
  | "spotter"
  | "vibe_check";

/**
 * The spotter signs, in the order a match id hashes into them.
 *
 * **Why a sign at all.** Until T-30m the card answers "where do I go"; in the
 * last half hour the question becomes "which of them is he", and a product
 * that shows no faces on public surfaces has to answer it without showing a
 * face. A sign both sides carry solves it the way two people would solve it
 * themselves — by agreeing on a token in advance.
 *
 * **Derived, never stored.** The pair's sign is a pure function of the match
 * id, so both pushes carry the same value without a column, a migration or a
 * write that could fail on one side and not the other. It also means a
 * re-delivered push cannot show a different sign than the first one did.
 *
 * SF Symbol names, spelled as the client will look them up. The client refuses
 * a name it cannot resolve and falls back, so adding a symbol here that an old
 * build does not know degrades to a neutral sign rather than to a hole — but
 * BOTH sides of a pair must then still agree, which they do: the fallback is
 * the same on every build.
 */
const SPOTTER_GLYPHS = [
  "moon.stars.fill",
  "flame.fill",
  "leaf.fill",
  "bolt.fill",
  "drop.fill",
  "star.fill",
  "sun.max.fill",
  "cloud.fill",
] as const;

/**
 * Four hues, and none of them is the brand burgundy by accident.
 *
 * The sign is a token two strangers compare across a room, so it has to be
 * told apart at a glance — one colour would put the whole job on the symbol.
 * The set stays small and dark-legible on purpose: this is the one place in
 * the product where colour carries meaning rather than brand, and a wider
 * palette would start reading as decoration.
 */
const SPOTTER_COLORS = ["#C13352", "#E0A458", "#5EA9A0", "#B599E6"] as const;

export interface SpotterSign {
  glyph: string;
  glyphHex: string;
}

/**
 * The pair's sign. FNV-1a over the match id — small, dependency-free and, more
 * to the point, STABLE: the same id gives the same sign on every process, on
 * every deploy, and on a retry after a crash.
 */
export function spotterSignFor(matchId: string): SpotterSign {
  let hash = 0x811c9dc5;
  for (let i = 0; i < matchId.length; i++) {
    hash ^= matchId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return {
    glyph: SPOTTER_GLYPHS[hash % SPOTTER_GLYPHS.length]!,
    glyphHex: SPOTTER_COLORS[(hash >>> 8) % SPOTTER_COLORS.length]!,
  };
}

/**
 * The mutable half of the card, exactly as the Swift `ContentState` declares
 * it. Every field is optional but `stage`, and that is a size decision as much
 * as a modelling one: the whole Live Activity payload is capped at 4096 bytes,
 * and an absent key costs nothing while a null costs its name.
 *
 * **Venue, address and time are deliberately NOT here** even though the client
 * shows all three: they cannot change once the card exists, so they live in
 * the immutable attributes and ride along exactly once, at start.
 */
interface DateDayContentState {
  stage: DateDayStage;
  glyph?: string;
  glyphHex?: string;
  partnerArrived?: boolean;
  /**
   * The partner's first name — the one thing on this card that is about the
   * person rather than the evening, and the only field here that needed a
   * product decision rather than a technical one.
   *
   * It is sent ONLY with the spotter stage, and the client renders it in ONE
   * place: the expanded Dynamic Island, which takes a deliberate long press by
   * the phone's owner. The lock screen, the compact island and the minimal
   * island never show it — those are surfaces a stranger sees by picking the
   * phone up off a table, and the rule for them is unchanged.
   */
  partnerFirstName?: string;
}

/** The activity's immutable half — settled by the time it starts. */
interface DateDayAttributes {
  matchId: string;
  /** Unix seconds. The countdown the system runs on its own. */
  startsAt: number;
  venueName: string;
  venueAddress: string;
  /** Deep link straight to Maps. Empty string when the venue has no URI. */
  mapsUrl: string;
}

interface DateDayMatchRow {
  id: string;
  agreedTime: Date | null;
  venueName: string | null;
  venueAddress: string | null;
  venueGoogleMapsUri: string | null;
  userA: { id: string; language: string | null; firstName: string | null };
  userB: { id: string; language: string | null; firstName: string | null };
}

const MATCH_SELECT = {
  id: true,
  agreedTime: true,
  venueName: true,
  venueAddress: true,
  venueGoogleMapsUri: true,
  // `firstName` is read for the spotter stage only. It is selected here rather
  // than in a second query because the row is already being fetched; what
  // guards it is not the read but where it is allowed to be SENT — see
  // `DateDayContentState.partnerFirstName`.
  userA: { select: { id: true, language: true, firstName: true } },
  userB: { select: { id: true, language: true, firstName: true } },
} as const;

function attributesFor(match: DateDayMatchRow, startsAt: Date): DateDayAttributes {
  return {
    matchId: match.id,
    startsAt: Math.floor(startsAt.getTime() / 1000),
    venueName: match.venueName ?? "",
    venueAddress: match.venueAddress ?? "",
    mapsUrl: match.venueGoogleMapsUri ?? "",
  };
}

/**
 * Push-to-start both sides' activity at the T-5h gate.
 *
 * Fired from the ice-breaker step, which already claims its own idempotency
 * marker, so this runs exactly once per match. A second start push would
 * anyway be harmless — ActivityKit replaces rather than duplicates — but the
 * user-visible alert would fire twice, which is not.
 */
export async function startDateDayActivities(
  matchId: string,
  now: Date = new Date(),
): Promise<void> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: MATCH_SELECT });
  if (!match?.agreedTime) return;
  // A date that has already begun gets no card: the activity exists to carry
  // the hours before it, and starting one late would open on the stale look.
  if (match.agreedTime.getTime() <= now.getTime()) return;

  const attributes = attributesFor(match, match.agreedTime);
  const staleDate = Math.floor(match.agreedTime.getTime() / 1000);

  await Promise.all(
    [match.userA, match.userB].map((user) => {
      const lang = (user.language ?? "en") as Language;
      return sendLiveActivityStartToUser(user.id, "date_day", {
        attributesType: DATE_DAY_ATTRIBUTES_TYPE,
        attributes: attributes as unknown as Record<string, unknown>,
        contentState: { stage: "icebreakers" satisfies DateDayStage },
        alert: {
          title: t(lang, "dateDayActivityStartTitle"),
          body: t(lang, "dateDayActivityStartBody"),
        },
        staleDate,
      }).catch(() => false);
    }),
  );
}

/**
 * Move both sides' card to a later stage. Silent for anyone not running one.
 *
 * **Order between pushes is APNs' job, not ours.** Every Live Activity payload
 * carries `aps.timestamp` (`buildLiveActivityPayload`), and ActivityKit drops
 * an update that arrives out of order — so a re-ordered delivery cannot walk a
 * card backwards. That is what makes the "stages only ever advance" invariant
 * hold without a sequence number of our own.
 */
export async function advanceDateDayActivities(
  matchId: string,
  stage: DateDayStage,
): Promise<void> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: MATCH_SELECT });
  if (!match?.agreedTime) return;

  await pushBothSides(match, () => ({ stage }));
}

/**
 * T-30m: the card stops being about the route and starts being about
 * recognition.
 *
 * Both sides get the SAME sign — that is the whole mechanism — and each side
 * gets the OTHER one's first name. That asymmetry is why this is its own
 * function rather than a `stage` argument to the one above.
 */
export async function advanceToSpotterStage(matchId: string): Promise<void> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: MATCH_SELECT });
  if (!match?.agreedTime) return;

  const sign = spotterSignFor(match.id);
  await pushBothSides(match, (_self, peer) => ({
    stage: "spotter",
    ...sign,
    ...(peer.firstName ? { partnerFirstName: peer.firstName } : {}),
  }));
}

/**
 * One side reached the venue: tell the OTHER one, and only the other one.
 *
 * The fact travels, the position does not — same boundary as the radar's own
 * response (`viewOfPeer`), which is where this call is made from. A card that
 * said "500 m away" would be the same disclosure at a coarser resolution.
 *
 * Sent once per arrival rather than per ping: the radar route only calls this
 * when a ping FLIPS the side to arrived.
 */
export async function notifyPartnerArrived(
  matchId: string,
  arrivedSide: "A" | "B",
): Promise<void> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: MATCH_SELECT });
  if (!match?.agreedTime) return;

  const sign = spotterSignFor(match.id);
  const recipient = arrivedSide === "A" ? match.userB : match.userA;
  const arrived = arrivedSide === "A" ? match.userA : match.userB;
  const staleDate = Math.floor(match.agreedTime.getTime() / 1000);

  await sendLiveActivityUpdateToUser(recipient.id, "date_day", {
    event: "update",
    contentState: {
      stage: "spotter",
      ...sign,
      partnerArrived: true,
      ...(arrived.firstName ? { partnerFirstName: arrived.firstName } : {}),
    },
    staleDate,
  }).catch(() => false);
}

/** T+2h: three buttons, and nothing else left to do on the card. */
export async function advanceToVibeCheck(matchId: string): Promise<void> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: MATCH_SELECT });
  if (!match?.agreedTime) return;

  await pushBothSides(match, () => ({ stage: "vibe_check" }));
}

/**
 * Take ONE side's card down after that side answered.
 *
 * Ends with a dismissal date a couple of minutes out rather than immediately:
 * the card has just been tapped, and a surface that vanishes under the finger
 * reads as a mis-tap rather than as a confirmation. The content state goes
 * along so the server's last word matches the optimistic one the intent
 * already wrote — otherwise the acknowledgement would blink back to buttons
 * for the two seconds before it disappears.
 */
export async function endDateDayActivityAfterVibe(
  userId: string,
  vibe: string,
  now: Date = new Date(),
): Promise<void> {
  await sendLiveActivityUpdateToUser(userId, "date_day", {
    event: "end",
    contentState: { stage: "vibe_check" satisfies DateDayStage, vibe },
    dismissalDate: Math.floor(now.getTime() / 1000) + VIBE_ACK_SECONDS,
  }).catch(() => false);
}

/** How long the "noted" state stays up after a tap. */
const VIBE_ACK_SECONDS = 120;

/**
 * Send both sides an update built per side. `self` is the recipient, `peer` the
 * other one — spelled out because the spotter payload is the one place where
 * getting them the wrong way round would leak a person their own name and
 * silently break the mechanism for both.
 */
async function pushBothSides(
  match: DateDayMatchRow,
  build: (
    self: DateDayMatchRow["userA"],
    peer: DateDayMatchRow["userA"],
  ) => DateDayContentState,
): Promise<void> {
  const staleDate = match.agreedTime
    ? Math.floor(match.agreedTime.getTime() / 1000)
    : undefined;

  await Promise.all(
    ([
      [match.userA, match.userB],
      [match.userB, match.userA],
    ] as const).map(([self, peer]) =>
      sendLiveActivityUpdateToUser(self.id, "date_day", {
        event: "update",
        contentState: build(self, peer) as unknown as Record<string, unknown>,
        ...(staleDate ? { staleDate } : {}),
      }).catch(() => false),
    ),
  );
}

/**
 * Take the card down. Sent as a plain `end` with no dismissal date, so it
 * leaves the lock screen immediately rather than lingering in the Notification
 * Centre — the date is over and there is nothing left to act on.
 *
 * Deliberately carries no idempotency marker: ending an activity that is
 * already gone is a no-op, so the sweep that calls this can use a time window
 * instead of a column.
 */
export async function endDateDayActivities(matchId: string): Promise<void> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: MATCH_SELECT });
  if (!match) return;

  await Promise.all(
    [match.userA, match.userB].map((user) =>
      sendLiveActivityUpdateToUser(user.id, "date_day", { event: "end" }).catch(() => false),
    ),
  );
}
