import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
    },
    match: {
      findFirst: vi.fn(),
    },
    noMatchNotice: {
      findFirst: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("./ticket-discount.js", () => ({
  grantFamineDiscountIfEligible: vi.fn(),
}));

import { prisma } from "@gennety/db";
import { sendNoMatchNotices, getDropDate } from "./no-match-notifier.js";
import { grantFamineDiscountIfEligible } from "./ticket-discount.js";
import { CADENCE } from "@gennety/shared";

type MockFn = ReturnType<typeof vi.fn>;
const mUserFindMany = (prisma.user as unknown as { findMany: MockFn }).findMany;
const mMatchFindFirst = (prisma.match as unknown as { findFirst: MockFn }).findFirst;
const mNoticeFindFirst = (prisma.noMatchNotice as unknown as { findFirst: MockFn }).findFirst;
const mNoticeCreate = (prisma.noMatchNotice as unknown as { create: MockFn }).create;
const mNoticeDeleteMany = (prisma.noMatchNotice as unknown as { deleteMany: MockFn }).deleteMany;
const mGrant = grantFamineDiscountIfEligible as unknown as MockFn;

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
 * `computeTier` measures elapsed time from `dispatchedAt` to `dropDate`
 * (`getDropDate(now)` — floored to UTC midnight, NOT `now` itself), in units
 * of `CADENCE.intervalMs` (7 days under the active `weekly` profile these
 * tests run under — see cadence.ts). These helpers anchor to `getDropDate`
 * to match that exactly, and pick a `dispatchedAt` comfortably inside the
 * target bucket (not right on a boundary, which the flooring above would
 * otherwise nudge into the bucket below):
 *   tier 1 → elapsed ~1 interval
 *   tier 2 → elapsed ~2 intervals
 *   tier 3 → elapsed ~3 intervals
 */
function dispatchedForTier(tier: 1 | 2 | 3, now: Date = NOW): Date {
  const dropDate = getDropDate(now);
  const intervalsAgo = tier; // comfortably mid-bucket: exactly N intervals back
  return new Date(dropDate.getTime() - intervalsAgo * 7 * DAY_MS);
}

describe("getDropDate", () => {
  it("floors to UTC midnight of the same day", () => {
    expect(getDropDate(NOW).toISOString()).toBe("2026-05-07T00:00:00.000Z");
  });
});

describe("sendNoMatchNotices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mNoticeCreate.mockResolvedValue({});
    mNoticeDeleteMany.mockResolvedValue({ count: 1 });
    // Default: no prior notice on file — only read when mMatchFindFirst
    // resolves null (the "never matched" fallback anchor in computeTier).
    mNoticeFindFirst.mockResolvedValue(null);
    // Default: feature off / not granted (the grant self-gates on the flag).
    mGrant.mockResolvedValue({ granted: false });
  });

  it("(D4) throttles candidate selection to famineNoticeIntervalMs, not the exact drop day", async () => {
    // The candidate query must exclude anyone notified more recently than
    // CADENCE.famineNoticeIntervalMs — this is what decouples "how often the
    // batch/cron fires" from "how often a starved user actually gets a DM"
    // (D4). Asserting on the query shape directly since the mocked Prisma
    // client doesn't evaluate `where` itself.
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
    const expectedCutoff = NOW.getTime() - CADENCE.famineNoticeIntervalMs;
    expect(Math.abs(cutoff.getTime() - expectedCutoff)).toBeLessThan(1000);
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

  it("sends tier-1 message for a user with no matches ever and no prior notice (first-ever check)", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeFindFirst.mockResolvedValueOnce(null); // no prior notice → anchors to dropDate itself
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(1);
    expect(result.tier1).toBe(1);
    expect(result.tier2).toBe(0);
    expect(result.tier3plus).toBe(0);

    const [chatId, body] = api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(111);
    expect(body).toMatch(/quality bar/);
    // Streamed as a short 2-chunk reveal: a "thinking" lead beat, then the
    // full empathetic body (no `parse_mode` — the templates carry no Markdown).
    const chunks = stream.mock.calls[0]![2] as string[];
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatch(/matches/i);
    expect(chunks[1]).toMatch(/quality bar/);

    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 1, dropDate: getDropDate(NOW) },
    });
  });

  it("sends tier-1 for a user whose last match was dispatched under 2 intervals ago", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(1) });
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.tier1).toBe(1);
    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 1, dropDate: getDropDate(NOW) },
    });
  });

  it("escalates to tier 2 once ~2 intervals have elapsed since the last match", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "ru" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(2) });
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.tier2).toBe(1);
    expect(result.tier1).toBe(0);

    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/вторая неделя/i);

    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 2, dropDate: getDropDate(NOW) },
    });
  });

  it("buckets tier 3+ once ~3 or more intervals have elapsed since the last match", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "uk" },
      { id: "u2", telegramId: 222n, language: "en" },
    ]);
    mMatchFindFirst
      .mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(3) })
      .mockResolvedValueOnce({ dispatchedAt: new Date(NOW.getTime() - 60 * DAY_MS) }); // far past tier 3
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.tier3plus).toBe(2);
    expect(result.tier1).toBe(0);
    expect(result.tier2).toBe(0);

    const [, body1] = api.sendMessage.mock.calls[0]!;
    const [, body2] = api.sendMessage.mock.calls[1]!;
    expect(body1).toMatch(/Знову чесно/);
    expect(body2).toMatch(/honest update/);
  });

  it("never-matched user anchors to their earliest NoMatchNotice, not the Unix epoch", async () => {
    // Regression guard: before the "never matched" fallback anchor existed,
    // computeTier would measure elapsed time from `new Date(0)` for a user
    // with no dispatched match at all, producing an absurd tier (tens of
    // thousands of intervals) on their very first check. The fallback
    // anchors to their first-ever NoMatchNotice instead.
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeFindFirst.mockResolvedValueOnce({
      dropDate: dispatchedForTier(2), // their famine streak started ~2 intervals ago
    });
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.tier2).toBe(1);
  });

  it("skips mobile-only accounts (negative telegramId) without DB writes", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "tg", telegramId: 555n, language: "en" },
      { id: "mobile", telegramId: -42n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValue(null);
    mNoticeFindFirst.mockResolvedValue(null);
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(1);
    expect(result.skipped).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(mNoticeCreate).toHaveBeenCalledTimes(1);
    expect(mNoticeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "tg" }) }),
    );
  });

  it("continues on send failure and reports the error", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
      { id: "u2", telegramId: 222n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValue(null);
    mNoticeFindFirst.mockResolvedValue(null);
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
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, language: "en" }]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();

    await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(mNoticeCreate).toHaveBeenCalledTimes(1);
    expect(mNoticeDeleteMany).not.toHaveBeenCalled();
  });

  it("(NOMATCH-1) skips (not fails) a user whose claim races another invocation", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
      { id: "u2", telegramId: 222n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValue(null);
    mNoticeFindFirst.mockResolvedValue(null);
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
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, language: "en" }]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();

    await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(mGrant).not.toHaveBeenCalled();
  });

  it("tier 2 grants the discount and appends the offer line to the DM", async () => {
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, language: "en" }]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(2) }); // tier 2
    mGrant.mockResolvedValueOnce({ granted: true, pct: 77, expiresAt: new Date() });
    const api = makeApi();

    await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(mGrant).toHaveBeenCalledWith("u1");
    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/77% off/);
  });

  it("tier 2 with the feature off (grant returns granted:false) appends nothing", async () => {
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, language: "en" }]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(2) }); // tier 2
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
        telegramId: 111n,
        language: "en",
        profile: { homeCityKey: "de:berlin", homeCity: "Berlin" },
      },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(3) }); // would be tier 3 + a famine discount
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(1);
    // Plain send with the switch button, not the "we really looked" stream.
    expect(stream).not.toHaveBeenCalled();
    const [chatId, body, options] = api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(111);
    expect(body).toMatch(/Berlin/);
    expect(body).not.toMatch(/quality bar/);
    expect(JSON.stringify(options.reply_markup)).toContain("menu:city:switch");
    // No famine discount for a drop they were never in.
    expect(mGrant).not.toHaveBeenCalled();
    // The notice row still lands, so the drop stays idempotent.
    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 3, dropDate: getDropDate(NOW) },
    });
  });

  it("keeps the ordinary famine copy for a user in a launched city", async () => {
    mUserFindMany.mockResolvedValueOnce([
      {
        id: "u1",
        telegramId: 111n,
        language: "en",
        profile: { homeCityKey: "ua:kyiv", homeCity: "Kyiv" },
      },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();
    const stream = makeStream();

    await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(stream).toHaveBeenCalled();
    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/quality bar/);
  });

  it("defaults to English when the user has no language set", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: null },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();
    const stream = makeStream();

    await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/quality bar/);
  });
});
