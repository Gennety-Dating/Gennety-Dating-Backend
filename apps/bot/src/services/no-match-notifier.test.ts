import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => {
  // The D10 pause runs its status CAS and its `starvationPausedAt` stamp inside
  // one `$transaction`, so the tx client here exposes the SAME mock functions as
  // the top-level client. That keeps every existing `mProfileUpdateMany`
  // assertion working whether the call came from `prisma` or from `tx`.
  const user = { findMany: vi.fn() };
  const match = { findFirst: vi.fn(), count: vi.fn() };
  const noMatchNotice = { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() };
  const profile = { updateMany: vi.fn() };
  return {
    prisma: {
      user,
      match,
      noMatchNotice,
      profile,
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ user, match, noMatchNotice, profile }),
      ),
    },
  };
});

// A mutable copy of the real config, so a test can flip EARLY_STAGE.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, env: { ...actual.env, EARLY_STAGE: true, FIRST_DROP_CALIBRATION_HOURS: 24 } };
});

vi.mock("./ticket-discount.js", () => ({
  grantFamineDiscountIfEligible: vi.fn(),
}));

// D10: mocked as an independent collaborator (it has its own test file,
// account-status-transitions.test.ts) rather than extending the @gennety/db
// mock with the full CAS machinery it needs.
vi.mock("./account-status-transitions.js", () => ({
  transitionAccountStatus: vi.fn(),
}));

// §4.3: the app rail. Mocked rather than exercised — `push.ts` owns token
// lookup and APNs, and both have their own tests; what matters here is WHO it
// is called for and WHAT it carries.
vi.mock("./push.js", () => ({ sendPushToUser: vi.fn() }));

// The Rematch offer is a Telegram DM with a Stars button; mocked so the
// push-only cases below can assert it is not even attempted there, without
// dragging in env flags, the card renderer and InlineKeyboard.
vi.mock("../handlers/matching/rematch.js", () => ({
  sendRematchOfferIfEligible: vi.fn(),
}));

import { prisma } from "@gennety/db";
import {
  sendNoMatchNotices,
  getDropDate,
  waitingNoticeKey,
  waitingPushKeys,
  dueWaitingStep,
  WAITING_NOTICE_MIN_GAP_MS,
  NO_MATCH_PUSH_TYPE,
  leadBoldEntity,
} from "./no-match-notifier.js";
import { grantFamineDiscountIfEligible } from "./ticket-discount.js";
import { transitionAccountStatus } from "./account-status-transitions.js";
import { sendPushToUser } from "./push.js";
import { sendRematchOfferIfEligible } from "../handlers/matching/rematch.js";
import { CADENCE, FAMINE_PAUSE_AFTER_DAYS, WAITING_NOTICE_MILESTONE_DAYS } from "@gennety/shared";
import { env } from "../config.js";

const mutableEnv = env as { EARLY_STAGE: boolean; FIRST_DROP_CALIBRATION_HOURS: number };

// Heterogeneous Prisma/API test doubles accept each method's own arguments and result.
type MockFn = ReturnType<typeof vi.fn<(...args: any[]) => any>>;
const mUserFindMany = (prisma.user as unknown as { findMany: MockFn }).findMany;
const mMatchFindFirst = (prisma.match as unknown as { findFirst: MockFn }).findFirst;
const mMatchCount = (prisma.match as unknown as { count: MockFn }).count;
const mNoticeCreate = (prisma.noMatchNotice as unknown as { create: MockFn }).create;
const mNoticeDeleteMany = (prisma.noMatchNotice as unknown as { deleteMany: MockFn }).deleteMany;
const mProfileUpdateMany = (prisma.profile as unknown as { updateMany: MockFn }).updateMany;
const mTransaction = (prisma as unknown as { $transaction: MockFn }).$transaction;
const mGrant = grantFamineDiscountIfEligible as unknown as MockFn;
const mTransition = transitionAccountStatus as unknown as MockFn;
const mPush = sendPushToUser as unknown as MockFn;
const mRematch = sendRematchOfferIfEligible as unknown as MockFn;

function makeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

// Synchronous stub for the injectable chunk streamer: forwards the FINAL chunk
// to `api.sendMessage` so the existing call-count / body / failure assertions
// keep working, without real waits.
function makeStream() {
  return vi.fn(
    async (a: { sendMessage: MockFn }, chatId: number, chunks: string[]) => {
      await a.sendMessage(chatId, chunks[chunks.length - 1]);
      return undefined;
    },
  );
}

const NOW = new Date("2026-05-07T15:15:00Z"); // Thursday 18:15 Kyiv (UTC+3 summer)
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Waiting-ladder anchors. Days are whole UTC calendar days from the anchor to
 * `getDropDate(NOW)`, so an anchor placed at that midnight minus N days is
 * exactly N days of waiting — no boundary rounding to reason about.
 */
function daysAgo(days: number, now: Date = NOW): Date {
  return new Date(getDropDate(now).getTime() - days * DAY_MS);
}

/** A last match exactly on the given ladder step's day (1-based). */
function dispatchedForStep(step: number, now: Date = NOW): Date {
  return daysAgo(WAITING_NOTICE_MILESTONE_DAYS[step - 1]!, now);
}

/**
 * Default fixture anchor for a never-matched account with no calibration
 * window: `createdAt` exactly at step 1 (day 4), so the plain fixtures below
 * are owed the first notice — and nothing past it (day 7 is step 2, which
 * carries the famine discount).
 */
const WAITED_TO_STEP_1 = dispatchedForStep(1);

describe("getDropDate", () => {
  it("floors to UTC midnight of the same day", () => {
    expect(getDropDate(NOW).toISOString()).toBe("2026-05-07T00:00:00.000Z");
  });
});

