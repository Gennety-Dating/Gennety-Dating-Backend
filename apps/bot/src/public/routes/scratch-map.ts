import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";

import { requireCanvasAuth } from "../canvas-auth.js";
import {
  readScratchMap,
  recordScratchPing,
  type ScratchRefusal,
} from "../../services/scratch-map.js";

/**
 * The Dating Scratch Map's two calls (PRODUCT_SPEC §Scratch Map).
 *
 * `GET  /v1/scratch` — what this person has uncovered.
 * `POST /v1/scratch/ping` — one foreground position, folded into a tile.
 * `PUT  /v1/scratch/opt-in` — the consent this whole feature runs under.
 *
 * **The ping is the only endpoint in the product that a client is expected to
 * call while nothing is happening**, so two things about it are deliberate.
 * It answers the CURRENT state on every call, including the common "you have
 * not moved" case, so the canvas needs no second request to draw the fog; and
 * a ping that uncovers nothing performs no write at all, because a person
 * sitting in a café would otherwise write a row every few seconds for a set
 * that never changes.
 *
 * Off by default and refused until the toggle is on. `scratchMapOptIn` is its
 * own column rather than a fold into `researchOptIn` for the reason the schema
 * gives: that one governs analytics use of data we already hold, this one
 * authorises COLLECTING a new class of it, and a consent that authorises new
 * collection is never inferred from a broader tick.
 */
export const scratchMapRouter: Router = Router();

// Either rail: the canvas is one screen on two clients (see canvas-auth.ts).
scratchMapRouter.use(requireCanvasAuth);

const REFUSAL_STATUS: Record<ScratchRefusal, number> = {
  // Not an error the user can fix by retrying — it is a setting, and the
  // client's job is to offer the toggle rather than to keep pinging.
  "opted-out": 409,
  "outside-market": 409,
  "bad-coordinates": 400,
};

scratchMapRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  const [state, user] = await Promise.all([
    readScratchMap(req.userId!),
    prisma.user.findUnique({
      where: { id: req.userId! },
      select: { scratchMapOptIn: true },
    }),
  ]);

  res.json({ optIn: user?.scratchMapOptIn ?? false, ...state });
});

scratchMapRouter.post("/ping", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as { lat?: unknown; lng?: unknown };
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: "lat and lng are required" });
    return;
  }

  const result = await recordScratchPing({ userId: req.userId!, lat, lng });
  if ("refused" in result) {
    res.status(REFUSAL_STATUS[result.refused]).json({ error: result.refused });
    return;
  }

  res.json({ ok: true, uncovered: result.uncovered, ...result.state });
});

scratchMapRouter.put("/opt-in", async (req: Request, res: Response): Promise<void> => {
  const enabled = (req.body as { enabled?: unknown }).enabled;
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }

  await prisma.user.update({
    where: { id: req.userId! },
    data: { scratchMapOptIn: enabled },
  });

  // **Switching it off does NOT erase what is already there**, and that is a
  // decision rather than an omission: the tiles are the person's own map, and
  // a toggle that silently deleted months of it would be a worse surprise than
  // one that stops collecting. Erasure is what account deletion is for, and it
  // reaches this row by cascade.
  const state = await readScratchMap(req.userId!);
  res.json({ ok: true, optIn: enabled, ...state });
});
