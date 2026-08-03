import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import {
  listPurchases,
  type PurchaseKind,
  type PurchaseRow,
  type PurchaseStatus,
} from "../../services/purchases.js";
import { isUuid } from "../utils/uuid.js";

/**
 * `GET /admin/purchases` — every real money movement in the product, newest
 * first, with WHO paid inlined.
 *
 * The dashboard's revenue surface. It reads the four tables that already own
 * the money (`services/purchases.ts` explains why there is no `purchases`
 * table) and joins the payer's identity onto each row, because the whole point
 * of the list is answering "who bought this" without a second lookup — the
 * Telegram `@username` on the Telegram rail, the phone number on the mobile
 * one, where a synthetic negative `telegramId` and no username is normal.
 *
 * Deliberately NOT cached: unlike the analytics tabs this is a ledger view,
 * and a founder checking whether a payment landed must not be shown a
 * ten-minute-old answer.
 */

const KINDS: readonly PurchaseKind[] = [
  "tickets",
  "date_ticket",
  "premium",
  "rematch",
  "venue_change",
];
const STATUSES: readonly PurchaseStatus[] = [
  "settled",
  "processing",
  "refunded",
  "refund_failed",
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseIntParam(raw: unknown, fallback: number, max: number): number {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(value, max);
}

function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The payer block inlined on every row. */
const PAYER_SELECT = {
  id: true,
  firstName: true,
  surname: true,
  age: true,
  gender: true,
  telegramId: true,
  telegramUsername: true,
  phone: true,
  email: true,
  platform: true,
  status: true,
  ticketBalance: true,
  premiumUntil: true,
} as const;

export const purchasesRouter: Router = Router();

purchasesRouter.get("/admin/purchases", async (req: Request, res: Response) => {
  try {
    const limit = Math.max(1, parseIntParam(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT));
    const offset = parseIntParam(req.query.offset, 0, 100_000);

    const kindParam = String(req.query.kind ?? "");
    const statusParam = String(req.query.status ?? "");
    const since = parseDate(req.query.since);
    const until = parseDate(req.query.until);

    // Same rule as every `:id` on this surface (`utils/uuid.ts`): a non-UUID
    // reaches Prisma as `P2023`, not as "no rows", and the catch below would
    // report a mistyped filter as "Internal server error". `?userId=` is a
    // query param rather than a path segment, which is how it escaped the guard.
    const userId = String(req.query.userId ?? "");
    if (userId && !isUuid(userId)) {
      res.status(400).json({ error: "userId must be a UUID" });
      return;
    }

    const page = await listPurchases(
      {
        ...(KINDS.includes(kindParam as PurchaseKind) ? { kind: kindParam as PurchaseKind } : {}),
        ...(STATUSES.includes(statusParam as PurchaseStatus)
          ? { status: statusParam as PurchaseStatus }
          : {}),
        ...(userId ? { userId } : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
      },
      { limit, offset },
    );

    res.json({
      data: await withPayers(page.rows),
      total: page.total,
      limit,
      offset,
      totals: page.totals,
      byKind: page.byKind,
    });
  } catch (err) {
    console.error("[admin] purchases list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** Attach the payer to each row in ONE query for the whole page. */
export async function withPayers(
  rows: readonly PurchaseRow[],
): Promise<Array<Record<string, unknown>>> {
  const userIds = [...new Set(rows.map((row) => row.userId))];
  const users =
    userIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: PAYER_SELECT })
      : [];
  const byId = new Map(users.map((user) => [user.id, user]));

  return rows.map((row) => {
    const user = byId.get(row.userId);
    return {
      ...row,
      createdAt: row.createdAt.toISOString(),
      user: user
        ? {
            ...user,
            // BigInt is not JSON-safe, and a mobile-only account's id is a
            // synthetic NEGATIVE number rather than a real Telegram id.
            telegramId: user.telegramId.toString(),
            isMobileOnlyId: user.telegramId < 0n,
            premiumUntil: user.premiumUntil?.toISOString() ?? null,
          }
        : null,
    };
  });
}