describe("waiting ladder helpers", () => {
  it("has DM and push copy for every step, with an early-stage variant for step 1", () => {
    WAITING_NOTICE_MILESTONE_DAYS.forEach((_, i) => {
      const step = i + 1;
      expect(waitingNoticeKey(step, false)).toBe(`waitingNotice${step}`);
      expect(waitingPushKeys(step)).toEqual([`waitingPush${step}Title`, `waitingPush${step}Body`]);
    });
    expect(waitingNoticeKey(1, true)).toBe("waitingNotice1Early");
    expect(waitingNoticeKey(2, true)).toBe("waitingNotice2");
  });

  it("owes exactly the latest reached step, once", () => {
    const anchor = daysAgo(0, new Date("2026-01-01T15:00:00Z"));
    const at = (days: number) => new Date(anchor.getTime() + days * DAY_MS);
    expect(WAITING_NOTICE_MILESTONE_DAYS).toEqual([4, 7, 10, 21, 45]);
    expect(dueWaitingStep(anchor, at(3), null)).toBe(0);
    expect(dueWaitingStep(anchor, at(4), null)).toBe(1);
    expect(dueWaitingStep(anchor, at(6), at(4))).toBe(0);
    expect(dueWaitingStep(anchor, at(7), at(4))).toBe(2);
    expect(dueWaitingStep(anchor, at(9), at(7))).toBe(0);
    expect(dueWaitingStep(anchor, at(10), at(7))).toBe(3);
    expect(dueWaitingStep(anchor, at(30), at(4))).toBe(4);
    expect(dueWaitingStep(anchor, at(44), at(21))).toBe(0);
    expect(dueWaitingStep(anchor, at(45), at(21))).toBe(5);
    expect(dueWaitingStep(anchor, at(400), at(45))).toBe(0);
  });

  it("prefilters on the ladder's smallest gap (3 days)", () => {
    expect(WAITING_NOTICE_MIN_GAP_MS).toBe(3 * DAY_MS);
  });
});

