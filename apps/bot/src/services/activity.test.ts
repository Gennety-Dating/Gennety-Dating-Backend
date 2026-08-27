import { describe, it, expect, beforeEach, vi } from "vitest";

const { executeRaw } = vi.hoisted(() => ({ executeRaw: vi.fn() }));

vi.mock("@gennety/db", () => ({
  prisma: { $executeRaw: executeRaw },
}));

const { activityDay, activityDayKey, clearActivityCache, markUserActive } =
  await import("./activity.js");

beforeEach(() => {
  executeRaw.mockReset();
  executeRaw.mockResolvedValue(1);
  clearActivityCache();
});

describe("activityDay", () => {
  it("buckets by UTC, not by local time", () => {
    // The bucket has to be the same for every reader; a local-time bucket would
    // put the same instant on two different days for two operators.
    expect(activityDayKey(new Date("2026-08-27T23:59:59.999Z"))).toBe("2026-08-27");
    expect(activityDayKey(new Date("2026-08-28T00:00:00.000Z"))).toBe("2026-08-28");
  });

  it("returns midnight UTC so the value round-trips as a @db.Date", () => {
    expect(activityDay(new Date("2026-08-27T18:30:00.000Z")).toISOString()).toBe(
      "2026-08-27T00:00:00.000Z",
    );
  });
});

describe("markUserActive", () => {
  it("writes once and then dedups the rest of the day", async () => {
    // The point of the cache: a chatty user costs one write a day, not one per
    // message. Without it this sits on the path of every single update.
    const at = new Date("2026-08-27T10:00:00.000Z");
    await markUserActive("u1", "telegram", { at });
    await markUserActive("u1", "telegram", { at: new Date("2026-08-27T11:00:00.000Z") });
    await markUserActive("u1", "telegram", { at: new Date("2026-08-27T12:00:00.000Z") });
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it("writes again once the UTC day rolls over", async () => {
    await markUserActive("u1", "telegram", { at: new Date("2026-08-27T23:00:00.000Z") });
    await markUserActive("u1", "telegram", { at: new Date("2026-08-28T01:00:00.000Z") });
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it("keeps platforms separate", async () => {
    // Same human, two surfaces, two rows — that is what makes a per-platform
    // DAU breakdown possible at all.
    const at = new Date("2026-08-27T10:00:00.000Z");
    await markUserActive("u1", "telegram", { at });
    await markUserActive("u1", "ios", { at });
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it("force bypasses the cache, so a reconcile can repair a missing row", async () => {
    // The repair path replays history. A cache entry the live path happened to
    // set must not silence a write for a row that is absent from the table.
    const at = new Date("2026-08-27T10:00:00.000Z");
    await markUserActive("u1", "telegram", { at });
    await markUserActive("u1", "telegram", { at, force: true });
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it("never throws when the database write fails", async () => {
    // It sits on the path of every inbound update: a metric hiccup must never
    // cost a user their action.
    executeRaw.mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      markUserActive("u1", "telegram", { at: new Date("2026-08-27T10:00:00.000Z") }),
    ).resolves.toBeUndefined();
  });

  it("does not cache a failed write, so the next action retries it", async () => {
    // Caching a failure would lose the whole day for that user rather than one
    // message — the exact opposite of what the cache is for.
    const at = new Date("2026-08-27T10:00:00.000Z");
    executeRaw.mockRejectedValueOnce(new Error("connection lost"));
    await markUserActive("u1", "telegram", { at });
    await markUserActive("u1", "telegram", { at });
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it("folds instants rather than overwriting them", async () => {
    // GREATEST/LEAST in the conflict branch is what stops a reconcile replaying
    // an older event from rewinding a live mark.
    await markUserActive("u1", "telegram", { at: new Date("2026-08-27T10:00:00.000Z") });
    const sql = executeRaw.mock.calls[0]?.[0];
    const text = Array.isArray(sql) ? sql.join("?") : String(sql);
    expect(text).toContain("ON CONFLICT (activity_date, user_id, platform)");
    expect(text).toContain("LEAST(user_activity_days.first_seen_at");
    expect(text).toContain("GREATEST(user_activity_days.last_seen_at");
  });
});
