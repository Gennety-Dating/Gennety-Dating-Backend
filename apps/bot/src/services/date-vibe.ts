import { prisma } from "@gennety/db";

import { createMatchEvent, type MatchEventActionType } from "./match-events.js";
import { endDateDayActivityAfterVibe } from "./date-day-activity.js";

/**
 * The one-tap read on how an evening went, taken from the Live Activity at
 * T+2h (iOS §4.2, stage `vibe_check`).
 *
 * **This is not the post-date feedback form, and it must not become it.** The
 * form at T+24h asks two mandatory questions with their own scales and is the
 * only thing the product learns whether a date worked from. This is one tap on
 * a lock screen by someone who is possibly still walking home. Three values,
 * no scale, no text: asking for a 1–10 here would not get a considered number,
 * it would get a random one, and a random number is indistinguishable in the
 * dataset from a considered one.
 *
 * **It is also not like/dislike.** The guardrail forbids rating a PERSON with a
 * thumb; this rates an evening that already happened, and none of the three
 * values decides anything about the partner — the pair is already banned from
 * re-matching either way, and the matching signal comes from the T+24h form.
 *
 * **No migration, and that is a constraint rather than a shortcut.** The answer
 * lands in `match_events`, whose `CHEMISTRY_POSITIVE` / `CHEMISTRY_NEGATIVE`
 * pair already exists for exactly this axis, with the precise rating in
 * `metadata` so the three-way distinction is not lost to the two-way enum. A
 * Postgres enum cannot gain a value without a migration; a JSON column can
 * carry the nuance today and be promoted later if this signal proves worth its
 * own column.
 */
export type DateVibeRating = "chemistry_great" | "nice_chat" | "no_vibe";

const RATINGS: Record<DateVibeRating, MatchEventActionType> = {
  // "Warm" sits on the positive side deliberately. The axis in the enum is
  // "was there chemistry", and "we had a nice time" is an answer of yes with a
  // smaller number — collapsing it into the negative case would make every
  // pleasant-but-unremarkable evening read as a failure.
  chemistry_great: "CHEMISTRY_POSITIVE",
  nice_chat: "CHEMISTRY_POSITIVE",
  no_vibe: "CHEMISTRY_NEGATIVE",
};

export function isDateVibeRating(value: unknown): value is DateVibeRating {
  // `in` rather than `Object.hasOwn` was the first version and it accepted
  // `"toString"` — the prototype chain is part of `in`, so a client sending
  // that name would have reached `createMatchEvent` with a FUNCTION where the
  // action type belongs. Found by the test that asserts it, not by reading.
  return typeof value === "string" && Object.hasOwn(RATINGS, value);
}

export type DateVibeRefusal = "not-found" | "wrong-state" | "bad-rating";

interface MatchEventReadClient {
  matchEvent: {
    findFirst(args: {
      where: {
        matchId: string;
        actorId: string;
        actionType: { in: MatchEventActionType[] };
        createdAt?: { gte: Date };
      };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

const matchEventReader = prisma as typeof prisma & MatchEventReadClient;

export interface RecordDateVibeInput {
  matchId: string;
  userId: string;
  rating: unknown;
  now?: Date;
}

/**
 * Record one side's read on the evening and take that side's card down.
 *
 * Returns a refusal rather than throwing, because every branch here is a
 * legitimate client state rather than an error: a stale match id from an
 * activity that outlived its date, a second tap that raced the first, a value
 * from a build this server does not know.
 */
export async function recordDateVibe(
  input: RecordDateVibeInput,
): Promise<{ ok: true } | { ok: false; error: DateVibeRefusal }> {
  const now = input.now ?? new Date();
  if (!isDateVibeRating(input.rating)) return { ok: false, error: "bad-rating" };

  const match = await prisma.match.findUnique({
    where: { id: input.matchId },
    select: { id: true, userAId: true, userBId: true, agreedTime: true, status: true },
  });
  // 404 rather than 403 for a non-participant: the endpoint must not be usable
  // to probe which match ids exist. Same rule as the radar and the Bump.
  if (!match || (match.userAId !== input.userId && match.userBId !== input.userId)) {
    return { ok: false, error: "not-found" };
  }
  // The question is about an evening that happened. Before `agreedTime` there
  // is nothing to answer, and a card that somehow asked early must not be able
  // to write one.
  if (!match.agreedTime || match.agreedTime.getTime() > now.getTime()) {
    return { ok: false, error: "wrong-state" };
  }

  const peerId = match.userAId === input.userId ? match.userBId : match.userAId;

  // The audit log is append-only, so a double tap would leave two rows and two
  // rows would count twice. The client hides the buttons after the first tap
  // and the intent guards on its own state; this is the guard for the case
  // neither can see — the same person answering from a second device, or a
  // retry of a request whose response was lost.
  const already = await matchEventReader.matchEvent.findFirst({
    where: {
      matchId: match.id,
      actorId: input.userId,
      actionType: { in: ["CHEMISTRY_POSITIVE", "CHEMISTRY_NEGATIVE"] },
      createdAt: { gte: match.agreedTime },
    },
    select: { id: true },
  });

  if (!already) {
    await createMatchEvent({
      matchId: match.id,
      actorId: input.userId,
      targetId: peerId,
      actionType: RATINGS[input.rating],
      // The exact answer, plus where it came from. `source` matters as much as
      // the rating: a tap on a lock screen and a considered form answer are
      // different instruments, and analysis that pools them silently would be
      // comparing two things.
      metadata: { source: "live_activity", rating: input.rating },
    });
  }

  // Best effort, and after the write on purpose: the answer is the product,
  // the card coming down is housekeeping. A dead push token must not lose an
  // answer that has already been given.
  await endDateDayActivityAfterVibe(input.userId, input.rating, now).catch(() => undefined);

  return { ok: true };
}
