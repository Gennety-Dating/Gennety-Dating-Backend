import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";

import { requireCanvasAuth } from "../canvas-auth.js";
import { getNextBatchDate } from "../../services/next-batch.js";
import {
  ACTIVE_MATCH_STATUSES,
  pickCurrentMatch,
} from "../../services/active-match-priority.js";
import { deriveDateState, sideOf } from "../../services/date-state.js";
import type { BumpDeck } from "../../services/date-bump.js";

/**
 * `GET /v1/date/state` — everything the Living Canvas draws, in one call
 * (PRODUCT_SPEC §Living Canvas).
 *
 * One endpoint rather than a field on `/v1/matches/current`, for a reason that
 * is easy to get backwards: the canvas has to render for a user with NO match
 * at all — that is `IDLE_EXPLORING`, the state most users are in most of the
 * time — and `/v1/matches/current` answers null there. A screen whose default
 * state its own endpoint cannot express would need a second call to know it is
 * allowed to draw anything, which is how the post-date feedback form ended up
 * undiscoverable on the app rail (§Phase 4).
 *
 * **The blind-decision invariant is enforced upstream, in `deriveDateState`**,
 * and this route adds nothing that could reopen it: it never selects the peer's
 * `acceptedBy*` into the response, and the fields it does return (venue, time)
 * are ones both sides already hold once the match is past `proposed`.
 */
/** One select for both queries, so the two rows cannot describe different things. */
const MATCH_SELECT = {
  id: true,
  status: true,
  userAId: true,
  userBId: true,
  acceptedByA: true,
  acceptedByB: true,
  agreedTime: true,
  feedbackPromptedAt: true,
  feedbackByA: true,
  feedbackByB: true,
  venueName: true,
  venueAddress: true,
  venueLat: true,
  venueLng: true,
  venueGoogleMapsUri: true,
} as const;

export const dateStateRouter: Router = Router();

// Either rail: the canvas is one screen on two clients (see canvas-auth.ts).
dateStateRouter.use(requireCanvasAuth);

dateStateRouter.get("/state", async (req: Request, res: Response): Promise<void> => {
  const userId = req.userId!;
  const now = new Date();

  const [profile, live] = await Promise.all([
    prisma.profile.findUnique({
      where: { userId },
      select: { timeZone: true },
    }),
    prisma.match.findMany({
      where: {
        status: { in: [...ACTIVE_MATCH_STATUSES] },
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      orderBy: { createdAt: "desc" },
      select: MATCH_SELECT,
    }),
  ]);

  // A match still owing feedback is NOT in ACTIVE_MATCH_STATUSES (it is
  // `completed`), which is exactly why §Phase 4 had to add
  // /v1/me/feedback/pending — the app had nothing to discover it from. The
  // canvas needs it for the same reason, so it is a deliberate second query
  // rather than a widened status filter: widening the first one would make a
  // closed match compete with a live one in `pickCurrentMatch`.
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

  // A row that came back from a query keyed on this user but resolves to
  // neither side is corrupt data, not a third participant. Answer as if there
  // were no match rather than guessing a side — the mistake already made once
  // in startPeerWaitShimmer, where "not A, therefore B" aimed a shimmer at a
  // stranger.
  const usable = current && side ? current : null;

  const bump = usable
    ? await prisma.dateBumpSession.findUnique({
        where: { matchId: usable.id },
        select: {
          isVerified: true,
          userAShakeAt: true,
          userBShakeAt: true,
          icebreakerDeck: true,
        },
      })
    : null;

  // The deck belongs on THIS endpoint, not only on the bump response, because
  // `POST /bump` answers the one call that completed the pair — the other side
  // shook first and gets a 200 with no deck at all. Its notification carries
  // the topics as text, but `date-bump.ts` states the division plainly ("the
  // notification says the thing happened; the app draws the deck"), and until
  // now the app had nothing to draw them from.
  //
  // Only the caller's own topics: the deck is per-side and in each side's own
  // language, so shipping both halves would hand every client a screenful of
  // its partner's private prompts for no reason a client could use.
  const deck = bump?.isVerified
    ? ((bump.icebreakerDeck as BumpDeck | null)?.[
        side === "A" ? "topicsForA" : "topicsForB"
      ] ?? [])
    : [];

  const state = deriveDateState({
    match: usable,
    side: side ?? "A",
    bump,
    now,
  });

  res.json({
    state,
    serverNow: now.toISOString(),
    nextDropAt: getNextBatchDate(now).toISOString(),
    // The caller's own city zone. `agreedTime` is an instant and the canvas has
    // to draw it on a wall clock; the device's is wrong for a traveller, who
    // would otherwise read a time neither side meant. Same field, same reason,
    // as `SerializedMatch.timeZone` and `CalendarState.timeZone`.
    timeZone: profile?.timeZone ?? null,
    match: usable
      ? {
          id: usable.id,
          agreedTime: usable.agreedTime?.toISOString() ?? null,
          venue: usable.venueName
            ? {
                name: usable.venueName,
                address: usable.venueAddress,
                lat: usable.venueLat,
                lng: usable.venueLng,
                mapsUri: usable.venueGoogleMapsUri,
              }
            : null,
          // Outside `bump` on purpose: that object is asserted by exact shape
          // so a field claiming "they are here and you are not" cannot be added
          // to it inattentively, and a growing object makes that guard weaker.
          deck,
          bump: {
            // Whether THIS side has shaken, and whether the pair is verified.
            // The peer's individual shake is deliberately not reported: before
            // verification it is the only thing on this screen that could be
            // read as "they are here and you are not", which is a claim about
            // someone's location that the radar's own masking rules (§Date
            // Radar) exist to prevent.
            mine:
              (side === "A" ? bump?.userAShakeAt : bump?.userBShakeAt) != null,
            verified: bump?.isVerified ?? false,
          },
        }
      : null,
  });
});
