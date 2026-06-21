/**
 * Unit tests for the famine single-ticket discount. Prisma is replaced with a
 * tiny in-memory `User` row mirroring the exact reads/CAS the service uses, and
 * `config.js` is mocked so the feature flag + percent/TTL can be toggled.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const flag = { TICKET_FEATURE_ENABLED: true, FAMINE_DISCOUNT_PCT: 77, FAMINE_DISCOUNT_TTL_DAYS: 30 };
vi.mock("../config.js", () => ({ env: flag }));

interface UserRow {
  id: string;
  ticketDiscountPct: number;
  ticketDiscountGrantedAt: Date | null;
  ticketDiscountExpiresAt: Date | null;
  ticketDiscountConsumedAt: Date | null;
}

const db: { user: UserRow } = {
  user: {
    id: "u1",
    ticketDiscountPct: 0,
    ticketDiscountGrantedAt: null,
    ticketDiscountExpiresAt: null,
    ticketDiscountConsumedAt: null,
  },
};

const prismaMock = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === db.user.id
        ? {
            ticketDiscountPct: db.user.ticketDiscountPct,
            ticketDiscountExpiresAt: db.user.ticketDiscountExpiresAt,
            ticketDiscountConsumedAt: db.user.ticketDiscountConsumedAt,
          }
        : null,
    updateMany: async ({ where, data }: {
      where: {
        id: string;
        ticketDiscountPct?: { gt: number };
        ticketDiscountConsumedAt?: null;
        ticketDiscountExpiresAt?: { gt: Date };
      };
      data: Partial<UserRow>;
    }) => {
      if (where.id !== db.user.id) return { count: 0 };
      // Apply the CAS guards used by consumeActiveDiscount.
      if (where.ticketDiscountPct && !(db.user.ticketDiscountPct > where.ticketDiscountPct.gt)) {
        return { count: 0 };
      }
      if (where.ticketDiscountConsumedAt === null && db.user.ticketDiscountConsumedAt !== null) {
        return { count: 0 };
      }
      if (where.ticketDiscountExpiresAt && !(db.user.ticketDiscountExpiresAt! > where.ticketDiscountExpiresAt.gt)) {
        return { count: 0 };
      }
      Object.assign(db.user, data);
      return { count: 1 };
    },
  },
};

vi.mock("@gennety/db", () => ({ prisma: prismaMock }));
vi.mock("./ticket-analytics.js", () => ({ emitTicketEvent: vi.fn() }));

const {
  discountedCents,
  activeDiscountFromColumns,
  getActiveDiscount,
  grantFamineDiscountIfEligible,
  consumeActiveDiscount,
} = await import("./ticket-discount.js");

const NOW = new Date("2026-06-19T12:00:00Z");

function resetUser(over: Partial<UserRow> = {}): void {
  db.user = {
    id: "u1",
    ticketDiscountPct: 0,
    ticketDiscountGrantedAt: null,
    ticketDiscountExpiresAt: null,
    ticketDiscountConsumedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  flag.TICKET_FEATURE_ENABLED = true;
  flag.FAMINE_DISCOUNT_PCT = 77;
  flag.FAMINE_DISCOUNT_TTL_DAYS = 30;
  resetUser();
});

describe("discountedCents", () => {
  it("rounds 77% off to the nearest cent", () => {
    expect(discountedCents(700, 77)).toBe(161);
    expect(discountedCents(699, 77)).toBe(161);
  });
  it("clamps out-of-range percents", () => {
    expect(discountedCents(700, 0)).toBe(700);
    expect(discountedCents(700, -10)).toBe(700);
    expect(discountedCents(700, 150)).toBe(0);
  });
});

describe("activeDiscountFromColumns", () => {
  const future = new Date(NOW.getTime() + 1000);
  const past = new Date(NOW.getTime() - 1000);
  it("returns the discount when present, unconsumed, unexpired", () => {
    expect(
      activeDiscountFromColumns(
        { ticketDiscountPct: 77, ticketDiscountExpiresAt: future, ticketDiscountConsumedAt: null },
        NOW,
      ),
    ).toEqual({ pct: 77, expiresAt: future });
  });
  it("null when pct 0, consumed, or expired", () => {
    expect(
      activeDiscountFromColumns({ ticketDiscountPct: 0, ticketDiscountExpiresAt: future, ticketDiscountConsumedAt: null }, NOW),
    ).toBeNull();
    expect(
      activeDiscountFromColumns({ ticketDiscountPct: 77, ticketDiscountExpiresAt: future, ticketDiscountConsumedAt: NOW }, NOW),
    ).toBeNull();
    expect(
      activeDiscountFromColumns({ ticketDiscountPct: 77, ticketDiscountExpiresAt: past, ticketDiscountConsumedAt: null }, NOW),
    ).toBeNull();
  });
});

describe("getActiveDiscount", () => {
  it("null when the feature is off", async () => {
    flag.TICKET_FEATURE_ENABLED = false;
    resetUser({ ticketDiscountPct: 77, ticketDiscountExpiresAt: new Date(NOW.getTime() + 1000) });
    expect(await getActiveDiscount("u1", NOW)).toBeNull();
  });
  it("returns the active discount when the feature is on", async () => {
    const expiresAt = new Date(NOW.getTime() + 1000);
    resetUser({ ticketDiscountPct: 77, ticketDiscountExpiresAt: expiresAt });
    expect(await getActiveDiscount("u1", NOW)).toEqual({ pct: 77, expiresAt });
  });
});

describe("grantFamineDiscountIfEligible", () => {
  it("no-op when the feature is off", async () => {
    flag.TICKET_FEATURE_ENABLED = false;
    const res = await grantFamineDiscountIfEligible("u1", NOW);
    expect(res.granted).toBe(false);
    expect(db.user.ticketDiscountPct).toBe(0);
  });
  it("grants pct + a TTL deadline and clears consumedAt", async () => {
    resetUser({ ticketDiscountConsumedAt: NOW }); // previously used
    const res = await grantFamineDiscountIfEligible("u1", NOW);
    expect(res.granted).toBe(true);
    expect(res.pct).toBe(77);
    expect(db.user.ticketDiscountPct).toBe(77);
    expect(db.user.ticketDiscountConsumedAt).toBeNull();
    expect(db.user.ticketDiscountExpiresAt).toEqual(new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000));
  });
});

describe("consumeActiveDiscount", () => {
  it("consumes an active discount exactly once", async () => {
    resetUser({ ticketDiscountPct: 77, ticketDiscountExpiresAt: new Date(NOW.getTime() + 1000) });
    const first = await consumeActiveDiscount("u1", NOW);
    expect(first.consumed).toBe(true);
    expect(db.user.ticketDiscountConsumedAt).toEqual(NOW);
    // Second attempt is a no-op (CAS guard already flipped).
    const second = await consumeActiveDiscount("u1", NOW);
    expect(second.consumed).toBe(false);
  });
  it("no-op when the feature is off", async () => {
    flag.TICKET_FEATURE_ENABLED = false;
    resetUser({ ticketDiscountPct: 77, ticketDiscountExpiresAt: new Date(NOW.getTime() + 1000) });
    expect((await consumeActiveDiscount("u1", NOW)).consumed).toBe(false);
  });
});
