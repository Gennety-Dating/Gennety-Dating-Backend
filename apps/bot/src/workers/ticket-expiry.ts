import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { refundAndFallbackToScheduling } from "../handlers/matching/ticket-gate.js";

/**
 * Date Ticket expiry sweep.
 *
 * Finds matches whose ticket gate has stalled — `ticketStatus IN (pending,
 * partial)` with a lapsed `ticketExpiresAt` — and runs the refund + free
 * Calendar fallback. An accepted match is never killed by a payment stall;
 * the paying side (if any) is refunded (mock = no-op) and scheduling opens.
 *
 * Idempotent: `refundAndFallbackToScheduling` claims the terminal status flip
 * atomically, so a double tick refunds at most once. No quiet-hours gating —
 * a refund/notice is transactional, not promotional.
 */
export async function ticketExpiryTick(api: Api<RawApi>): Promise<{ swept: number }> {
  const now = new Date();
  const stale = await prisma.match.findMany({
    where: {
      status: "negotiating",
      ticketStatus: { in: ["pending", "partial"] },
      ticketExpiresAt: { not: null, lt: now },
    },
    select: { id: true },
    take: 200,
  });

  let swept = 0;
  for (const { id } of stale) {
    try {
      await refundAndFallbackToScheduling(api, id);
      swept += 1;
    } catch (err) {
      console.error(`[ticket-expiry] failed to sweep match ${id}:`, err);
    }
  }
  return { swept };
}
