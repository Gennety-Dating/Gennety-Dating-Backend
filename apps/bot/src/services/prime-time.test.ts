import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  env: {
    PRIME_TIME_ENABLED: true,
    PREMIUM_FEATURE_ENABLED: true,
    PRIME_TIME_SLOT_COUNT: 3,
    PRIME_TIME_STARS: 50,
  },
}));

const { env } = await import("../config.js");
const {
  isPrimeTimeSlot,
  primeTimeSlots,
  primeTimeUnlockReason,
  primeTimeUnlocked,
  shouldPersistUnlock,
  lockedSlotsOf,
} = await import("./prime-time.js");
const { CALENDAR_TIME_SLOTS, CALENDAR_TIME_ZONE } = await import(
  "../handlers/matching/scheduler.js"
);
const { wallToUtc } = await import("./profiler-schedule.js");

const mutableEnv = env as unknown as {
  PRIME_TIME_ENABLED: boolean;
  PREMIUM_FEATURE_ENABLED: boolean;
  PRIME_TIME_SLOT_COUNT: number;
};

beforeEach(() => {
  mutableEnv.PRIME_TIME_ENABLED = true;
  mutableEnv.PREMIUM_FEATURE_ENABLED = true;
  mutableEnv.PRIME_TIME_SLOT_COUNT = 3;
});
afterEach(() => vi.restoreAllMocks());

/** A Kyiv wall-clock slot, resolved to its real instant exactly as the grid is. */
function kyiv(month: number, day: number, hour: number, minute: number): Date {
  return wallToUtc(2026, month, day, hour, minute, CALENDAR_TIME_ZONE);
}

const reachable = { telegramId: 42n, platform: "telegram", premiumUntil: null };
const mobileOnly = { telegramId: -7n, platform: "mobile", premiumUntil: null };

function match(over: Partial<Parameters<typeof primeTimeUnlockReason>[0]> = {}) {
  return {
    primeTimeUnlockedAt: null,
    availableTimesA: [] as Date[],
    availableTimesB: [] as Date[],
    userA: { ...reachable },
    userB: { ...reachable, telegramId: 43n },
    ...over,
  };
}

describe("the locked band", () => {
  it("is a SUFFIX of the real grid, not a second list of hours", () => {
    // The guard that matters: if someone hardcodes [18:30,19:00,19:30] and the
    // grid later moves, this stays green only because it reads the grid.
    expect(primeTimeSlots(3)).toEqual(CALENDAR_TIME_SLOTS.slice(-3));
    expect(primeTimeSlots(3)).toHaveLength(3);
    // And with the shipped default that is the evening.
    expect(primeTimeSlots(3)).toEqual([
      { hour: 18, minute: 30 },
      { hour: 19, minute: 0 },
      { hour: 19, minute: 30 },
    ]);
  });

  it("follows PRIME_TIME_SLOT_COUNT rather than a constant", () => {
    expect(primeTimeSlots(2)).toEqual([
      { hour: 19, minute: 0 },
      { hour: 19, minute: 30 },
    ]);
    expect(primeTimeSlots(0)).toEqual([]);
  });

  it("classifies by KYIV wall clock, so it survives the DST change", () => {
    // Kyiv is UTC+2 in January and UTC+3 in July, so these two instants differ
    // by an hour in UTC while being the same 19:30 on the grid. Reading
    // getUTCHours() here would lock the wrong three rows for half the year.
    const winter = kyiv(1, 15, 19, 30);
    const summer = kyiv(7, 15, 19, 30);
    expect(winter.getUTCHours()).not.toBe(summer.getUTCHours());
    expect(isPrimeTimeSlot(winter)).toBe(true);
    expect(isPrimeTimeSlot(summer)).toBe(true);
  });

  it("leaves the rest of the day alone", () => {
    for (const h of [13, 15, 17, 18]) {
      expect(isPrimeTimeSlot(kyiv(7, 15, h, 0))).toBe(false);
    }
    expect(isPrimeTimeSlot(kyiv(7, 15, 18, 30))).toBe(true);
  });

  it("locks 18 of the 84 grid cells at the shipped default", () => {
    const grid: Date[] = [];
    for (let day = 1; day <= 6; day++) {
      for (const s of CALENDAR_TIME_SLOTS) grid.push(kyiv(7, day, s.hour, s.minute));
    }
    expect(grid).toHaveLength(84);
    expect(lockedSlotsOf(grid)).toHaveLength(18);
  });
});

describe("who is open", () => {
  it("locks an ordinary pair", () => {
    expect(primeTimeUnlockReason(match())).toBeNull();
    expect(primeTimeUnlocked(match())).toBe(false);
  });

  it("opens for the PAIR when EITHER side subscribes", () => {
    const future = new Date(Date.now() + 86_400_000);
    expect(
      primeTimeUnlockReason(match({ userA: { ...reachable, premiumUntil: future } })),
    ).toBe("premium");
    expect(
      primeTimeUnlockReason(
        match({ userB: { ...reachable, telegramId: 43n, premiumUntil: future } }),
      ),
    ).toBe("premium");
  });

  it("treats a paid pass as permanent, so a lapsed subscription cannot re-lock", () => {
    const lapsed = new Date(Date.now() - 86_400_000);
    const m = match({
      primeTimeUnlockedAt: new Date(),
      userA: { ...reachable, premiumUntil: lapsed },
    });
    expect(primeTimeUnlockReason(m)).toBe("unlocked");
  });

  it("grandfathers a pair that already marked a prime slot", () => {
    expect(
      primeTimeUnlockReason(match({ availableTimesB: [kyiv(7, 15, 19, 30)] })),
    ).toBe("grandfathered");
    // …and does not grandfather on an ordinary mark.
    expect(primeTimeUnlockReason(match({ availableTimesB: [kyiv(7, 15, 15, 0)] }))).toBeNull();
  });

  it("does not lock a pair that has NO path to either half of the offer", () => {
    const m = match({
      userA: { ...mobileOnly },
      userB: { ...mobileOnly, telegramId: -8n },
    });
    expect(primeTimeUnlockReason(m)).toBe("no-purchase-path");
  });

  it("DOES lock a mixed pair — the Telegram side can open the band for both", () => {
    const m = match({ userB: { ...mobileOnly } });
    expect(primeTimeUnlockReason(m)).toBeNull();
  });

  it("is inert without the master flag or without Premium being purchasable", () => {
    mutableEnv.PRIME_TIME_ENABLED = false;
    expect(primeTimeUnlockReason(match())).toBe("feature-off");
    mutableEnv.PRIME_TIME_ENABLED = true;
    mutableEnv.PREMIUM_FEATURE_ENABLED = false;
    expect(primeTimeUnlockReason(match())).toBe("feature-off");
  });
});

describe("what gets persisted", () => {
  it("persists ONLY a live subscription — the one reason that can stop being true", () => {
    expect(shouldPersistUnlock("premium")).toBe(true);
    for (const r of ["unlocked", "grandfathered", "feature-off", "no-purchase-path", null] as const) {
      expect(shouldPersistUnlock(r)).toBe(false);
    }
  });
});
