import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("./match-engine.js", () => ({
  findCandidatesFor: vi.fn(),
}));

vi.mock("./account-status-transitions.js", () => ({
  transitionAccountStatus: vi.fn(),
}));

import { prisma } from "@gennety/db";
import { findCandidatesFor } from "./match-engine.js";
import { transitionAccountStatus } from "./account-status-transitions.js";
import { autoResumeStarvedUsers } from "./pool-exhaustion.js";

type MockFn = ReturnType<typeof vi.fn>;
const mUserFindMany = (prisma.user as unknown as { findMany: MockFn }).findMany;
const mFindCandidates = findCandidatesFor as unknown as MockFn;
const mTransition = transitionAccountStatus as unknown as MockFn;

function makeApi() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) };
}

describe("autoResumeStarvedUsers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no user is system-paused", async () => {
    mUserFindMany.mockResolvedValueOnce([]);

    const result = await autoResumeStarvedUsers(makeApi() as never);

    expect(result).toEqual({ checked: 0, resumed: 0, errors: [] });
    expect(mFindCandidates).not.toHaveBeenCalled();
  });

  it("queries only status=paused users with a starvationPausedAt marker set", async () => {
    mUserFindMany.mockResolvedValueOnce([]);

    await autoResumeStarvedUsers(makeApi() as never);

    expect(mUserFindMany).toHaveBeenCalledWith({
      where: {
        status: "paused",
        profile: { starvationPausedAt: { not: null } },
      },
      select: { id: true, telegramId: true, language: true },
    });
  });

  it("leaves a user paused when no candidate exists for them yet", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
    ]);
    mFindCandidates.mockResolvedValueOnce([]);
    const api = makeApi();

    const result = await autoResumeStarvedUsers(api as never);

    expect(result).toEqual({ checked: 1, resumed: 0, errors: [] });
    expect(mTransition).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("probes with allowPausedSeeker — a paused seeker is not itself the reason no candidate is found", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
    ]);
    mFindCandidates.mockResolvedValueOnce([]);

    await autoResumeStarvedUsers(makeApi() as never);

    expect(mFindCandidates).toHaveBeenCalledWith("u1", 1, { allowPausedSeeker: true });
  });

  it("resumes and notifies when a candidate now exists", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
    ]);
    mFindCandidates.mockResolvedValueOnce([{ userId: "candidate-1" }]);
    mTransition.mockResolvedValueOnce({ kind: "changed" });
    const api = makeApi();

    const result = await autoResumeStarvedUsers(api as never);

    expect(result.resumed).toBe(1);
    expect(mTransition).toHaveBeenCalledWith({ id: "u1" }, "resume");
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]![0]).toBe(111);
  });

  it("does not send a DM when the resume CAS loses a race", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
    ]);
    mFindCandidates.mockResolvedValueOnce([{ userId: "candidate-1" }]);
    mTransition.mockResolvedValueOnce({ kind: "forbidden" }); // e.g. banned in the meantime
    const api = makeApi();

    const result = await autoResumeStarvedUsers(api as never);

    expect(result.resumed).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("skips the DM for a mobile-only account but still counts the resume", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: -42n, language: "en" },
    ]);
    mFindCandidates.mockResolvedValueOnce([{ userId: "candidate-1" }]);
    mTransition.mockResolvedValueOnce({ kind: "changed" });
    const api = makeApi();

    const result = await autoResumeStarvedUsers(api as never);

    expect(result.resumed).toBe(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("continues past a per-user error and reports it", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
      { id: "u2", telegramId: 222n, language: "en" },
    ]);
    mFindCandidates
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce([{ userId: "candidate-1" }]);
    mTransition.mockResolvedValueOnce({ kind: "changed" });
    const api = makeApi();

    const result = await autoResumeStarvedUsers(api as never);

    expect(result.checked).toBe(2);
    expect(result.resumed).toBe(1);
    expect(result.errors).toEqual([{ userId: "u1", error: "db blip" }]);
  });

  it("a DM send failure is swallowed and does not undo the resume count", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
    ]);
    mFindCandidates.mockResolvedValueOnce([{ userId: "candidate-1" }]);
    mTransition.mockResolvedValueOnce({ kind: "changed" });
    const api = makeApi();
    api.sendMessage.mockRejectedValueOnce(new Error("Forbidden"));

    const result = await autoResumeStarvedUsers(api as never);

    expect(result.resumed).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
