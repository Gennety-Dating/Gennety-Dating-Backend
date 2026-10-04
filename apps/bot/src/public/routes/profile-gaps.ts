import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import { loadProfileGaps } from "../../services/profile-gaps.js";

/**
 * GET /v1/me/profile-gaps — the unfinished items of the caller's profile, in
 * the fixed priority order the Today nudge walks (founder decision 2026-10-01).
 *
 * One request per Today refresh instead of six: before it, the app could only
 * learn whether a feature exists by a 404 from each feature's own route, and
 * had no way at all to see whether the photo bonus was already claimed. What
 * counts as open, and why, is in `services/profile-gaps.ts`. Read-only.
 */
export const profileGapsRouter: Router = Router();

profileGapsRouter.use(requireAuth);

profileGapsRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  const gaps = await loadProfileGaps(req.userId!);
  if (!gaps) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({ gaps });
});
