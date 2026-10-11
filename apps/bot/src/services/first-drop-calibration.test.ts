import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * First-drop calibration (founder decision 2026-10-11): a fresh account skips
 * the nearest evening batch. Production runs the daily 18:00 Europe/Kyiv batch,
 * pinned here through MATCH_CRON_SCHEDULE so the default `weekly` code profile
 * does not leak into the arithmetic.
 */

vi.stubEnv("MATCH_CRON_SCHEDULE", "0 18 * * *");

const db = { profile: { updateMany: vi.fn(), findUnique: vi.fn() } };
vi.mock("@gennety/db", () => ({ prisma: db }));
const env = { FIRST_DROP_CALIBRATION_HOURS: 24 };
vi.mock("../config.js", () => ({ env }));

const {
  armFirstDropCalibration,
  calibrationOverWhere,
  calibrationUntilFrom,
  resolveCalibration,
} = await import("./first-drop-calibration.js");

// October in Kyiv is UTC+3: 18:00 Kyiv = 15:00Z.
const kyiv = (iso: string) => new Date(`${iso}+03:00`);

beforeEach(() => {
  db.profile.updateMany.mockReset();
  db.profile.findUnique.mockReset();
  env.FIRST_DROP_CALIBRATION_HOURS = 24;
});

describe("skip the nearest evening", () => {
  it("onboarded after the evening batch → first drop on the second evening (~47h)", () => {
    const done = kyiv("2026-10-12T19:00:00");
    const state = resolveCalibration(calibrationUntilFrom(done), done);
    expect(state.calibrating).toBe(true);
    expect(state.firstDropAt).toEqual(kyiv("2026-10-14T18:00:00"));
  });

  it("onboarded just before the evening batch → that evening is skipped, next one joins (~25h)", () => {
    const done = kyiv("2026-10-12T17:00:00");
    const state = resolveCalibration(calibrationUntilFrom(done), done);
    expect(state.firstDropAt).toEqual(kyiv("2026-10-13T18:00:00"));
  });

  it("a window ending exactly on a batch instant joins that batch", () => {
    const until = kyiv("2026-10-13T18:00:00");
    const state = resolveCalibration(until, kyiv("2026-10-13T10:00:00"));
    expect(state.firstDropAt).toEqual(until);
  });

  it("the batch filter admits the profile exactly from the window end", () => {
    const at = kyiv("2026-10-13T18:00:00");
    expect(calibrationOverWhere(at)).toEqual({
      OR: [{ calibrationUntil: null }, { calibrationUntil: { lte: at } }],
    });
  });
});

describe("window state", () => {
  it("is over once the end has passed, and absent for legacy accounts", () => {
    const now = kyiv("2026-10-13T18:00:01");
    expect(resolveCalibration(kyiv("2026-10-13T18:00:00"), now)).toEqual({
      calibrating: false,
      firstDropAt: null,
    });
    expect(resolveCalibration(null, now).calibrating).toBe(false);
  });

  it("0 hours disables the window entirely", () => {
    expect(calibrationUntilFrom(new Date(), 0)).toBeNull();
  });
});

describe("armFirstDropCalibration", () => {
  it("arms once, never for a profile that was ever matched", async () => {
    const now = kyiv("2026-10-12T19:00:00");
    await armFirstDropCalibration("u1", now);
    expect(db.profile.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", calibrationUntil: null, lastMatchedAt: null },
      data: { calibrationUntil: kyiv("2026-10-13T19:00:00") },
    });
  });

  it("does nothing when the feature is off", async () => {
    env.FIRST_DROP_CALIBRATION_HOURS = 0;
    await armFirstDropCalibration("u1");
    expect(db.profile.updateMany).not.toHaveBeenCalled();
  });
});
