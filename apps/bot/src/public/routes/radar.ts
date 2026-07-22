import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { prisma, type Prisma } from "@gennety/db";
import {
  ageBandFor,
  setsForPreference,
  radarPhotoById,
  photosForSet,
  reasonChipsFor,
  buildPreferenceVector,
  type RadarSet,
  type RadarAnswer,
  type Verdict,
  type PreferenceVector,
  type GenderPreference,
} from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import {
  resumeOnboardingAfterRadar,
  patchOnboardingSession,
} from "../../handlers/onboarding/type-radar.js";

/**
 * Type Radar Mini App API (PRODUCT_SPEC §Type Radar). A fast visual
 * appearance-preference calibration opened mid-onboarding (conversational
 * phase, right before the Magic Prompt) via a `web_app` button. The viewer
 * reacts "My Type" / "Not My Type" to a deck of contrasting portraits — the
 * age band is derived from the viewer's OWN age, the set(s) from their
 * gender preference — optionally tapping one reason chip. The server compiles
 * the verdicts into a per-set preference vector (`Profile.typePrefTags`) that
 * the match engine reads as the soft `V_type` multiplier.
 *
 * Auth: Telegram `initData` HMAC (same boundary as calendar/verification).
 * Feature-flagged: every route 404s when `TYPE_RADAR_ENABLED` is off.
 */

type AuthOk = { ok: true; telegramId: bigint };
type AuthErr = { ok: false; status: number; body: { error: string } };

function authenticate(req: Request): AuthOk | AuthErr {
  const authHeader = req.header("authorization") ?? req.header("Authorization");
  if (!authHeader?.startsWith("tma ")) {
    return { ok: false, status: 401, body: { error: "Missing tma initData" } };
  }
  const initData = authHeader.slice(4).trim();
  if (!initData) {
    return { ok: false, status: 401, body: { error: "Empty initData" } };
  }
  const validation = validateInitData(initData, env.BOT_TOKEN);
  if (!validation.valid) {
    return { ok: false, status: 401, body: { error: "Invalid initData" } };
  }
  return { ok: true, telegramId: BigInt(validation.user.id) };
}

