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
    // План возвратов сверяется с реестром: возвращается то, за что
    // действительно платили, а не всё, что помечено оплаченным.
    findMany: async ({
      where,
    }: {
      where: { matchId: string; userId: { in: string[] } };
    }) =>
      db.ledger.filter(
        (row) => row.matchId === where.matchId && where.userId.in.includes(row.userId as string),
      ),
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

/**
 * @param opts.coveredByPremium стороны, чей слот закрыла подписка, а не оплата.
 *   Для них след в реестре НЕ создаётся — ровно как в проде, где Premium-ветка
 *   гейта пишет нулевую строку без денег.
 */
function seedMatch(
  over: Partial<MatchRow> = {},
  opts: { coveredByPremium?: Array<"A" | "B"> } = {},
): void {
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

  // `ticketPaid*` означает «слот закрыт», а не «за слот заплатили» — эти два
  // факта разошлись, когда появился Premium. Фикстура обязана моделировать
  // ОБА: отметку на матче и след оплаты в реестре. Без второго тест «слот
  // оплачен» проверял бы ровно то, что сломано.
  const premium = new Set(opts.coveredByPremium ?? []);
  const payers = new Set<string>();
  if (db.match.ticketPaidA !== null && !premium.has("A")) {
    payers.add(db.match.paidForPartnerByB ? db.match.userBId : db.match.userAId);
  }
  if (db.match.ticketPaidB !== null && !premium.has("B")) {
    payers.add(db.match.paidForPartnerByA ? db.match.userAId : db.match.userBId);
  }
  for (const userId of payers) {
    db.ledger.push({ userId, matchId: "m1", delta: -1, reason: "spend_match" });
  }
}


/**
 * Только строки возврата.
 *
 * В реестре теперь лежит и след оплаты, который сеет `seedMatch` — без него
 * план возвратов справедливо не увидит, за что платили. Ассерты про возврат
 * должны смотреть на возвраты, а не на весь журнал.
 */
function refundRows(): Array<Record<string, unknown>> {
  return db.ledger.filter((row) => row.reason === "refund");
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

  /**
   * Регрессия на дефект аудита 2026-09-06 («Бизнес-логика, высокий риск»).
   *
   * Premium-ветка гейта закрывает слот БЕСПЛАТНО, ставя ту же отметку
   * `ticketPaidA/B`, что и оплата. План возвратов смотрел только на неё — и
   * отменённое свидание клало подписчику в кошелёк НАСТОЯЩИЙ билет, которого
   * он не покупал. Билет тратится на гейт наравне с купленными, то есть
   * подписка печатала валюту, и тем быстрее, чем чаще отменяются свидания.
   */
  it("не возвращает билет за слот, закрытый подпиской", async () => {
    // A — подписчик: слот закрыт, денег не было. B заплатил за свой.
    seedMatch({}, { coveredByPremium: ["A"] });

    const plan = await planMatchTicketRefunds("m1");

    expect(plan).toHaveLength(1);
    expect(plan[0]!.userId).toBe(B);
    expect(plan[0]!.slots).toEqual(["B"]);
  });

  it("ничего не планирует, когда подписка закрыла оба слота", async () => {
    seedMatch({}, { coveredByPremium: ["A", "B"] });
    expect(await planMatchTicketRefunds("m1")).toEqual([]);
  });

  it("возвращает Stars-оплату гейта: денег в строке достаточно, списания нет", async () => {
    // Stars-гейт не трогает кошелёк — он пишет нулевую строку с `amountStars`.
    // Признак оплаты обязан её узнавать, иначе честный плательщик потерял бы
    // возврат ровно так же тихо, как подписчик его получал.
    seedMatch({}, { coveredByPremium: ["A", "B"] });
    db.ledger.push({ userId: A, matchId: "m1", delta: 0, reason: "gate_payment", amountStars: 150 });

    const plan = await planMatchTicketRefunds("m1");

    expect(plan).toHaveLength(1);
    expect(plan[0]!.userId).toBe(A);
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
    expect(refundRows().map((r) => r.reason)).toEqual(["refund", "refund"]);
    expect(refundRows().map((r) => r.matchId)).toEqual(["m1", "m1"]);
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
    expect(refundRows()).toHaveLength(2);
    expect(second.map((o) => o.refunded)).toEqual([0, 0]);
  });

  it("is idempotent for a coverer's two slots too", async () => {
    seedMatch({ paidForPartnerByA: true });
    await refundMatchTickets("m1");
    await refundMatchTickets("m1");

    expect(db.users.get(A)!.ticketBalance).toBe(2);
    expect(refundRows()).toHaveLength(2);
  });

  it("never credits a balance below zero or a negative delta", async () => {
    seedMatch();
    await refundMatchTickets("m1");

    for (const row of refundRows()) expect(row.delta).toBe(1);
    for (const user of db.users.values()) expect(user.ticketBalance).toBeGreaterThanOrEqual(0);
  });

  it("skips a payer whose account is gone but still refunds the other side", async () => {
    seedMatch();
    db.users.delete(A);

    const outcomes = await refundMatchTickets("m1");

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].userId).toBe(B);
    expect(db.users.get(B)!.ticketBalance).toBe(1);
    expect(refundRows()).toHaveLength(1);
  });

  it("returns an empty result for an unpaid match", async () => {
    seedMatch({ ticketPaidA: null, ticketPaidB: null });
    expect(await refundMatchTickets("m1")).toEqual([]);
    expect(refundRows()).toEqual([]);
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
    expect(refundRows()).toHaveLength(2);
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