describe("sendNoMatchNotices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutableEnv.EARLY_STAGE = true;
    mutableEnv.FIRST_DROP_CALIBRATION_HOURS = 24;
    mNoticeCreate.mockResolvedValue({});
    mNoticeDeleteMany.mockResolvedValue({ count: 1 });
    // Default: feature off / not granted (the grant self-gates on the flag).
    mGrant.mockResolvedValue({ granted: false });
    // D10 defaults: none of the tier-focused tests below reach
    // FAMINE_PAUSE_AFTER_DAYS, but a default is set anyway so a stray call
    // never throws "not a function" against an un-primed mock.
    mTransition.mockResolvedValue({ kind: "changed" });
    mProfileUpdateMany.mockResolvedValue({ count: 1 });
    // §4.3 defaults: APNs accepted it. Every fixture WITHOUT a `platform` is a
    // pre-column Telegram row, so the push leg isn't reached at all there.
    mPush.mockResolvedValue(true);
    mRematch.mockResolvedValue(false);
    // A13-H10 default: nobody holds a live match at send time.
    mMatchCount.mockResolvedValue(0);
  });

  // ── A13-H10: "we couldn't find anyone" only for people who have nobody ─────
  //
  // The exclusion used to be "a match dispatched in the last hour", so anyone
  // mid-negotiation, on a scheduled date, or whose drop pitch was still queued
  // behind a slow dispatch was told nobody had been found.

  it("(A13-H10) excludes anyone holding a live match — including an undispatched proposal — on both sides", async () => {
    mUserFindMany.mockResolvedValueOnce([]);

    await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

    const arg = mUserFindMany.mock.calls[0]![0] as {
      where: { AND: Array<Record<string, unknown>> };
    };
    for (const relation of ["matchesAsA", "matchesAsB"]) {
      const clause = arg.where.AND.find((c) => relation in c) as Record<
        string,
        { none: { OR: Array<Record<string, unknown>> } }
      >;
      expect(clause).toBeDefined();
      const branches = clause[relation]!.none.OR;
      expect(branches).toContainEqual({
        status: { in: ["proposed", "negotiating", "negotiating_venue", "scheduled"] },
      });
      // The status branch carries no `dispatchedAt` condition: a `proposed`
      // row still waiting for its pitch counts as a match.
      expect(branches.some((b) => "status" in b && "dispatchedAt" in b)).toBe(false);
    }
  });

  it("(A13-H10) only considers accounts that existed when the drop ran", async () => {
    mUserFindMany.mockResolvedValueOnce([]);

    await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

    const arg = mUserFindMany.mock.calls[0]![0] as { where: { createdAt: { lt: Date } } };
    // NOW is Thursday 18:15 Kyiv; the drop it is about ran at 18:00.
    expect(arg.where.createdAt.lt.toISOString()).toBe("2026-05-07T15:00:00.000Z");
  });

  it("(A13-H10) skips a candidate who was handed a match after the page was read, without claiming", async () => {
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" }]);
    mMatchCount.mockResolvedValueOnce(1);
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mNoticeCreate).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("(A13-H10) never pauses someone whose match landed between the check and the pause", async () => {
    mutableEnv.EARLY_STAGE = false;
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" }]);
    mMatchFindFirst.mockResolvedValueOnce({
      dispatchedAt: new Date(getDropDate(NOW).getTime() - (FAMINE_PAUSE_AFTER_DAYS + 3) * DAY_MS),
    });
    // Free at the pre-claim check, holding a match inside the pause transaction.
    mMatchCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const api = makeApi();

    const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(mTransition).not.toHaveBeenCalled();
    expect(result.paused).toBe(0);
    expect(result.notified).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
    // The claim is released: nothing about a famine is true of them now.
    expect(mNoticeDeleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", dropDate: getDropDate(NOW) },
    });
  });

  // ── A13-M22: quiet hours ────────────────────────────────────────────────

  it("(A13-M22) does not start sending inside quiet hours, and says it was held", async () => {
    const lateEvening = new Date("2026-05-07T20:30:00Z"); // 23:30 Kyiv

    const result = await sendNoMatchNotices(makeApi() as never, lateEvening, 0, makeStream() as never);

    expect(result.heldForQuietHours).toBe(true);
    expect(mUserFindMany).not.toHaveBeenCalled();
    expect(mNoticeCreate).not.toHaveBeenCalled();
  });

  it("(A13-M22) stops at 23:00 mid-run and leaves the rest unclaimed for the next run", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" },
      { id: "u2", telegramId: 222n, createdAt: WAITED_TO_STEP_1, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValue(null);
    // The run starts at 18:15 Kyiv; the first notice takes it past 23:00.
    const realNow = Date.now();
    let elapsedMs = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow + elapsedMs);
    const api = makeApi();
    const inner = makeStream();
    const stream = vi.fn(async (...args: Parameters<typeof inner>) => {
      await inner(...args);
      elapsedMs = 5 * 60 * 60 * 1000;
    });

    try {
      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(result.notified).toBe(1);
      expect(result.heldForQuietHours).toBe(true);
      expect(mNoticeCreate).toHaveBeenCalledTimes(1);
      expect(mNoticeCreate.mock.calls[0]![0]).toMatchObject({ data: { userId: "u1" } });
    } finally {
      clock.mockRestore();
    }
  });

  it("(D4) prefilters candidate selection to the ladder's smallest gap (3 days), not the exact drop day", async () => {
    // The candidate query must exclude anyone notified more recently than
    // WAITING_NOTICE_MIN_GAP_MS (3 days: no two ladder steps are closer) —
    // this is what decouples "how often the batch/cron fires" from "how often
    // a starved user actually gets a DM" (D4). Asserting on the query shape
    // directly since the mocked Prisma client doesn't evaluate `where` itself.
    mUserFindMany.mockResolvedValueOnce([]);

    await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

    const arg = mUserFindMany.mock.calls[0]![0] as {
      where: { AND: Array<Record<string, unknown>> };
    };
    const throttleClause = arg.where.AND.find(
      (c) => "noMatchNotices" in c,
    ) as { noMatchNotices: { none: { dropDate: { gte: Date } } } };
    expect(throttleClause).toBeDefined();
    const cutoff = throttleClause.noMatchNotices.none.dropDate.gte;
    const expectedCutoff = NOW.getTime() - 3 * DAY_MS;
    expect(Math.abs(cutoff.getTime() - expectedCutoff)).toBeLessThan(1000);
    // Narrower than the market-pending weekly throttle, which is therefore
    // enforced per person (see the market-pending throttle test below).
    expect(NOW.getTime() - cutoff.getTime()).toBeLessThan(CADENCE.famineNoticeIntervalMs);
  });

  it("returns zero counts when no candidates are eligible", async () => {
    mUserFindMany.mockResolvedValueOnce([]);
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(0);
    expect(result.tier1).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(mNoticeCreate).not.toHaveBeenCalled();
  });

  // ── The run is paged, and the paging cannot spin ────────────────────────
  //
  // It used to read the whole active base in one `findMany` and then sleep two
  // seconds between every send: ten thousand people is five and a half hours of
  // one cron invocation, long enough that `guardedTick` swallows every later
  // firing and a restart loses the tail.

  it("keeps reading while a page comes back full", async () => {
    const page = Array.from({ length: 500 }, (_, index) => ({
      id: `full-${index}`,
      telegramId: BigInt(1000 + index), createdAt: WAITED_TO_STEP_1,
      language: "en",
    }));
    mUserFindMany
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([{ id: "tail", telegramId: 999n, createdAt: WAITED_TO_STEP_1, language: "en" }]);
    mMatchFindFirst.mockResolvedValue(null);

    const result = await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

    // The claim written for each person is what excludes them from the next
    // read, so the walk moves forward without a cursor of its own.
    expect(mUserFindMany).toHaveBeenCalledTimes(2);
    expect(mUserFindMany.mock.calls[0]![0].take).toBe(500);
    expect(result.notified).toBe(501);
  });

  it("walks past a full page of people owed nothing to reach the next page", async () => {
    // Most of the base is owed no notice on a given evening and gets no claim,
    // so the claim can't move the read forward; the id cursor does.
    const quiet = Array.from({ length: 500 }, (_, index) => ({
      id: `q-${String(index).padStart(3, "0")}`,
      telegramId: BigInt(2000 + index),
      createdAt: daysAgo(3),
      language: "en",
    }));
    mUserFindMany
      .mockResolvedValueOnce(quiet)
      .mockResolvedValueOnce([{ id: "r-tail", telegramId: 999n, createdAt: WAITED_TO_STEP_1, language: "en" }]);
    mMatchFindFirst.mockResolvedValue(null);

    const result = await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

    expect(result.waiting).toBe(500);
    expect(result.notified).toBe(1);
    expect(mUserFindMany.mock.calls[0]![0].where.id).toBeUndefined();
    expect(mUserFindMany.mock.calls[1]![0].where.id).toEqual({ gt: "q-499" });
  });

  it("stops instead of spinning on somebody it can never reach", async () => {
    // A person on no rail at all gets NO notice row — deliberately — so the
    // query cannot exclude them and would hand them back on every read. Without
    // the seen-set the run would loop until the page cap, re-deciding the same
    // person forty times.
    const unreachable = Array.from({ length: 500 }, (_, index) => ({
      id: `ghost-${index}`,
      telegramId: BigInt(-7 - index), createdAt: WAITED_TO_STEP_1,
      platform: "ios",
      language: "en",
    }));
    mUserFindMany.mockResolvedValue(unreachable);

    const result = await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

    expect(result.skipped).toBe(500);
    expect(result.notified).toBe(0);
    // Two reads: the first yields the one fresh person, the second yields
    // nobody new and ends the walk.
    expect(mUserFindMany).toHaveBeenCalledTimes(2);
    expect(mNoticeCreate).not.toHaveBeenCalled();
  });

  // ── The waiting ladder (founder decision 2026-10-15) ───────────────────
  //
  // Silence by default; one notice per step of WAITING_NOTICE_MILESTONE_DAYS
  // (4, 7, 10, 21, 45 days without a pair), each with its own copy.

  it("sends step 1 at day 4 for a never-matched user, with the early-stage copy", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(1);
    expect(result.tier1).toBe(1);
    expect(result.tier2).toBe(0);
    expect(result.tier3plus).toBe(0);

    const [chatId, body] = api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(111);
    expect(body).toMatch(/^Still looking\n\n/);
    expect(body).toMatch(/only just opened/);
    // Streamed as a short 2-chunk reveal: a "thinking" lead beat, then the
    // full body (no `parse_mode` — the bold heading rides as an entity).
    const chunks = stream.mock.calls[0]![2] as string[];
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatch(/candidates/i);
    expect(chunks[1]).toMatch(/^Still looking\n\n/);
    expect((stream.mock.calls[0] as unknown[])[3]).toMatchObject({
      entities: [{ type: "bold", offset: 0, length: "Still looking".length }],
    });

    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 1, dropDate: getDropDate(NOW) },
    });
  });

  it("uses the neutral step-1 copy once EARLY_STAGE is off", async () => {
    mutableEnv.EARLY_STAGE = false;
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "ru" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForStep(1) });
    const api = makeApi();

    await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/^Ищу дальше\n\n/);
    expect(body).not.toMatch(/только открылся/);
  });

  it("says nothing on days 1–3 — silence is the default, and nothing is claimed", async () => {
    for (const days of [1, 2, 3]) {
      mUserFindMany.mockResolvedValueOnce([
        { id: `d${days}`, telegramId: 111n, createdAt: daysAgo(days), language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(result.notified).toBe(0);
      expect(result.waiting).toBe(1);
      expect(result.skipped).toBe(0);
      expect(stream).not.toHaveBeenCalled();
      expect(mPush).not.toHaveBeenCalled();
    }
    expect(mNoticeCreate).not.toHaveBeenCalled();
    expect(mGrant).not.toHaveBeenCalled();
  });

  it("anchors a never-matched user to onboarding completion (calibration window start), not to a notice", async () => {
    // Onboarded 3 days ago: the window was armed then and ended 2 days ago.
    // createdAt is much older (an account that sat in onboarding) — it must
    // not be what the wait is counted from.
    const onboardedAt = daysAgo(3);
    mUserFindMany.mockResolvedValueOnce([
      {
        id: "u1",
        telegramId: 111n,
        createdAt: daysAgo(60),
        language: "en",
        profile: { calibrationUntil: new Date(onboardedAt.getTime() + 24 * 60 * 60 * 1000) },
        noMatchNotices: [],
      },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();

    const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(result.waiting).toBe(1);
    expect(result.notified).toBe(0);

    // One day later, the same account reaches day 4 and hears from us.
    mUserFindMany.mockResolvedValueOnce([
      {
        id: "u1",
        telegramId: 111n,
        createdAt: daysAgo(60),
        language: "en",
        profile: { calibrationUntil: new Date(daysAgo(4).getTime() + 24 * 60 * 60 * 1000) },
      },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);

    const next = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(next.tier1).toBe(1);
  });

  it("sends step 2 at day 7 with the famine discount", async () => {
    mUserFindMany.mockResolvedValueOnce([
      {
        id: "u1",
        telegramId: 111n,
        createdAt: WAITED_TO_STEP_1,
        language: "ru",
        noMatchNotices: [{ dropDate: daysAgo(3) }], // the day-4 notice
      },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForStep(2) });
    mGrant.mockResolvedValueOnce({ granted: true, pct: 77, expiresAt: new Date() });
    const api = makeApi();

    const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(result.tier2).toBe(1);
    expect(result.tier1).toBe(0);
    expect(mGrant).toHaveBeenCalledWith("u1");

    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/^Подбор идёт\n\n/);
    expect(body).toMatch(/77%/);
    // Holds the position — no apologies, no thanks for waiting, no priority.
    expect(body).not.toMatch(/Спасибо|ждёшь|извин|к сожалению|приоритет/i);

    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 2, dropDate: getDropDate(NOW) },
    });
  });

  it("does not repeat a step that was already told", async () => {
    // Day 30: step 4 began on day 21, and a notice went out on day 22.
    mUserFindMany.mockResolvedValueOnce([
      {
        id: "u1",
        telegramId: 111n,
        createdAt: WAITED_TO_STEP_1,
        language: "en",
        noMatchNotices: [{ dropDate: daysAgo(8) }],
      },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: daysAgo(30) });

    const result = await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

    expect(result.waiting).toBe(1);
    expect(result.notified).toBe(0);
    expect(mNoticeCreate).not.toHaveBeenCalled();
  });

  it("collapses skipped steps into ONE notice for the latest step", async () => {
    // Day 30, last heard from us on day 4: steps 2 and 3 were missed (paused,
    // unreachable). They get step 4 only — not a back-to-back catch-up.
    mUserFindMany.mockResolvedValueOnce([
      {
        id: "u1",
        telegramId: 111n,
        createdAt: WAITED_TO_STEP_1,
        language: "en",
        noMatchNotices: [{ dropDate: daysAgo(26) }],
      },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: daysAgo(30) });
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(1);
    expect(result.tier3plus).toBe(1);
    expect(stream).toHaveBeenCalledTimes(1);
    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/^Still searching\n\n/);
    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 4, dropDate: getDropDate(NOW) },
    });
  });

  it("sends the last step at day 45 and then never again", async () => {
    mUserFindMany.mockResolvedValueOnce([
      {
        id: "u1",
        telegramId: 111n,
        createdAt: WAITED_TO_STEP_1,
        language: "en",
        noMatchNotices: [{ dropDate: daysAgo(24) }], // the day-21 notice
      },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: daysAgo(45) });
    const api = makeApi();

    const last = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(last.notified).toBe(1);
    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/^From now on, only news\n\n/);
    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 5, dropDate: getDropDate(NOW) },
    });

    // Every later evening, however long the wait: silence.
    for (const days of [52, 100, 365]) {
      mUserFindMany.mockResolvedValueOnce([
        {
          id: "u1",
          telegramId: 111n,
          createdAt: WAITED_TO_STEP_1,
          language: "en",
          noMatchNotices: [{ dropDate: daysAgo(days - 45) }],
        },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: daysAgo(days) });
      const later = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);
      expect(later.notified).toBe(0);
      expect(later.waiting).toBe(1);
    }
    expect(mNoticeCreate).toHaveBeenCalledTimes(1);
  });

  it("pushes the step's own title and line to the app", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "app", telegramId: -42n, createdAt: WAITED_TO_STEP_1, platform: "mobile", language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForStep(3) });

    await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

    expect(mPush.mock.calls[0]![1]).toMatchObject({
      title: "I'm here",
      body: "Matching runs on its own, every evening.",
      data: { type: NO_MATCH_PUSH_TYPE },
    });
  });

  it("never pauses during the early stage, however long the wait", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: daysAgo(FAMINE_PAUSE_AFTER_DAYS + 20) });
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.paused).toBe(0);
    expect(mTransition).not.toHaveBeenCalled();
    expect(mTransaction).not.toHaveBeenCalled();
    // Day 48 → step 5 (the last), told on the ordinary stream.
    expect(stream).toHaveBeenCalledTimes(1);
    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/^From now on, only news\n\n/);
    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 5, dropDate: getDropDate(NOW) },
    });
  });

  // With EARLY_STAGE off the D10 pause is back exactly as it was.
  describe("D10: pool-exhaustion pause (EARLY_STAGE off)", () => {
    function dispatchedDaysAgo(days: number, now: Date = NOW): Date {
      return new Date(getDropDate(now).getTime() - days * DAY_MS);
    }

    beforeEach(() => {
      mutableEnv.EARLY_STAGE = false;
    });

    it("pauses instead of sending another tier DM once FAMINE_PAUSE_AFTER_DAYS is reached", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
      });
      const api = makeApi();

      const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(result.paused).toBe(1);
      expect(result.tier1).toBe(0);
      expect(result.tier2).toBe(0);
      expect(result.tier3plus).toBe(0);
      expect(result.notified).toBe(1);

      // Pause is a plain send (states a fact), not the rich empathy stream.
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      const [, body] = api.sendMessage.mock.calls[0]!;
      expect(body).toMatch(/Pausing your search/);

      // The CAS + the profile marker stamp both fired — and both ran against
      // the transaction client, not the bare prisma client (NOMATCH-2).
      expect(mTransition).toHaveBeenCalledWith(
        { id: "u1" },
        "pause",
        expect.anything(),
      );
      expect(mProfileUpdateMany).toHaveBeenCalledWith({
        where: { userId: "u1" },
        data: { starvationPausedAt: NOW },
      });
      expect(mTransaction).toHaveBeenCalledTimes(1);
    });

    it("does not grant the famine discount or offer Rematch on a pause", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS + 5),
      });
      const api = makeApi();

      await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(mGrant).not.toHaveBeenCalled();
    });

    it("falls back to the owed ladder step's DM when the pause CAS loses a race", async () => {
      // Simulates the candidate having moved off `active` (moderation, a
      // manual pause/freeze) between candidate selection and this point.
      mUserFindMany.mockResolvedValueOnce([
        { id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
      });
      mTransition.mockResolvedValueOnce({ kind: "forbidden" });
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(result.paused).toBe(0);
      // Day 28 → step 4 (day 21) is owed.
      expect(result.tier3plus).toBe(1);
      expect(mNoticeCreate).toHaveBeenCalledWith({
        data: { userId: "u1", tier: 4, dropDate: getDropDate(NOW) },
      });
      expect(mProfileUpdateMany).not.toHaveBeenCalled();
      // Falls through to the ordinary rich stream, not the plain pause send.
      expect(stream).toHaveBeenCalled();
      expect(api.sendMessage.mock.calls[0]![1]).toMatch(/^Still searching\n\n/);
    });

    it("stays silent when the pause CAS loses a race and no step is owed", async () => {
      mUserFindMany.mockResolvedValueOnce([
        {
          id: "u1",
          telegramId: 111n,
          createdAt: WAITED_TO_STEP_1,
          language: "en",
          noMatchNotices: [{ dropDate: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS - 22) }],
        },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
      });
      mTransition.mockResolvedValueOnce({ kind: "forbidden" });
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(result.notified).toBe(0);
      expect(result.waiting).toBe(1);
      expect(stream).not.toHaveBeenCalled();
      expect(mNoticeDeleteMany).toHaveBeenCalledWith({
        where: { userId: "u1", dropDate: getDropDate(NOW) },
      });
    });

    it("pushes the pause's own title and line, not 'the search stays on'", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "app", telegramId: -42n, createdAt: WAITED_TO_STEP_1, platform: "mobile", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
      });

      await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

      expect(mPush.mock.calls[0]![1]).toMatchObject({ title: "Pausing your search" });
      expect(JSON.stringify(mPush.mock.calls[0]![1])).not.toMatch(/stays on/);
    });

    // NOMATCH-2 — the pause must never become a state the product cannot undo.
    // `autoResumeStarvedUsers` selects `paused AND starvationPausedAt != null`,
    // and this notifier only ever selects `active`, so a pause that lands
    // without its marker (or without its DM) is invisible to both sweeps: the
    // user is silently and permanently out of the pool.
    describe("NOMATCH-2: the pause is always reversible", () => {
      it("does not leave the account paused when the marker stamp fails", async () => {
        mUserFindMany.mockResolvedValueOnce([
          { id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" },
        ]);
        mMatchFindFirst.mockResolvedValueOnce({
          dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
        });
        // The status CAS succeeds, the marker write blows up. Both are inside
        // one transaction, so the CAS must roll back with it.
        mProfileUpdateMany.mockRejectedValueOnce(new Error("db blip"));
        const api = makeApi();

        const result = await sendNoMatchNotices(
          api as never,
          NOW,
          0,
          makeStream() as never,
        );

        expect(result.paused).toBe(0);
        expect(result.failed).toBe(1);
        // Nothing claims the user was notified, and the notice row is undone
        // so the next run can retry the whole decision.
        expect(mNoticeDeleteMany).toHaveBeenCalled();

        // The load-bearing assertion. `transitionAccountStatus` is mocked, so
        // the rollback itself can't be observed here — what CAN be observed is
        // the property that guarantees it against a real database: the status
        // CAS ran on the transaction client, in the same transaction as the
        // marker write that just threw. Against the two-independent-writes
        // version this fails, because no transaction is opened at all.
        expect(mTransaction).toHaveBeenCalledTimes(1);
        expect(mTransition).toHaveBeenCalledWith(
          { id: "u1" },
          "pause",
          expect.anything(),
        );
      });

      it("resumes the account when the pause committed but the DM never landed", async () => {
        mUserFindMany.mockResolvedValueOnce([
          { id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" },
        ]);
        mMatchFindFirst.mockResolvedValueOnce({
          dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
        });
        const api = makeApi();
        // The pause commits, then Telegram refuses the send (blocked bot, etc).
        api.sendMessage.mockRejectedValueOnce(new Error("bot was blocked"));

        const result = await sendNoMatchNotices(
          api as never,
          NOW,
          0,
          makeStream() as never,
        );

        expect(result.paused).toBe(0);
        expect(result.failed).toBe(1);
        // The account is put back so the next run re-evaluates and re-sends,
        // rather than stranding a user who was paused and never told.
        expect(mTransition).toHaveBeenCalledWith({ id: "u1" }, "resume");
        expect(mNoticeDeleteMany).toHaveBeenCalled();
      });

      it("does not attempt a resume when no pause was taken", async () => {
        mUserFindMany.mockResolvedValueOnce([
          { id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" },
        ]);
        // Step 2 (day 7), comfortably short of the pause threshold.
        mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForStep(2) });
        const api = makeApi();
        const stream = makeStream();
        stream.mockRejectedValueOnce(new Error("send failed"));

        const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

        expect(result.failed).toBe(1);
        expect(mTransition).not.toHaveBeenCalled();
      });
    });

    it("never pauses a market-pending user, however long they've waited", async () => {
      mUserFindMany.mockResolvedValueOnce([
        {
          id: "u1",
          telegramId: 111n, createdAt: WAITED_TO_STEP_1,
          language: "en",
          profile: { homeCityKey: "de:berlin", homeCity: "Berlin" },
        },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS + 100),
      });
      const api = makeApi();

      const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(result.paused).toBe(0);
      expect(mTransition).not.toHaveBeenCalled();
      const [, body] = api.sendMessage.mock.calls[0]!;
      expect(body).toMatch(/Berlin/);
    });
  });

  // §4.3: a negative id is no longer what makes this a skip — the absence of
  // BOTH rails is. This row claims no `platform`, so there is no app rail to
  // fall back to, and it stays the one case the service genuinely cannot
  // reach. No `NoMatchNotice` is written for it: that row is the anchor the
  // next tier is measured from, and a notice nobody received must not age a
  // famine streak.
  it("skips a user reachable on neither rail, without a DB write or a push", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "tg", telegramId: 555n, createdAt: WAITED_TO_STEP_1, language: "en" },
      { id: "nowhere", telegramId: -42n, createdAt: WAITED_TO_STEP_1, platform: null, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValue(null);
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(1);
    expect(result.skipped).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(mPush).not.toHaveBeenCalled();
    expect(mNoticeCreate).toHaveBeenCalledTimes(1);
    expect(mNoticeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "tg" }) }),
    );
  });

  it("continues on send failure and reports the error", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" },
      { id: "u2", telegramId: 222n, createdAt: WAITED_TO_STEP_1, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValue(null);
    const api = makeApi();
    const stream = makeStream();
    api.sendMessage
      .mockRejectedValueOnce(new Error("Telegram 403: blocked"))
      .mockResolvedValueOnce(undefined);

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]!.userId).toBe("u1");
    expect(result.errors[0]!.error).toMatch(/403/);
    // Claims are persisted before the side effect so overlapping workers
    // cannot both send the same notice.
    expect(mNoticeCreate).toHaveBeenCalledTimes(2);
    expect(mNoticeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "u2" }) }),
    );
    // (NOMATCH-1) u1's send failed after its claim was made — the claim is
    // rolled back so a retry can find them again instead of a failed send
    // permanently masquerading as "notified".
    expect(mNoticeDeleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", dropDate: getDropDate(NOW) },
    });
    expect(mNoticeDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("(NOMATCH-1) does not roll back the claim when the send succeeds", async () => {
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" }]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();

    await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(mNoticeCreate).toHaveBeenCalledTimes(1);
    expect(mNoticeDeleteMany).not.toHaveBeenCalled();
  });

  it("(NOMATCH-1) skips (not fails) a user whose claim races another invocation", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" },
      { id: "u2", telegramId: 222n, createdAt: WAITED_TO_STEP_1, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValue(null);
    const raceError = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    mNoticeCreate.mockRejectedValueOnce(raceError).mockResolvedValueOnce({});
    const api = makeApi();

    const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    // u1 lost the claim race — skipped, not counted as a failure, and never
    // sent a message (an overlapping worker already owns that notice).
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.notified).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]![0]).toBe(222);
  });

  it("tier 1 never attempts the famine discount grant", async () => {
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" }]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();

    await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(mGrant).not.toHaveBeenCalled();
  });

  it("tier 2 grants the discount and appends the offer line to the DM", async () => {
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" }]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForStep(2) }); // step 2 (day 7)
    mGrant.mockResolvedValueOnce({ granted: true, pct: 77, expiresAt: new Date() });
    const api = makeApi();

    await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(mGrant).toHaveBeenCalledWith("u1");
    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/77% off/);
  });

  it("tier 2 with the feature off (grant returns granted:false) appends nothing", async () => {
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: "en" }]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForStep(2) }); // step 2 (day 7)
    // default mGrant → { granted: false }
    const api = makeApi();

    await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(mGrant).toHaveBeenCalledWith("u1");
    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).not.toMatch(/% off/);
  });

  // Kyiv-only market gate (PRODUCT_SPEC §1.1/§3.1).
  it("tells a user in an unlaunched city the truth instead of a famine tier", async () => {
    mUserFindMany.mockResolvedValueOnce([
      {
        id: "u1",
        telegramId: 111n, createdAt: WAITED_TO_STEP_1,
        language: "en",
        profile: { homeCityKey: "de:berlin", homeCity: "Berlin" },
      },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForStep(4) }); // 21 days: would be step 4 + a famine discount
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(1);
    // Plain send with the switch button, not the "we really looked" stream.
    expect(stream).not.toHaveBeenCalled();
    const [chatId, body, options] = api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(111);
    expect(body).toMatch(/Berlin/);
    expect(body).not.toMatch(/Still looking/);
    expect(JSON.stringify(options.reply_markup)).toContain("menu:city:switch");
    // No famine discount for a drop they were never in.
    expect(mGrant).not.toHaveBeenCalled();
    // The notice row still lands, so the drop stays idempotent.
    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 3, dropDate: getDropDate(NOW) },
    });
  });

  it("keeps a market-pending account on the weekly throttle, not the ladder's 3-day prefilter", async () => {
    // The query only hides people notified within the last 3 days, so a
    // market-pending account told 5 days ago comes back as a candidate — and
    // must still be held until famineNoticeIntervalMs (7 days) has passed.
    expect(CADENCE.famineNoticeIntervalMs).toBe(7 * DAY_MS);
    const berlin = { homeCityKey: "de:berlin", homeCity: "Berlin" };
    mUserFindMany.mockResolvedValueOnce([
      {
        id: "recent",
        telegramId: 111n,
        createdAt: WAITED_TO_STEP_1,
        language: "en",
        profile: berlin,
        noMatchNotices: [{ dropDate: daysAgo(5) }],
      },
      {
        id: "due",
        telegramId: 222n,
        createdAt: WAITED_TO_STEP_1,
        language: "en",
        profile: berlin,
        noMatchNotices: [{ dropDate: daysAgo(8) }],
      },
    ]);
    mMatchFindFirst.mockResolvedValue({ dispatchedAt: daysAgo(30) });
    const api = makeApi();

    const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(result.waiting).toBe(1);
    expect(result.notified).toBe(1);
    expect(mNoticeCreate).toHaveBeenCalledTimes(1);
    expect(mNoticeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "due" }) }),
    );
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, body] = api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(222);
    expect(body).toMatch(/Berlin/);
    expect(mGrant).not.toHaveBeenCalled();
  });

  it("keeps the ordinary famine copy for a user in a launched city", async () => {
    mUserFindMany.mockResolvedValueOnce([
      {
        id: "u1",
        telegramId: 111n, createdAt: WAITED_TO_STEP_1,
        language: "en",
        profile: { homeCityKey: "ua:kyiv", homeCity: "Kyiv" },
      },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();
    const stream = makeStream();

    await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(stream).toHaveBeenCalled();
    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/Still looking/);
  });

  it("defaults to English when the user has no language set", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, createdAt: WAITED_TO_STEP_1, language: null },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();
    const stream = makeStream();

    await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/Still looking/);
  });

  /**
   * §4.3 — "no match this drop" reaches the app.
   *
   * The same class of defect `pre-date-safety.ts` fixed in §5.4: one filter
   * (`telegramId <= 0n`) was answering two different questions — whether this
   * person should be told, and which rail can tell them. The candidate query
   * answers the first. `telegramReachable` / `pushReachable` answer the second,
   * per user, and `both` means both.
   */
  describe("§4.3: the app rail", () => {
    function dispatchedDaysAgo(days: number, now: Date = NOW): Date {
      return new Date(getDropDate(now).getTime() - days * DAY_MS);
    }

    it("pushes to a user on the app and sends them no DM", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "app", telegramId: -42n, createdAt: WAITED_TO_STEP_1, platform: "mobile", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      // Told, counted, and tiered exactly like anyone else — the rail is not
      // the product, it is the transport.
      expect(result.notified).toBe(1);
      expect(result.tier1).toBe(1);
      expect(result.skipped).toBe(0);
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
      expect(mPush).toHaveBeenCalledTimes(1);
      expect(mPush.mock.calls[0]![0]).toBe("app"); // internal id, not telegramId
      // The idempotency row still lands, so a re-run doesn't re-notify.
      expect(mNoticeCreate).toHaveBeenCalledWith({
        data: { userId: "app", tier: 1, dropDate: getDropDate(NOW) },
      });
    });

    it("DMs a Telegram user and sends them no push", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "tg", telegramId: 555n, createdAt: WAITED_TO_STEP_1, platform: "telegram", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(result.notified).toBe(1);
      expect(stream).toHaveBeenCalledTimes(1);
      expect(mPush).not.toHaveBeenCalled();
    });

    it("carries both rails for a user on Telegram AND the app", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "both", telegramId: 777n, createdAt: WAITED_TO_STEP_1, platform: "both", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(stream).toHaveBeenCalledTimes(1);
      expect(mPush).toHaveBeenCalledTimes(1);
      // One person, one notice — `notified` counts people, not messages.
      expect(result.notified).toBe(1);
      expect(mNoticeCreate).toHaveBeenCalledTimes(1);
    });

    it("keeps DMing a row older than the platform column", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "legacy", telegramId: 111n, createdAt: WAITED_TO_STEP_1, platform: null, language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(result.notified).toBe(1);
      expect(stream).toHaveBeenCalledTimes(1);
      expect(mPush).not.toHaveBeenCalled();
    });

    // The silent half of the defect. `platform` missing from the SELECT does
    // not throw — it arrives `undefined`, which `telegramReachable` reads as
    // "pre-column row, assume Telegram" for EVERY candidate, so the whole app
    // side is addressed on a rail it cannot hear.
    it("selects platform in the candidate query", async () => {
      mUserFindMany.mockResolvedValueOnce([]);

      await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

      const arg = mUserFindMany.mock.calls[0]![0] as {
        select: Record<string, unknown>;
      };
      expect(arg.select.platform).toBe(true);
    });

    // The type is the client's routing key for the tap, and the payload's
    // shape is part of the frozen contract: there is no match, so there is
    // no `matchId` to carry.
    it("sends the type the client routes on, with no matchId", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "app", telegramId: -42n, createdAt: WAITED_TO_STEP_1, platform: "mobile", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);

      await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

      expect(NO_MATCH_PUSH_TYPE).toBe("match.none");
      const payload = mPush.mock.calls[0]![1] as { data: Record<string, unknown> };
      expect(payload.data).toEqual({ type: "match.none" });
      expect(payload.data).not.toHaveProperty("matchId");
    });

    // Direct analogue of the pre-date-safety guard: one rail's failure is not
    // allowed to cost the other rail, the claim, or the pause.
    it("survives a push failure without losing the DM or the claim", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "both", telegramId: 777n, createdAt: WAITED_TO_STEP_1, platform: "both", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      mPush.mockRejectedValueOnce(new Error("apns down"));
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(result.notified).toBe(1);
      expect(result.failed).toBe(0);
      expect(stream).toHaveBeenCalledTimes(1);
      expect(mNoticeDeleteMany).not.toHaveBeenCalled();
    });

    it("treats a false from the push as delivered-elsewhere when the DM landed", async () => {
      // No token / APNs unconfigured — `sendPushToUser` resolves `false`
      // rather than throwing. The person still heard it on Telegram, so the
      // notice is not rolled back and they are not re-notified next run.
      mUserFindMany.mockResolvedValueOnce([
        { id: "both", telegramId: 777n, createdAt: WAITED_TO_STEP_1, platform: "both", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      mPush.mockResolvedValueOnce(false);
      const api = makeApi();

      const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(result.notified).toBe(1);
      expect(result.failed).toBe(0);
      expect(mNoticeDeleteMany).not.toHaveBeenCalled();
    });

    it("counts a user as notified when the DM fails but the push lands", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "both", telegramId: 777n, createdAt: WAITED_TO_STEP_1, platform: "both", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      const api = makeApi();
      const stream = makeStream();
      stream.mockRejectedValueOnce(new Error("bot was blocked"));

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(result.notified).toBe(1);
      expect(result.failed).toBe(0);
      expect(mPush).toHaveBeenCalledTimes(1);
      expect(mNoticeDeleteMany).not.toHaveBeenCalled();
    });

    // (NOMATCH-1) The other half of the rule: nothing arrived on ANY rail is
    // the same event the single-rail version called a failed send.
    it("rolls the claim back when the only rail the user has does not deliver", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "app", telegramId: -42n, createdAt: WAITED_TO_STEP_1, platform: "mobile", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      mPush.mockResolvedValueOnce(false);
      const api = makeApi();

      const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(result.notified).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(0);
      expect(mNoticeDeleteMany).toHaveBeenCalledWith({
        where: { userId: "app", dropDate: getDropDate(NOW) },
      });
    });

    // (NOMATCH-2) An app-side user must not be paused by a notice they never
    // got, for exactly the reason a Telegram user must not: this notifier only
    // ever selects `active`, so it would never revisit them.
    it("resumes an app-side account paused by a push that never landed", async () => {
      mutableEnv.EARLY_STAGE = false;
      mUserFindMany.mockResolvedValueOnce([
        { id: "app", telegramId: -42n, createdAt: WAITED_TO_STEP_1, platform: "mobile", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
      });
      mPush.mockResolvedValueOnce(false);

      const result = await sendNoMatchNotices(
        makeApi() as never,
        NOW,
        0,
        makeStream() as never,
      );

      expect(result.paused).toBe(0);
      expect(result.failed).toBe(1);
      expect(mTransition).toHaveBeenCalledWith({ id: "app" }, "resume");
      expect(mNoticeDeleteMany).toHaveBeenCalled();
    });

    it("pauses an app-side account when the push does land", async () => {
      mutableEnv.EARLY_STAGE = false;
      mUserFindMany.mockResolvedValueOnce([
        { id: "app", telegramId: -42n, createdAt: WAITED_TO_STEP_1, platform: "mobile", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
      });
      const api = makeApi();

      const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(result.paused).toBe(1);
      expect(result.notified).toBe(1);
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(mPush).toHaveBeenCalledTimes(1);
      expect(mTransition).not.toHaveBeenCalledWith({ id: "app" }, "resume");
    });

    // The market-pending DM carries a city-switch button; the push cannot
    // carry a button (§5.2) and does not claim to. It is still sent: someone
    // on the app has to learn how the drop went the same as someone on
    // Telegram, and silence is not an answer.
    it("still tells a market-pending user on the app, on the one copy", async () => {
      mUserFindMany.mockResolvedValueOnce([
        {
          id: "app",
          telegramId: -42n, createdAt: WAITED_TO_STEP_1,
          platform: "mobile",
          language: "en",
          profile: { homeCityKey: "de:berlin", homeCity: "Berlin" },
        },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForStep(2) });
      const api = makeApi();

      const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(result.notified).toBe(1);
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(mPush).toHaveBeenCalledTimes(1);
      expect(mPush.mock.calls[0]![1]).toMatchObject({
        data: { type: NO_MATCH_PUSH_TYPE },
      });
      // Still not in a drop, so still no famine discount and no pause.
      expect(mGrant).not.toHaveBeenCalled();
      expect(mTransition).not.toHaveBeenCalled();
      expect(mNoticeCreate).toHaveBeenCalledTimes(1);
    });

    // Rematch is a Telegram DM with a Stars button and has no app rail in v1.
    it("does not attempt the Rematch offer on the push-only rail", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "app", telegramId: -42n, createdAt: WAITED_TO_STEP_1, platform: "mobile", language: "en" },
        { id: "tg", telegramId: 555n, createdAt: WAITED_TO_STEP_1, platform: "telegram", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValue(null);

      await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

      expect(mRematch).toHaveBeenCalledTimes(1);
      expect(mRematch.mock.calls[0]![1]).toBe("tg");
    });
  });
});

describe("leadBoldEntity", () => {
  it("lifts a leading *heading* into a bold entity on plain text", () => {
    const out = leadBoldEntity("*Нет мэтча* 🤍\n\nТекст");
    expect(out.text).toBe("Нет мэтча 🤍\n\nТекст");
    expect(out.entities).toEqual([{ type: "bold", offset: 0, length: "Нет мэтча".length }]);
  });

  it("leaves text without a leading heading untouched", () => {
    expect(leadBoldEntity("Plain text")).toEqual({ text: "Plain text" });
  });
});
