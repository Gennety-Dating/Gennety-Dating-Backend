import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import {
  MEMORY_IDEA_KINDS,
  MEMORY_INTENTS,
  MEMORY_PREFERENCE_FACETS,
  MEMORY_RATINGS,
  MEMORY_REASONS,
  MEMORY_USES,
  type Language,
  type MemoryIdeaKind,
  type MemoryIntent,
  type MemoryPreferenceFacet,
  type MemoryRating,
  type MemoryReason,
  type MemoryUse,
} from "@gennety/shared";
import { requireAuth } from "../auth-middleware.js";
import { memoryIdeasLimiter } from "../rate-limit.js";
import { memoryIdeasOn } from "../../services/feature-preview.js";
import { isUuid } from "../../utils/uuid.js";
import {
  confirmPreference,
  deleteIdea,
  deletionScope,
  getIdea,
  listIdeas,
  listPreferences,
  mergeIdeas,
  MemoryIdeaError,
  reasonQuestions,
  removeSource,
  revokePreference,
  saveIdea,
  setIntent,
  setOnlyForMe,
  setPlace,
  setPreferenceMatching,
  setReason,
  setUsage,
  snoozeReason,
  splitIdea,
  type ChangeOptions,
} from "../../services/memory-ideas.js";
import {
  cancelReminder,
  dateMemo,
  ideaMap,
  pendingImpressions,
  planningSuggestions,
  recordImpression,
  setReminder,
  vibeQuestion,
} from "../../services/memory-planning.js";

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

function changeOptions(req: Request): ChangeOptions {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const key = req.get("Idempotency-Key");
  return {
    ...(key && key.length <= 120 ? { idempotencyKey: key } : {}),
    ...(Number.isInteger(body.expectedVersion) ? { expectedVersion: body.expectedVersion as number } : {}),
    actor: "person",
  };
}

/**
 * Ideas for the native client (docs/product/domains/memory-ideas.md). The owner
 * is always the token's person. With the flag off a person can still see, narrow
 * and delete what exists; only saving and granting stop.
 */