/** Deterministic 32-bit hash of a string → seed for a stable per-user shuffle. */
function seedFrom(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Seeded Fisher–Yates so re-opening the radar shows a stable card order. */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const VALID_VERDICTS = new Set<Verdict>(["like", "dislike"]);
/** Hard cap on submitted answers: two full 12-card sets + slack. */
const MAX_ANSWERS = 40;

interface DeckCard {
  photoId: string;
  set: RadarSet;
  /** Path relative to the Mini App origin: `radar/<band>/<id>.jpg`. */
  image: string;
}

// Chip ids only — the Mini App owns the localized label per id in the viewer's
// language (chips carry no copy in the shared dataset).
function chipsForSet(set: RadarSet): { like: { id: string }[]; dislike: { id: string }[] } {
  const ids = (verdict: Verdict) => reasonChipsFor(set, verdict).map((c) => ({ id: c.id }));
  return { like: ids("like"), dislike: ids("dislike") };
}

export function createRadarRouter(api: Api<RawApi> | null): Router {
  const router = Router();

  // Whole feature ships dark — every route 404s until the flag is on.
  router.use((_req: Request, res: Response, next) => {
    if (!env.TYPE_RADAR_ENABLED) {
      res.status(404).json({ error: "type-radar-disabled" });
      return;
    }
    next();
  });

  // GET /v1/radar/deck — the cards to rate for THIS viewer (band from their own
  // age, set(s) from their preference) + the reason chips.
  router.get("/deck", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(auth.status).json(auth.body);
      return;
    }

    const user = await prisma.user.findUnique({
      where: { telegramId: auth.telegramId },
      select: { age: true, preference: true, language: true },
    });
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }
    // Radar runs after age + preference are collected; it can't build a deck
    // without them (the band and set(s) are derived, not asked).
    if (user.age == null || !user.preference) {
      res.status(409).json({ error: "profile-not-ready" });
      return;
    }

    const band = ageBandFor(user.age);
    const sets = setsForPreference(user.preference as GenderPreference);
    const cards: DeckCard[] = sets.flatMap((set) =>
      photosForSet(set).map((p) => ({
        photoId: p.id,
        set,
        image: `radar/${band}/${p.id}.jpg`,
      })),
    );
    const ordered = seededShuffle(cards, seedFrom(`${auth.telegramId}:${band}`));
    const chips: Partial<Record<RadarSet, ReturnType<typeof chipsForSet>>> = {};
    for (const set of sets) chips[set] = chipsForSet(set);

    res.json({ ok: true, band, cards: ordered, chips });
  });

  // POST /v1/radar/submit — persist the verdict log + compiled per-set vectors.
  router.post("/submit", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(auth.status).json(auth.body);
      return;
    }

    const user = await prisma.user.findUnique({
      where: { telegramId: auth.telegramId },
      select: { id: true, age: true, preference: true, onboardingStep: true },
    });
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }
    if (user.age == null || !user.preference) {
      res.status(409).json({ error: "profile-not-ready" });
      return;
    }

    const rawAnswers = (req.body as { answers?: unknown })?.answers;
    if (!Array.isArray(rawAnswers) || rawAnswers.length === 0) {
      res.status(400).json({ error: "no-answers" });
      return;
    }
    if (rawAnswers.length > MAX_ANSWERS) {
      res.status(400).json({ error: "too-many-answers" });
      return;
    }

    const sets = setsForPreference(user.preference as GenderPreference);
    const allowedSets = new Set<RadarSet>(sets);
    const answers: RadarAnswer[] = [];
    const seen = new Set<string>();
    for (const raw of rawAnswers) {
      const a = raw as { photoId?: unknown; verdict?: unknown; chipId?: unknown };
      if (typeof a.photoId !== "string" || typeof a.verdict !== "string") {
        res.status(400).json({ error: "invalid-answer" });
        return;
      }
      if (!VALID_VERDICTS.has(a.verdict as Verdict)) {
        res.status(400).json({ error: "invalid-verdict" });
        return;
      }
      const photo = radarPhotoById(a.photoId);
      // Ignore unknown photos or ones outside the viewer's set(s) — never trust
      // client-supplied ids to reach into a set they weren't shown.
      if (!photo || !allowedSets.has(photo.set)) continue;
      if (seen.has(a.photoId)) continue; // last-write dedupe not needed; first wins
      seen.add(a.photoId);
      const chipId =
        typeof a.chipId === "string" && a.chipId.length > 0 && a.chipId.length <= 40
          ? a.chipId
          : null;
      answers.push({ photoId: a.photoId, verdict: a.verdict as Verdict, chipId });
    }

    if (answers.length === 0) {
      res.status(400).json({ error: "no-valid-answers" });
      return;
    }

    // Compile one preference vector per set that actually received answers.
    const typePrefTags: Partial<Record<RadarSet, PreferenceVector>> = {};
    for (const set of sets) {
      const vector = buildPreferenceVector(set, answers);
      // Only store a set the viewer actually rated (buildPreferenceVector
      // returns empty-value maps for an unrated set).
      if (answers.some((ans) => radarPhotoById(ans.photoId)?.set === set)) {
        typePrefTags[set] = vector;
      }
    }

    const band = ageBandFor(user.age);
    // RadarAnswer / PreferenceVector are plain JSON-safe shapes; Prisma's
    // Json[] / Json input types don't accept our named interfaces directly.
    const answersJson = answers as unknown as Prisma.InputJsonValue[];
    const prefTagsJson = typePrefTags as unknown as Prisma.InputJsonValue;
    await prisma.profile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        typeRadarAnswers: answersJson,
        typePrefTags: prefTagsJson,
        typeRadarCompletedAt: new Date(),
        typeRadarAgeBand: band,
      },
      update: {
        typeRadarAnswers: answersJson,
        typePrefTags: prefTagsJson,
        typeRadarCompletedAt: new Date(),
        typeRadarAgeBand: band,
      },
    });

    // Resume the onboarding conversation past the radar gate (accepted → Magic
    // Prompt, declined → photos) and persist the resulting session state. Only
    // while the user is still onboarding; a post-onboarding retake just saves.
    // Best-effort: a resume hiccup never fails the save the Mini App relies on.
    if (api && user.onboardingStep !== "completed") {
      try {
        const { sessionPatch } = await resumeOnboardingAfterRadar(
          api,
          auth.telegramId,
          Number(auth.telegramId),
        );
        await patchOnboardingSession(auth.telegramId, sessionPatch);
      } catch (err) {
        console.warn("[radar] onboarding resume after submit failed", {
          telegramId: String(auth.telegramId),
          err,
        });
      }
    }

    res.json({ ok: true, counted: answers.length });
  });

  return router;
}
