import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUMP_CEREMONY_LEAD_MS,
  BUMP_CEREMONY_REPLAY_MS,
  BUMP_HOLD_WAIT_MS,
  BUMP_SHAKE_WINDOW_MS,
} from "@gennety/shared";

const bumpFindUnique = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: { dateBumpSession: { findUnique: bumpFindUnique } },
}));

const {
  ceremonyFor,
  ceremonyRole,
  notifyBumpVerified,
  waitForBumpVerification,
  waitingHoldCount,
} = await import("./bump-ceremony.js");

const T = new Date("2026-09-29T17:00:00.000Z");
const ms = (offset: number): Date => new Date(T.getTime() + offset);

describe("the constants", () => {
  // A hold stamps the server's clock, so past the alignment window the
  // partner's hold can no longer align with ours — waiting longer is pointless.
  it("waits exactly as long as a partner's hold could still align", () => {
    expect(BUMP_HOLD_WAIT_MS).toBe(BUMP_SHAKE_WINDOW_MS);
  });
});

describe("ceremonyRole", () => {
  const verified = (a: Date | null, b: Date | null, at: Date) => ({
    isVerified: true,
    verifiedAt: at,
    userAShakeAt: a,
    userBShakeAt: b,
  });

  it("gives B to the side whose stamp completed the pair, A to the one that waited", () => {
    const row = verified(ms(0), ms(3_000), ms(3_000));
    expect(ceremonyRole(row, "B")).toBe("B");
    expect(ceremonyRole(row, "A")).toBe("A");
  });

  // The role is not the match side: userA may be the one who arrived second.
  it("is independent of which match side completed the pair", () => {
    const row = verified(ms(3_000), ms(0), ms(3_000));
    expect(ceremonyRole(row, "A")).toBe("B");
    expect(ceremonyRole(row, "B")).toBe("A");
  });

  it("breaks a same-millisecond tie by match side, so the phones never agree on one role", () => {
    const row = verified(ms(0), ms(0), ms(0));
    expect(ceremonyRole(row, "A")).toBe("A");
    expect(ceremonyRole(row, "B")).toBe("B");
  });

  // An old shake client re-shaking after verification overwrites its own
  // column; the caller did not provably complete the pair, so it waited.
  it("plays A when neither stamp matches any more", () => {
    const row = verified(ms(0), ms(9_000), ms(3_000));
    expect(ceremonyRole(row, "A")).toBe("A");
  });

  // Mixed pair: a hold waiting (server clock), an old shake completing with
  // its device clock as `verifiedAt`.
  it("gives the holder A when an old shake completed the pair", () => {
    const deviceClock = ms(2_437);
    const row = verified(ms(1_000), deviceClock, deviceClock);
    expect(ceremonyRole(row, "A")).toBe("A");
  });
});

describe("ceremonyFor", () => {
  const row = {
    isVerified: true,
    verifiedAt: T,
    userAShakeAt: ms(-2_000),
    userBShakeAt: T,
  };

  it("starts one lead after verification and stamps the server clock", () => {
    const now = ms(40);
    expect(ceremonyFor(row, "A", now)).toEqual({
      startAt: ms(BUMP_CEREMONY_LEAD_MS).toISOString(),
      role: "A",
      serverNow: now.toISOString(),
    });
  });

  it("gives both sides the same start", () => {
    const a = ceremonyFor(row, "A", ms(10));
    const b = ceremonyFor(row, "B", ms(120));
    expect(a?.startAt).toBe(b?.startAt);
    expect([a?.role, b?.role]).toEqual(["A", "B"]);
  });

  it("has nothing to play before verification", () => {
    expect(ceremonyFor({ ...row, isVerified: false, verifiedAt: null }, "A", T)).toBeNull();
  });

  it("is still handed out just before the replay window closes", () => {
    const edge = ms(BUMP_CEREMONY_LEAD_MS + BUMP_CEREMONY_REPLAY_MS - 1);
    expect(ceremonyFor(row, "A", edge)).not.toBeNull();
  });

  it("is never replayed once the window has closed", () => {
    const edge = ms(BUMP_CEREMONY_LEAD_MS + BUMP_CEREMONY_REPLAY_MS);
    expect(ceremonyFor(row, "A", edge)).toBeNull();
  });

  // Only reachable through an old shake whose device clock runs fast.
  it("never puts the start more than one lead ahead of now", () => {
    const future = { ...row, verifiedAt: ms(40_000), userBShakeAt: ms(40_000) };
    expect(ceremonyFor(future, "A", T)?.startAt).toBe(ms(BUMP_CEREMONY_LEAD_MS).toISOString());
  });
});

describe("waitForBumpVerification", () => {
  const MATCH = "match-wait";
  const PENDING = { isVerified: false, verifiedAt: null, userAShakeAt: T, userBShakeAt: null };
  const DONE = { isVerified: true, verifiedAt: ms(2_000), userAShakeAt: T, userBShakeAt: ms(2_000) };

  beforeEach(() => {
    vi.useFakeTimers();
    bumpFindUnique.mockReset().mockResolvedValue(PENDING);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function wait(signal = new AbortController().signal, pollMs = 250) {
    return waitForBumpVerification(MATCH, {
      until: Date.now() + BUMP_HOLD_WAIT_MS,
      signal,
      pollMs,
    });
  }

  it("is woken by the verification event, not only by the poll", async () => {
    const pending = wait(undefined, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(bumpFindUnique).toHaveBeenCalledTimes(1);

    bumpFindUnique.mockResolvedValue(DONE);
    notifyBumpVerified(MATCH);
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toEqual(DONE);
    expect(bumpFindUnique).toHaveBeenCalledTimes(2);
    expect(waitingHoldCount(MATCH)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to polling the row", async () => {
    const pending = wait();
    await vi.advanceTimersByTimeAsync(0);
    bumpFindUnique.mockResolvedValue(DONE);
    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toEqual(DONE);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up at the deadline, after one last read", async () => {
    const pending = wait();
    await vi.advanceTimersByTimeAsync(BUMP_HOLD_WAIT_MS);

    await expect(pending).resolves.toBeNull();
    expect(waitingHoldCount(MATCH)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers yes when the pair verified in the last moment before the deadline", async () => {
    const pending = wait(undefined, 60_000);
    await vi.advanceTimersByTimeAsync(BUMP_HOLD_WAIT_MS - 1);
    bumpFindUnique.mockResolvedValue(DONE);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual(DONE);
  });

  it("stops at once, and cleans up, when the client leaves", async () => {
    const controller = new AbortController();
    const pending = wait(controller.signal);
    await vi.advanceTimersByTimeAsync(300);
    expect(waitingHoldCount(MATCH)).toBe(1);

    controller.abort();

    await expect(pending).resolves.toBeNull();
    expect(waitingHoldCount(MATCH)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const reads = bumpFindUnique.mock.calls.length;
    await vi.advanceTimersByTimeAsync(BUMP_HOLD_WAIT_MS);
    expect(bumpFindUnique.mock.calls.length).toBe(reads);
  });

  it("does not start at all for a client already gone", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(wait(controller.signal)).resolves.toBeNull();
    expect(bumpFindUnique).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("survives a failing read and keeps waiting", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    bumpFindUnique.mockRejectedValueOnce(new Error("db blip"));
    const pending = wait();
    await vi.advanceTimersByTimeAsync(0);
    bumpFindUnique.mockResolvedValue(DONE);
    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toEqual(DONE);
    error.mockRestore();
  });
});
