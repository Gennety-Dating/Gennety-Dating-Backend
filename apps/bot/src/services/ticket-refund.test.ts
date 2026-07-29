/**
 * Unit tests for Date Ticket refunds on a match that died before the date
 * (PRODUCT_SPEC §3.5b). The Prisma client is a small in-memory mock that mirrors
 * exactly what the planner reads and what `grantTickets` writes — including the
 * unique `externalPaymentId` index, since that index IS the idempotency
 * guarantee this feature rests on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ env: { TICKET_FEATURE_ENABLED: true } }));

interface MatchRow {
  id: string;
  ticketStatus: string;
  ticketPaidA: Date | null;
  ticketPaidB: Date | null;
  paidForPartnerByA: boolean;
  paidForPartnerByB: boolean;
  userAId: string;
  userBId: string;
}

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const db = {
  match: null as MatchRow | null,
  users: new Map<string, { id: string; ticketBalance: number }>(),
  ledger: [] as Array<Record<string, unknown>>,
};

/** Mirrors the unique index on `TicketLedger.externalPaymentId`. */
function assertUniqueExternalId(externalPaymentId: unknown): void {
  if (externalPaymentId == null) return;
  if (db.ledger.some((row) => row.externalPaymentId === externalPaymentId)) {
    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  }
}

/**
 * Prisma's `$transaction([...])` takes LAZY `PrismaPromise`s — nothing runs
 * until the transaction executes them — and rolls the whole batch back if any
 * one fails. Both properties matter here: they are why a duplicate-key ledger
 * insert leaves the balance untouched instead of crediting a second ticket. An
 * eager mock would silently "pass" a double-credit bug, so the writes are
 * modelled as thenables the transaction drives itself.
 */
function lazy<T>(run: () => Promise<T>): PromiseLike<T> {
  return {
    then: <R1, R2>(
      onOk?: ((value: T) => R1 | PromiseLike<R1>) | null,
      onErr?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
    ) => run().then(onOk, onErr),
  };
}

const prismaMock = {
  match: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      db.match && db.match.id === where.id
        ? {
            ...db.match,
            userA: { telegramId: 100n, language: "en", platform: "telegram" },
            userB: { telegramId: 200n, language: "ru", platform: "mobile" },
          }
        : null,
  },
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => db.users.get(where.id) ?? null,
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: { ticketBalance: { increment: number } };
    }) =>
      lazy(async () => {
        const user = db.users.get(where.id);
        if (!user) throw Object.assign(new Error("Record not found"), { code: "P2025" });
        user.ticketBalance += data.ticketBalance.increment;
        return { ticketBalance: user.ticketBalance };
      }),
  },
  ticketLedger: {
    create: ({ data }: { data: Record<string, unknown> }) =>
      lazy(async () => {
        assertUniqueExternalId(data.externalPaymentId);
        db.ledger.push(data);
        return data;
      }),
  },
  $transaction: async (ops: PromiseLike<unknown>[]) => {
    const balancesBefore = new Map([...db.users].map(([id, u]) => [id, u.ticketBalance]));
    const ledgerBefore = db.ledger.length;
    const out: unknown[] = [];
    try {
      for (const op of ops) out.push(await op);
      return out;
    } catch (err) {
      for (const [id, balance] of balancesBefore) {
        const user = db.users.get(id);
        if (user) user.ticketBalance = balance;
      }
      db.ledger.length = ledgerBefore;
      throw err;
    }
  },
};

vi.mock("@gennety/db", () => ({ prisma: prismaMock }));

const {
  planMatchTicketRefunds,
  applyTicketRefunds,
  refundMatchTickets,
  ticketRefundNoticeKey,
} = await import("./ticket-refund.js");

function seedMatch(over: Partial<MatchRow> = {}): void {
  db.match = {
    id: "m1",
    ticketStatus: "completed",
    ticketPaidA: new Date(),
    ticketPaidB: new Date(),
    paidForPartnerByA: false,
    paidForPartnerByB: false,
    userAId: A,
    userBId: B,
    ...over,
  };
}

beforeEach(() => {
  db.match = null;
  db.users = new Map([
    [A, { id: A, ticketBalance: 0 }],
    [B, { id: B, ticketBalance: 0 }],
  ]);
  db.ledger = [];
});

