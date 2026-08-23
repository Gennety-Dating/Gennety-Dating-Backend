import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import { isUuid } from "../../services/match-engine.js";
import { listBlockedUsers, unblockUser } from "../../services/user-block.js";

/**
 * The blocker's own list of blocked people (App Store guideline 1.2).
 *
 *   GET    /v1/me/blocks           — who this user has blocked, newest first
 *   DELETE /v1/me/blocks/:userId   — lift one block
 *
 * Blocking itself is `POST /v1/matches/:id/block`, because a match is the only
 * way two people ever meet here and therefore the only handle the client has.
 * Only the reverse operations need a user id, and by then the list has given
 * the client one.
 *
 * The list shows a first name and a date and nothing else — enough to recognise
 * a mistake and undo it, and no more. It never reveals who blocked THIS user;
 * that direction is not readable by anybody.
 */
export function createUserBlocksRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    const blocks = await listBlockedUsers(req.userId!);
    res.json({
      blocks: blocks.map((entry) => ({
        userId: entry.userId,
        firstName: entry.firstName,
        blockedAt: entry.blockedAt.toISOString(),
      })),
    });
  });

  router.delete("/:userId", async (req: Request, res: Response): Promise<void> => {
    const userId = String(req.params.userId ?? "");
    // Validated before the query so a malformed id is a 404 and not a Postgres
    // uuid-cast error surfacing as a 500.
    if (!isUuid(userId)) {
      res.status(404).json({ error: "No such block" });
      return;
    }
    const lifted = await unblockUser(req.userId!, userId);
    if (!lifted) {
      res.status(404).json({ error: "No such block" });
      return;
    }
    res.status(204).end();
  });

  return router;
}
