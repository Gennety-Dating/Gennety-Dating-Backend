import { Router, type NextFunction, type Request, type Response } from "express";
import { parseRhythmUpload } from "@gennety/shared";

import { env } from "../../config.js";
import { requireAuth } from "../auth-middleware.js";
import { rhythmLimiter } from "../rate-limit.js";
import { deleteRhythm, readOwnRhythm, saveRhythm } from "../../services/rhythm/store.js";

/**
 * Life rhythm — Tempo Sync (decision journal 2026-09-24, variant B).
 *
 * `GET    /v1/me/rhythm` — the owner's own tags, for the "Твой темп" card.
 * `PUT    /v1/me/rhythm` — replace them with a fresh on-device reduction.
 * `DELETE /v1/me/rhythm` — "Отключить": forget them now.
 *
 * Native app only (JWT rail): only the iOS client can read Apple Health, so a
 * Telegram `tma` credential has nothing to send here. The account is shared
 * across clients (`/v1/auth/telegram` lands on the same `User`), so tags synced
 * from the app apply to that person wherever they are matched.
 *
 * Nothing about the request is logged: the error handler never reads the body,
 * and these handlers log no values. Whole router 404s while
 * `TEMPO_SYNC_ENABLED` is off — the feature does not exist until the policy
 * that discloses it is published.
 */
export const rhythmRouter: Router = Router();

rhythmRouter.use((_req: Request, res: Response, next: NextFunction): void => {
  if (!env.TEMPO_SYNC_ENABLED) {
    res.status(404).json({ error: "feature-disabled" });
    return;
  }
  next();
});
rhythmRouter.use(requireAuth);
// After auth, so the key is the person rather than a shared address.
rhythmRouter.use(rhythmLimiter);

rhythmRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  res.json({ profile: await readOwnRhythm(req.userId!) });
});

rhythmRouter.put("/", async (req: Request, res: Response): Promise<void> => {
  const parsed = parseRhythmUpload(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const profile = await saveRhythm(req.userId!, parsed.value);
  res.json({ ok: true, profile });
});

rhythmRouter.delete("/", async (req: Request, res: Response): Promise<void> => {
  await deleteRhythm(req.userId!);
  // 204 whether or not a row existed: "forget me" is idempotent, and telling
  // the two apart would only let a client probe whether data was held.
  res.status(204).end();
});
