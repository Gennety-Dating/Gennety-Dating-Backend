import { Router, type Request, type Response } from "express";
import { PULSE_ANALYTICS, pulseScreen } from "@gennety/shared";
import { getOrCompute } from "../utils/cache.js";
import {
  buildBrief,
  buildCatalog,
  buildFunnels,
  buildInsights,
  buildJourney,
  buildJourneys,
  buildScreenDetail,
  buildScreens,
  isScreenKey,
} from "../utils/pulse-read.js";
import { isUuid } from "../utils/uuid.js";

/**
 * Pulse: `/admin/pulse/*` (docs/product/domains/pulse-analytics.md §6).
 *
 * GET only, and readable with the read-only `ADMIN_READ_KEY` as well as the
 * full key (the gate is in `server.ts`). The response types are the contract
 * in `../utils/pulse-types.ts`; the agent playbook is
 * `docs/operations/agent-app-audit.md`.
 *
 * Everything is cached for five minutes (`?fresh=1` recomputes): the numbers
 * come from a nightly pre-aggregate, so a shorter TTL buys nothing, while an
 * agent walking the playbook hits the same endpoints several times a run.
 * Two reads are deliberately NOT cached: one person's journey (four indexed
 * queries, and a cache row per user id would litter `system_knowledge`
 * forever) and a screen key the registry does not know (an arbitrary key must
 * not mint cache rows either).
 */
export const pulseRouter: Router = Router();

const TTL = PULSE_ANALYTICS.adminCacheTtlSeconds;

function fail(res: Response, label: string, err: unknown): void {
  console.error(`[admin] pulse ${label} error:`, err);
  res.status(500).json({ error: "Internal server error" });
}

pulseRouter.get("/admin/pulse/brief", async (req: Request, res: Response) => {
  try {
    res.json(await getOrCompute("pulse:brief:v1", TTL, () => buildBrief(), { req, res }));
  } catch (err) {
    fail(res, "brief", err);
  }
});

pulseRouter.get("/admin/pulse/screens", async (req: Request, res: Response) => {
  try {
    res.json(await getOrCompute("pulse:screens:v1", TTL, () => buildScreens(), { req, res }));
  } catch (err) {
    fail(res, "screens", err);
  }
});

pulseRouter.get("/admin/pulse/screens/:screen", async (req: Request, res: Response) => {
  const screen = String(req.params["screen"] ?? "");
  if (!isScreenKey(screen)) {
    res.status(400).json({ error: "screen must match ^[a-z0-9_]{1,32}$" });
    return;
  }
  try {
    const data = pulseScreen(screen)
      ? await getOrCompute(`pulse:screen:v1:${screen}`, TTL, () => buildScreenDetail(screen), { req, res })
      : await buildScreenDetail(screen);
    res.json(data);
  } catch (err) {
    fail(res, "screen", err);
  }
});

/** `?limit=` clamped to 1..journeysMaxLimit; anything unparsable = the default. */
export function parseJourneyLimit(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return PULSE_ANALYTICS.journeysDefaultLimit;
  return Math.min(n, PULSE_ANALYTICS.journeysMaxLimit);
}

pulseRouter.get("/admin/pulse/journeys", async (req: Request, res: Response) => {
  const stuckOnly = String(req.query["stuck"] ?? "") === "1";
  const limit = parseJourneyLimit(req.query["limit"]);
  try {
    res.json(
      await getOrCompute(
        `pulse:journeys:v1:${stuckOnly ? "stuck" : "recent"}:${limit}`,
        TTL,
        () => buildJourneys({ stuckOnly, limit }),
        { req, res },
      ),
    );
  } catch (err) {
    fail(res, "journeys", err);
  }
});

pulseRouter.get("/admin/pulse/journeys/:userId", async (req: Request, res: Response) => {
  const userId = String(req.params["userId"] ?? "");
  if (!isUuid(userId)) {
    res.status(400).json({ error: "userId must be a UUID" });
    return;
  }
  try {
    const data = await buildJourney(userId);
    if (!data) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.setHeader("X-Data-Generated-At", data.generatedAt);
    res.setHeader("X-Data-Cache", "miss");
    res.json(data);
  } catch (err) {
    fail(res, "journey", err);
  }
});

pulseRouter.get("/admin/pulse/catalog", async (req: Request, res: Response) => {
  try {
    res.json(await getOrCompute("pulse:catalog:v1", TTL, () => buildCatalog(), { req, res }));
  } catch (err) {
    fail(res, "catalog", err);
  }
});

pulseRouter.get("/admin/pulse/funnels", async (req: Request, res: Response) => {
  try {
    res.json(await getOrCompute("pulse:funnels:v1", TTL, () => buildFunnels(), { req, res }));
  } catch (err) {
    fail(res, "funnels", err);
  }
});

pulseRouter.get("/admin/pulse/insights", async (req: Request, res: Response) => {
  const raw = String(req.query["status"] ?? "open");
  if (raw !== "open" && raw !== "all") {
    res.status(400).json({ error: "status must be open or all" });
    return;
  }
  try {
    res.json(await getOrCompute(`pulse:insights:v1:${raw}`, TTL, () => buildInsights(raw), { req, res }));
  } catch (err) {
    fail(res, "insights", err);
  }
});