export function createMemoryRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(memoryIdeasLimiter);

  const guarded =
    (handler: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await handler(req, res);
      } catch (err) {
        if (err instanceof MemoryIdeaError) {
          res.status(err.status).json({ error: err.code });
          return;
        }
        throw err;
      }
    };
  const enabled = (req: Request, res: Response): boolean => {
    if (memoryIdeasOn(req.userId)) return true;
    res.status(404).json({ error: "feature-disabled" });
    return false;
  };
  const ideaId = (req: Request, res: Response): string | null => {
    const id = String(req.params.id);
    if (isUuid(id)) return id;
    res.status(400).json({ error: "bad-request" });
    return null;
  };
  const userOf = (req: Request): string => req.userId as string;

  router.get("/ideas", guarded(async (req, res) => {
    const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
    if (before && Number.isNaN(before.getTime())) {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    res.json(await listIdeas(userOf(req), {
      ...(typeof req.query.kind === "string" ? { kind: req.query.kind } : {}),
      ...(typeof req.query.intent === "string" ? { intent: req.query.intent } : {}),
      ...(typeof req.query.q === "string" ? { query: req.query.q.slice(0, 120) } : {}),
      ...(before ? { before } : {}),
    }));
  }));

  router.post("/ideas", guarded(async (req, res) => {
    if (!enabled(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const screenshotId = typeof body.screenshotId === "string" && isUuid(body.screenshotId) ? body.screenshotId : null;
    const url = typeof body.url === "string" ? body.url : null;
    const quote = typeof body.quote === "string" ? body.quote : null;
    if (!oneOf(MEMORY_IDEA_KINDS, body.kind) || typeof body.title !== "string" || (!screenshotId && !url && !quote) || (body.reason != null && !oneOf(MEMORY_REASONS, body.reason))) {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    const key = req.get("Idempotency-Key");
    const saved = await saveIdea(userOf(req), {
      kind: body.kind as MemoryIdeaKind,
      title: body.title,
      ...(typeof body.note === "string" ? { note: body.note } : {}),
      ...(typeof body.topic === "string" ? { topic: body.topic } : {}),
      ...(typeof body.city === "string" ? { city: body.city } : {}),
      ...(typeof body.placeId === "string" ? { placeId: body.placeId } : {}),
      ...(body.reason ? { reason: body.reason as MemoryReason } : {}),
      ...(typeof body.recipient === "string" ? { recipient: body.recipient } : {}),
      intent: "want",
      source: {
        kind: screenshotId ? "screenshot" : url ? "link" : "manual",
        provenance: "person",
        screenshotItemId: screenshotId,
        url,
        quote,
      },
      ...(key ? { idempotencyKey: key } : {}),
    });
    res.status(saved.created ? 201 : 200).json(saved);
  }));

  router.get("/ideas/questions", guarded(async (req, res) => {
    res.json({ items: memoryIdeasOn(userOf(req)) ? await reasonQuestions(userOf(req)) : [] });
  }));

  router.get("/ideas/:id", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (id) res.json(await getIdea(userOf(req), id));
  }));

  router.patch("/ideas/:id", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (!id) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const options = changeOptions(req);
    if (oneOf(MEMORY_INTENTS, body.intent)) {
      res.json(await setIntent(userOf(req), id, body.intent as MemoryIntent, options));
      return;
    }
    if (oneOf(MEMORY_REASONS, body.reason)) {
      res.json(await setReason(userOf(req), id, body.reason as MemoryReason, typeof body.recipient === "string" ? body.recipient : null, options));
      return;
    }
    if (body.snoozeReason === true) {
      res.json(await snoozeReason(userOf(req), id));
      return;
    }
    if (body.placeId !== undefined && (body.placeId === null || typeof body.placeId === "string")) {
      if (body.placeId !== null && !enabled(req, res)) return;
      res.json(await setPlace(userOf(req), id, body.placeId as string | null, typeof body.city === "string" ? body.city : null, options));
      return;
    }
    res.status(400).json({ error: "bad-request" });
  }));

  /** One use on or off, or `onlyForMe`. Off always works, also with the flag off. */
  router.put("/ideas/:id/usage", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (!id) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.onlyForMe === true) {
      res.json(await setOnlyForMe(userOf(req), id, changeOptions(req)));
      return;
    }
    if (!oneOf(MEMORY_USES, body.use) || typeof body.allow !== "boolean") {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    if (body.allow && !enabled(req, res)) return;
    res.json(await setUsage(userOf(req), id, body.use as MemoryUse, body.allow, changeOptions(req)));
  }));

  router.post("/ideas/:id/merge", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (!id || !enabled(req, res)) return;
    const from = (req.body as Record<string, unknown> | undefined)?.fromId;
    if (typeof from !== "string" || !isUuid(from)) {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    res.json(await mergeIdeas(userOf(req), id, from, changeOptions(req)));
  }));

  router.post("/ideas/:id/split", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (!id) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sourceIds = body.sourceIds;
    if (!Array.isArray(sourceIds) || !sourceIds.every((s) => typeof s === "string" && isUuid(s)) || typeof body.title !== "string") {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    res.json(await splitIdea(userOf(req), id, sourceIds as string[], body.title, changeOptions(req)));
  }));

  router.get("/ideas/:id/deletion-scope", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (id) res.json(await deletionScope(userOf(req), id));
  }));

  router.delete("/ideas/:id", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (!id) return;
    await deleteIdea(userOf(req), id);
    res.status(204).end();
  }));

  router.delete("/ideas/:id/sources/:sourceId", guarded(async (req, res) => {
    const id = ideaId(req, res);
    const sourceId = String(req.params.sourceId);
    if (!id) return;
    if (!isUuid(sourceId)) {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    res.json(await removeSource(userOf(req), id, sourceId));
  }));

  router.put("/ideas/:id/reminder", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (!id || !enabled(req, res)) return;
    res.json(await setReminder(userOf(req), id));
  }));

  router.delete("/ideas/:id/reminder", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (!id) return;
    await cancelReminder(userOf(req), id);
    res.status(204).end();
  }));

  router.get("/map", guarded(async (req, res) => {
    res.json(memoryIdeasOn(userOf(req)) ? await ideaMap(userOf(req)) : { points: [], withoutPoint: [] });
  }));

  /** What ideas add to one date's planning. Empty looks the same for every reason. */
  router.get("/matches/:id/planning", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (!id) return;
    if (!memoryIdeasOn(userOf(req))) {
      res.json({ suggestions: [], shared: [], vibe: [], vibeIds: { experiences: [], ambiences: [] } });
      return;
    }
    res.json(await planningSuggestions(id, userOf(req), { city: typeof req.query.city === "string" ? req.query.city.slice(0, 80) : null }));
  }));

  /** The owner's own note for a date. Never served to the other side. */
  router.get("/matches/:id/memo", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (!id) return;
    res.json(memoryIdeasOn(userOf(req)) ? await dateMemo(id, userOf(req)) : { ideas: [], references: [] });
  }));

  router.get("/impressions/pending", guarded(async (req, res) => {
    res.json({ items: memoryIdeasOn(userOf(req)) ? await pendingImpressions(userOf(req)) : [] });
  }));

  router.put("/matches/:id/impression", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (!id || !enabled(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rating = (v: unknown) => v == null || oneOf(MEMORY_RATINGS, v);
    if (!rating(body.placeRating) || !rating(body.formatRating) || (body.repeatFormat != null && typeof body.repeatFormat !== "boolean")) {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    await recordImpression(id, userOf(req), {
      placeRating: (body.placeRating as MemoryRating | null | undefined) ?? null,
      formatRating: (body.formatRating as MemoryRating | null | undefined) ?? null,
      repeatFormat: (body.repeatFormat as boolean | null | undefined) ?? null,
      note: typeof body.note === "string" ? body.note : null,
      skipped: body.skipped === true,
    });
    res.status(204).end();
  }));

  /** One question, or none. The answer goes to `POST /preferences` as facet and option id. */
  router.get("/vibe-question", guarded(async (req, res) => {
    if (!memoryIdeasOn(userOf(req))) {
      res.json({ question: null });
      return;
    }
    const account = await prisma.user.findUnique({ where: { id: userOf(req) }, select: { language: true } });
    res.json({ question: await vibeQuestion(userOf(req), (account?.language ?? "en") as Language) });
  }));

  router.get("/preferences", guarded(async (req, res) => {
    res.json({ items: await listPreferences(userOf(req)) });
  }));

  router.post("/preferences", guarded(async (req, res) => {
    if (!enabled(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!oneOf(MEMORY_PREFERENCE_FACETS, body.facet) || typeof body.value !== "string") {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    res.status(201).json(await confirmPreference(userOf(req), body.facet as MemoryPreferenceFacet, body.value, typeof body.ideaId === "string" && isUuid(body.ideaId) ? body.ideaId : null));
  }));

  router.put("/preferences/:id/matching", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (!id) return;
    const allow = (req.body as Record<string, unknown> | undefined)?.allow;
    if (typeof allow !== "boolean") {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    if (allow && !enabled(req, res)) return;
    res.json(await setPreferenceMatching(userOf(req), id, allow));
  }));

  router.delete("/preferences/:id", guarded(async (req, res) => {
    const id = ideaId(req, res);
    if (!id) return;
    await revokePreference(userOf(req), id);
    res.status(204).end();
  }));

  return router;
}
