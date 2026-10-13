import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config.js", () => ({ env: { ADMIN_TEST_TELEGRAM_IDS: "" } }));

const { rows, pendingScans } = vi.hoisted(() => ({
  rows: [] as unknown[],
  pendingScans: [] as Array<() => void>,
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      // Held until the test lets it go, so two callers are provably concurrent.
      findMany: vi.fn(
        () =>
          new Promise((resolve) => {
            pendingScans.push(() => resolve(rows));
          }),
      ),
      count: vi.fn(async () => rows.length),
    },
    chatEvent: { groupBy: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  },
}));

import { prisma } from "@gennety/db";
import { classifyAllUsers } from "./user-health-source.js";
import { HEALTH_CONFIG } from "./user-health.js";

const T0 = new Date("2026-10-01T12:00:00.000Z");
const HOUR = 3_600_000;

function userRow(id: string) {
  return {
    id,
    telegramId: BigInt(1000 + rows.length),
    firstName: "Olena",
    email: null,
    status: "active",
    onboardingStep: "completed",
    verificationStatus: "verified",
    gender: "female",
    faceMatchScore: 0.97,
    faceMatchedAt: T0,
    createdAt: T0,
    lastMessageAt: null,
    syntheticAt: null,
    profile: { photos: ["a.jpg"] },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Let every scan that has reached the database finish. */
function releaseScans(): void {
  for (const go of pendingScans.splice(0)) go();
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  pendingScans.length = 0;
});

describe("classifyAllUsers — concurrent callers", () => {
  it("share one scan while it is in flight, each classifying with its own `now`", async () => {
    rows.push(userRow("00000000-0000-0000-0000-000000000001"));

    // Never wrote to the bot: "other" for the first day, "cold open" after it.
    const early = classifyAllUsers(new Date(T0.getTime() + 23 * HOUR));
    const late = classifyAllUsers(new Date(T0.getTime() + 25 * HOUR));
    await flush();
    releaseScans();
    const [a, b] = await Promise.all([early, late]);

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.count).toHaveBeenCalledTimes(1);
    expect(prisma.chatEvent.groupBy).toHaveBeenCalledTimes(1);
    expect(a.users[0]!.verdict.classification).toBe("other");
    expect(b.users[0]!.verdict.classification).toBe("cold_open_unengaged");
    // Separate results — a caller editing its list cannot touch the other's.
    expect(a.users).not.toBe(b.users);
    expect(a.users[0]).not.toBe(b.users[0]);
    expect(a.scanned).toBe(1);
    expect(b.truncated).toBe(false);
  });

  it("keeps nothing once the scan lands — the next call reads the database again", async () => {
    const first = classifyAllUsers(T0);
    await flush();
    releaseScans();
    await first;

    const second = classifyAllUsers(T0);
    await flush();
    releaseScans();
    await second;

    expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
  });

  it("does not share a scan between configs that read differently", async () => {
    const standard = classifyAllUsers(T0);
    const narrow = classifyAllUsers(T0, { ...HEALTH_CONFIG, max_scan_users: 5 });
    await flush();

    expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
    const takes = vi
      .mocked(prisma.user.findMany)
      .mock.calls.map((call) => (call as unknown[])[0] as { take: number })
      .map((args) => args.take);
    expect(takes).toEqual([HEALTH_CONFIG.max_scan_users, 5]);

    releaseScans();
    await Promise.all([standard, narrow]);
  });
});
