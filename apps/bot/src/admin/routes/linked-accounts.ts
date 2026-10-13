/**
 * GET /admin/users/linked-groups — accounts that look like the same person,
 * grouped (decision 2026-10-13): a shared profile photo, or a deleted account
 * whose Telegram id / phone / email came back on a new one. Read-only and for
 * the operator only — a second account is allowed, and nothing in the product
 * reads this. The per-account view is `linkedAccounts` on `/admin/users/:id`.
 *
 * Registered before `/admin/users/:id` (routers mount ahead of the inline
 * handlers in `server.ts`), so `linked-groups` is never read as an id.
 */
import { Router, type Request, type Response } from "express";
import { linkedAccountGroups } from "../../services/linked-accounts.js";

export const linkedAccountsRouter: Router = Router();

linkedAccountsRouter.get("/admin/users/linked-groups", async (_req: Request, res: Response) => {
  try {
    const groups = await linkedAccountGroups();
    res.json({
      data: groups.map((group) => ({
        ...group,
        members: group.members.map((member) => ({
          ...member,
          createdAt: member.createdAt?.toISOString() ?? null,
        })),
      })),
      total: groups.length,
    });
  } catch (err) {
    console.error("[admin] linked groups error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
