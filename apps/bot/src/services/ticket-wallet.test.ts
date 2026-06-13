/**
 * Unit tests for the ticket wallet. The Prisma client is replaced with a small
 * in-memory mock that mirrors the exact operations the service uses (increment/
 * decrement, the `updateMany` CAS guards, and both array + callback forms of
 * `$transaction`) so balance/idempotency semantics are exercised without a DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const flag = { TICKET_FEATURE_ENABLED: true };
vi.mock("../config.js", () => ({ env: flag }));

interface UserRow { id: string; ticketBalance: number }
interface ProfileRow {
  userId: string;
  photos: string[];
  profileMedia: unknown[];
  photoBonusTicketAt: Date | null;
  videoBonusTicketAt: Date | null;
}

const db: { user: UserRow; profile: ProfileRow; ledger: Array<Record<string, unknown>> } = {
  user: { id: "u1", ticketBalance: 0 },
  profile: { userId: "u1", photos: [], profileMedia: [], photoBonusTicketAt: null, videoBonusTicketAt: null },
  ledger: [],
};

const prismaMock = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === db.user.id ? { ticketBalance: db.user.ticketBalance } : null,
    update: async ({ data }: { data: { ticketBalance: { increment: number } } }) => {
      db.user.ticketBalance += data.ticketBalance.increment;
      return { ticketBalance: db.user.ticketBalance };
    },
    updateMany: async ({ where, data }: {
      where: { id: string; ticketBalance?: { gte: number } };
      data: { ticketBalance: { decrement: number } };
    }) => {
      if (where.ticketBalance && db.user.ticketBalance < where.ticketBalance.gte) return { count: 0 };
      db.user.ticketBalance -= data.ticketBalance.decrement;
      return { count: 1 };
    },
  },
  ticketLedger: {
    findFirst: async ({ where }: {
      where: { userId: string; reason: string };
    }) =>
      db.ledger.find(
        (row) => row.userId === where.userId && row.reason === where.reason,
      ) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      db.ledger.push(data);
      return data;
    },
  },
  profile: {
    findUnique: async () => db.profile,
    updateMany: async ({ where, data }: {
      where: { videoBonusTicketAt?: null; photoBonusTicketAt?: null };
      data: { videoBonusTicketAt?: Date; photoBonusTicketAt?: Date };
    }) => {
      if ("photoBonusTicketAt" in where) {
        if (db.profile.photoBonusTicketAt) return { count: 0 };
        db.profile.photoBonusTicketAt = data.photoBonusTicketAt ?? new Date();
        return { count: 1 };
      }
      if ("videoBonusTicketAt" in where) {
        if (db.profile.videoBonusTicketAt) return { count: 0 };
        db.profile.videoBonusTicketAt = data.videoBonusTicketAt ?? new Date();
        return { count: 1 };
      }
      return { count: 0 };
    },
  },
  // Array form runs the already-issued promises; callback form passes the mock.
  $transaction: async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: typeof prismaMock) => unknown)(prismaMock)
      : Promise.all(arg as Promise<unknown>[]),
};

vi.mock("@gennety/db", () => ({ prisma: prismaMock }));

const {
  grantTickets,
  spendTickets,
  getBalance,
  grantVerificationBonusIfEligible,
  grantWelcomeGiftIfEligible,
  grantPhotoBonusIfEligible,
  grantVideoBonusIfEligible,
} = await import("./ticket-wallet.js");

beforeEach(() => {
  db.user = { id: "u1", ticketBalance: 0 };
  db.profile = { userId: "u1", photos: [], profileMedia: [], photoBonusTicketAt: null, videoBonusTicketAt: null };
  db.ledger = [];
  flag.TICKET_FEATURE_ENABLED = true;
});

describe("grant/spend", () => {
  it("grants tickets and writes a ledger row", async () => {
    const balance = await grantTickets({ userId: "u1", count: 3, reason: "store_purchase", amountCents: 1647, bundleSize: 3 });
    expect(balance).toBe(3);
    expect(await getBalance("u1")).toBe(3);
    expect(db.ledger).toEqual([
      expect.objectContaining({ delta: 3, reason: "store_purchase", amountCents: 1647, bundleSize: 3 }),
    ]);
  });

  it("spends tickets atomically and refuses to go negative", async () => {
    await grantTickets({ userId: "u1", count: 1, reason: "photo_bonus" });
    const tooMuch = await spendTickets({ userId: "u1", count: 2, reason: "spend_match", matchId: "m1" });
    expect(tooMuch.ok).toBe(false);
    expect(tooMuch.balance).toBe(1);

    const ok = await spendTickets({ userId: "u1", count: 1, reason: "spend_match", matchId: "m1" });
    expect(ok.ok).toBe(true);
    expect(ok.balance).toBe(0);
    expect(db.ledger.at(-1)).toEqual(expect.objectContaining({ delta: -1, reason: "spend_match", matchId: "m1" }));
  });
});

describe("photo bonus", () => {
  it("grants once at 4+ photos and is idempotent", async () => {
    db.profile.photos = ["a", "b", "c", "d"];
    const first = await grantPhotoBonusIfEligible("u1");
    expect(first).toEqual({ granted: true, balance: 1 });
    const second = await grantPhotoBonusIfEligible("u1");
    expect(second.granted).toBe(false);
    expect(await getBalance("u1")).toBe(1);
  });

  it("does not grant below the threshold", async () => {
    db.profile.photos = ["a", "b", "c"];
    const res = await grantPhotoBonusIfEligible("u1");
    expect(res.granted).toBe(false);
    expect(await getBalance("u1")).toBe(0);
  });

  it("is a no-op when the feature flag is off", async () => {
    flag.TICKET_FEATURE_ENABLED = false;
    db.profile.photos = ["a", "b", "c", "d"];
    const res = await grantPhotoBonusIfEligible("u1");
    expect(res.granted).toBe(false);
    expect(db.profile.photoBonusTicketAt).toBeNull();
  });
});

describe("verification bonus", () => {
  it("grants one ticket once and uses the ledger as the claim marker", async () => {
    const first = await grantVerificationBonusIfEligible("u1");
    expect(first).toEqual({ granted: true, balance: 1 });

    const second = await grantVerificationBonusIfEligible("u1");
    expect(second).toEqual({ granted: false, balance: 1 });
    expect(db.ledger).toEqual([
      expect.objectContaining({
        userId: "u1",
        delta: 1,
        reason: "verification_bonus",
      }),
    ]);
  });

  it("is a no-op when the feature flag is off", async () => {
    flag.TICKET_FEATURE_ENABLED = false;
    const result = await grantVerificationBonusIfEligible("u1");
    expect(result).toEqual({ granted: false, balance: 0 });
    expect(db.ledger).toHaveLength(0);
  });
});

describe("welcome gift", () => {
  it("grants one ticket once and uses the ledger as the claim marker", async () => {
    const first = await grantWelcomeGiftIfEligible("u1");
    expect(first).toEqual({ granted: true, balance: 1 });

    const second = await grantWelcomeGiftIfEligible("u1");
    expect(second).toEqual({ granted: false, balance: 1 });
    expect(db.ledger).toEqual([
      expect.objectContaining({ userId: "u1", delta: 1, reason: "welcome_gift" }),
    ]);
  });

  it("is a no-op when the feature flag is off", async () => {
    flag.TICKET_FEATURE_ENABLED = false;
    const result = await grantWelcomeGiftIfEligible("u1");
    expect(result).toEqual({ granted: false, balance: 0 });
    expect(db.ledger).toHaveLength(0);
  });
});

describe("video bonus", () => {
  it("grants once when a video item is present", async () => {
    db.profile.profileMedia = [{ type: "video", video: "vid_1" }];
    const first = await grantVideoBonusIfEligible("u1");
    expect(first).toEqual({ granted: true, balance: 1 });
    const second = await grantVideoBonusIfEligible("u1");
    expect(second.granted).toBe(false);
  });

  it("does not grant without a video", async () => {
    db.profile.profileMedia = [{ type: "photo", photo: "p1" }];
    const res = await grantVideoBonusIfEligible("u1");
    expect(res.granted).toBe(false);
  });
});
