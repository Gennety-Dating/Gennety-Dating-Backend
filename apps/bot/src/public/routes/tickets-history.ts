import { Router, type Request, type Response } from "express";
import { env } from "../../config.js";
import { requireAuth } from "../auth-middleware.js";
import { listTicketHistory } from "../../services/ticket-wallet.js";

/**
 * The wallet's own movements for the native Tickets tab (TH1 / S2).
 *
 *   GET /v1/me/tickets/history?limit=&before=
 *
 * Until this route existed the tab could show a balance and nothing else: the
 * balance rides `GET /v1/me`, and `TicketLedger` — the append-only source that
 * balance is a running sum of — had no reader on `/v1` at all. A number with no
 * account behind it cannot answer the one question people bring to a wallet
 * ("where did my tickets go"), and the wallet is shared with the Telegram bot,
 * so a ticket can arrive or leave while the app is not even open.
 *
 * Read-only by construction. Nothing here writes, and no row is ever hidden:
 * the ledger is the audit trail, and a history that quietly omits a movement
 * would make the balance look wrong rather than make the movement look better.
 */
export const ticketsHistoryRouter: Router = Router();

ticketsHistoryRouter.use((_req: Request, res: Response, next): void => {
  // Same gate as the purchase route: with tickets switched off the wallet does
  // not exist, and 404 is what the rest of the ticket surface answers.
  if (!env.TICKET_FEATURE_ENABLED) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});
ticketsHistoryRouter.use(requireAuth);

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

ticketsHistoryRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  const rawLimit = Number(req.query.limit ?? DEFAULT_LIMIT);
  const limit =
    Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= MAX_LIMIT
      ? rawLimit
      : DEFAULT_LIMIT;
  const before = typeof req.query.before === "string" && req.query.before ? req.query.before : undefined;

  const page = await listTicketHistory({ userId: req.userId!, limit, before });
  if (page.status === "bad_cursor") {
    // Unknown cursor, or one belonging to another wallet — same answer either
    // way, so the response never confirms that a foreign row exists.
    res.status(404).json({ error: "Unknown cursor" });
    return;
  }

  res.json({
    entries: page.entries.map((entry) => ({
      id: entry.id,
      delta: entry.delta,
      reason: entry.reason,
      ...(entry.bundleSize != null ? { bundleSize: entry.bundleSize } : {}),
      createdAt: entry.createdAt.toISOString(),
    })),
    hasMore: page.hasMore,
  });
});