describe("planMatchTicketRefunds", () => {
  it("maps each paid slot to its own side by default", async () => {
    seedMatch();
    const plan = await planMatchTicketRefunds("m1");

    expect(plan).toHaveLength(2);
    expect(plan.find((c) => c.userId === A)?.slots).toEqual(["A"]);
    expect(plan.find((c) => c.userId === B)?.slots).toEqual(["B"]);
    // Contact details are captured at plan time, so delivery works even after
    // the row is cascaded away by an account deletion.
    expect(plan.find((c) => c.userId === B)).toMatchObject({
      telegramId: 200n,
      language: "ru",
      platform: "mobile",
    });
  });

  it("credits BOTH slots to the payer who covered their partner", async () => {
    seedMatch({ paidForPartnerByA: true });
    const plan = await planMatchTicketRefunds("m1");

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ userId: A, slots: ["A", "B"] });
  });

  it("credits a covered slot to the coverer when B paid for A", async () => {
    seedMatch({ paidForPartnerByB: true });
    const plan = await planMatchTicketRefunds("m1");

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ userId: B, slots: ["A", "B"] });
  });

  it("plans only the slot that was actually paid (partial gate)", async () => {
    seedMatch({ ticketStatus: "partial", ticketPaidB: null });
    const plan = await planMatchTicketRefunds("m1");

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ userId: A, slots: ["A"] });
  });

  it("plans nothing when the gate was never paid", async () => {
    seedMatch({ ticketStatus: "pending", ticketPaidA: null, ticketPaidB: null });
    expect(await planMatchTicketRefunds("m1")).toEqual([]);
  });

  it.each(["refunded", "refund_pending", "expired"])(
    "stands down on ticketStatus=%s, which the expiry rail owns",
    async (ticketStatus) => {
      seedMatch({ ticketStatus });
      expect(await planMatchTicketRefunds("m1")).toEqual([]);
    },
  );

  it("plans nothing for a match that no longer exists", async () => {
    expect(await planMatchTicketRefunds("gone")).toEqual([]);
  });

  /**
   * The 24 h proposal TTL (`services/match-expiry.ts`) needs no refund hook:
   * every slot CAS in `ticket-gate.ts` carries `status: "negotiating"`, and the
   * gate only opens after mutual accept — so a `proposed` row can never hold a
   * paid slot. Pinned as a test rather than a comment, because if that ever
   * changes the planner is already correct and only the wiring would be missing.
   */
  it("has nothing to refund on a proposed match (the gate never opened)", async () => {
    seedMatch({ ticketStatus: "pending", ticketPaidA: null, ticketPaidB: null });
    expect(await planMatchTicketRefunds("m1")).toEqual([]);
  });
});

describe("refundMatchTickets", () => {
  it("credits one wallet ticket per paid slot", async () => {
    seedMatch();
    const outcomes = await refundMatchTickets("m1");

    expect(db.users.get(A)!.ticketBalance).toBe(1);
    expect(db.users.get(B)!.ticketBalance).toBe(1);
    expect(outcomes.map((o) => o.refunded)).toEqual([1, 1]);
    expect(db.ledger.map((r) => r.reason)).toEqual(["refund", "refund"]);
    expect(db.ledger.map((r) => r.matchId)).toEqual(["m1", "m1"]);
  });

  it("gives the coverer two tickets", async () => {
    seedMatch({ paidForPartnerByA: true });
    const outcomes = await refundMatchTickets("m1");

    expect(db.users.get(A)!.ticketBalance).toBe(2);
    expect(db.users.get(B)!.ticketBalance).toBe(0);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].refunded).toBe(2);
  });

  it("is idempotent — a second call credits nothing", async () => {
    seedMatch();
    await refundMatchTickets("m1");
    const second = await refundMatchTickets("m1");

    expect(db.users.get(A)!.ticketBalance).toBe(1);
    expect(db.users.get(B)!.ticketBalance).toBe(1);
    expect(db.ledger).toHaveLength(2);
    expect(second.map((o) => o.refunded)).toEqual([0, 0]);
  });

  it("is idempotent for a coverer's two slots too", async () => {
    seedMatch({ paidForPartnerByA: true });
    await refundMatchTickets("m1");
    await refundMatchTickets("m1");

    expect(db.users.get(A)!.ticketBalance).toBe(2);
    expect(db.ledger).toHaveLength(2);
  });

  it("never credits a balance below zero or a negative delta", async () => {
    seedMatch();
    await refundMatchTickets("m1");

    for (const row of db.ledger) expect(row.delta).toBe(1);
    for (const user of db.users.values()) expect(user.ticketBalance).toBeGreaterThanOrEqual(0);
  });

  it("skips a payer whose account is gone but still refunds the other side", async () => {
    seedMatch();
    db.users.delete(A);

    const outcomes = await refundMatchTickets("m1");

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].userId).toBe(B);
    expect(db.users.get(B)!.ticketBalance).toBe(1);
    expect(db.ledger).toHaveLength(1);
  });

  it("returns an empty result for an unpaid match", async () => {
    seedMatch({ ticketPaidA: null, ticketPaidB: null });
    expect(await refundMatchTickets("m1")).toEqual([]);
    expect(db.ledger).toEqual([]);
  });

  it("resumes a partially-applied refund instead of re-crediting the first slot", async () => {
    seedMatch({ paidForPartnerByA: true });
    // Simulate a crash after slot A was credited but before slot B.
    const plan = await planMatchTicketRefunds("m1");
    await applyTicketRefunds([{ ...plan[0], slots: ["A"] }]);
    expect(db.users.get(A)!.ticketBalance).toBe(1);

    const outcomes = await refundMatchTickets("m1");

    expect(outcomes[0].refunded).toBe(1); // only the outstanding slot
    expect(db.users.get(A)!.ticketBalance).toBe(2);
    expect(db.ledger).toHaveLength(2);
  });
});

describe("ticketRefundNoticeKey", () => {
  it("picks singular, plural, or nothing", () => {
    expect(ticketRefundNoticeKey(0)).toBeNull();
    expect(ticketRefundNoticeKey(-1)).toBeNull();
    expect(ticketRefundNoticeKey(1)).toBe("ticketRefundedToWallet");
    expect(ticketRefundNoticeKey(2)).toBe("ticketRefundedToWalletBoth");
  });
});
