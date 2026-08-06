import { Router, type Request, type Response } from "express";
import { partnerPhotoRef, partnerPhotoSignatureValid } from "../partner-photos.js";
import { downloadProfileImage } from "../../services/storage.js";
import { getBotApi } from "../server.js";

/**
 * Byte proxy for the native cinematic pitch's partner photos.
 *
 * Mounted OUTSIDE the JWT `matchesRouter` on purpose: an image loader cannot
 * attach an Authorization header, so the URL carries a short-lived HMAC
 * instead (`public/partner-photos.ts`). Same shape as the referral card and
 * the founder report's media proxy.
 *
 * The signature is not the only check. Entitlement is re-resolved from the
 * database on every request, so a URL minted a minute before the match was
 * cancelled stops working with the match rather than outliving it for the
 * remainder of its ten minutes.
 */
export const matchMediaRouter: Router = Router();

matchMediaRouter.get("/partner-photo", async (req: Request, res: Response): Promise<void> => {
  const matchId = String(req.query.m ?? "");
  const viewerId = String(req.query.v ?? "");
  const index = Number(req.query.i);
  const expiresAt = Number(req.query.e);
  const sig = String(req.query.sig ?? "");

  if (!matchId || !viewerId || !Number.isInteger(index) || index < 0 || !sig) {
    res.status(400).json({ error: "Invalid photo request" });
    return;
  }
  if (!partnerPhotoSignatureValid(viewerId, matchId, index, expiresAt, sig)) {
    // One answer for a bad signature and an expired one: telling them apart
    // would confirm that a given match/viewer pair exists.
    res.status(403).json({ error: "Invalid or expired link" });
    return;
  }

  const ref = await partnerPhotoRef(viewerId, matchId, index);
  if (!ref) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const api = getBotApi();
  if (!api) {
    // Telegram-hosted refs need the bot to resolve `file_id` → file path.
    res.status(503).json({ error: "Media unavailable" });
    return;
  }

  const bytes = await downloadProfileImage(ref, api);
  if (!bytes) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.setHeader("Content-Type", "image/jpeg");
  // Private and short-lived: the URL is already scoped to one viewer, and the
  // entitlement behind it can end at any moment.
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(bytes);
});
