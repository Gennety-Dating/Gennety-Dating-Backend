import { createHash } from "node:crypto";
import { prisma, type Prisma } from "@gennety/db";
import {
  STYLE_PICKS_JSON_SCHEMA,
  STYLE_PICKS_PER_CATEGORY,
  STYLE_PICKS_TTL_DAYS,
  STYLE_REASON_MAX_CHARS,
  STYLE_SIGNAL_MAX_CHARS,
  stylePicksPrompt,
  stylePicksUserContent,
  type StylePicksDigest,
} from "@gennety/shared";
import { callOpenAIJson } from "../openai.js";
import { shortlistProducts, toCatalogItem, type StyleCatalogItem } from "./catalog.js";
import { buildStyleDigest, loadStyleDigestSource, type StyleDigestSource } from "./digest.js";
import { styleOutUrl } from "./out-link.js";
import {
  badgesFor,
  validateStylePicks,
  type RawStylePicks,
  type ResponseBadge,
  type StoredPickSet,
} from "./validate.js";

/**
 * Vibe Check — the dedicated style-picks agent (decision journal 2026-10-08).
 *
 *   digest (no model) → prefilter (no model) → ONE cheap model call →
 *   validation → cache → response with localized badges and signed links.
 *
 * Budget: one `MODELS.agent` call per person per week at most (the cache),
 * about 1.5k tokens in and 600 out. The cache is keyed by language + a hash of
 * the digest and the shortlist, so a profile or catalog change regenerates and
 * nothing else does. A failed generation serves the latest cached set, if any;
 * otherwise the caller answers 204.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_TOKENS = 900;

export interface StylePickCard {
  id: string;
  category: string;
  brand: string;
  name: string;
  reason: string;
  signals: string[];
  priceTier: number;
  imageUrl: string | null;
  outUrl: string;
  sponsored: boolean;
  badges: ResponseBadge[];
}

export interface StylePicksResponse {
  generatedAt: string;
  language: string;
  basis: string[];
  picks: StylePickCard[];
}

export interface CachedSet {
  language: string;
  profileHash: string;
  payload: StoredPickSet;
  generatedAt: Date;
}

export interface StylePicksDeps {
  loadSource(userId: string): Promise<{ source: StyleDigestSource; language: string } | null>;
  loadCatalog(): Promise<StyleCatalogItem[]>;
  callModel(system: string, user: string): Promise<RawStylePicks | null>;
  latestSet(userId: string): Promise<CachedSet | null>;
  saveSet(userId: string, set: Omit<CachedSet, "generatedAt">): Promise<CachedSet>;
  now(): number;
}

export function stylePicksHash(
  language: string,
  digest: StylePicksDigest,
  shortlist: StyleCatalogItem[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ language, digest, ids: shortlist.map((p) => p.id) }))
    .digest("hex");
}

function isStoredPickSet(value: unknown): value is StoredPickSet {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as StoredPickSet).basis) &&
    Array.isArray((value as StoredPickSet).picks)
  );
}

/** Join a stored set to the CURRENT catalog — a product retired since is dropped. */
export function renderStylePicks(
  userId: string,
  set: CachedSet,
  catalog: StyleCatalogItem[],
  language: string,
  now: number,
): StylePicksResponse | null {
  const byId = new Map(catalog.filter((p) => p.active).map((p) => [p.id, p]));
  const picks: StylePickCard[] = [];
  for (const pick of set.payload.picks) {
    const item = byId.get(pick.id);
    if (!item) continue;
    picks.push({
      id: item.id,
      category: item.category,
      brand: item.brand,
      name: item.name,
      reason: pick.reason,
      signals: pick.signals,
      priceTier: item.priceTier,
      imageUrl: item.imageUrl,
      outUrl: styleOutUrl(userId, item.id, language, now),
      sponsored: item.sponsored,
      badges: badgesFor(item, pick.forYou, language),
    });
  }
  if (picks.length === 0) return null;
  return {
    generatedAt: set.generatedAt.toISOString(),
    language: set.language,
    basis: set.payload.basis,
    picks,
  };
}

/** Rough token estimate for the log line (~4 characters per token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** In-flight generations, so two taps never pay for two model calls. */
const inFlight = new Map<string, Promise<StylePicksResponse | null>>();

export function getStylePicks(
  userId: string,
  deps: StylePicksDeps = defaultDeps,
): Promise<StylePicksResponse | null> {
  const running = inFlight.get(userId);
  if (running) return running;
  const task = computeStylePicks(userId, deps).finally(() => inFlight.delete(userId));
  inFlight.set(userId, task);
  return task;
}

async function computeStylePicks(
  userId: string,
  deps: StylePicksDeps,
): Promise<StylePicksResponse | null> {
  const loaded = await deps.loadSource(userId);
  if (!loaded) return null;
  const { language } = loaded;
  const now = deps.now();
  const catalog = await deps.loadCatalog();
  const latest = await deps.latestSet(userId);
  const fallback = () => (latest ? renderStylePicks(userId, latest, catalog, language, now) : null);

  const digest = buildStyleDigest(loaded.source);
  if (!digest) return null; // a thin profile gets nothing rather than generic picks

  const shortlist = shortlistProducts(catalog, digest);
  if (shortlist.length === 0) return fallback();
  const profileHash = stylePicksHash(language, digest, shortlist);

  if (
    latest &&
    latest.language === language &&
    latest.profileHash === profileHash &&
    now - latest.generatedAt.getTime() < STYLE_PICKS_TTL_DAYS * DAY_MS
  ) {
    const cached = renderStylePicks(userId, latest, catalog, language, now);
    if (cached) return cached;
  }

  const system = stylePicksPrompt({
    language,
    picksPerCategory: STYLE_PICKS_PER_CATEGORY,
    reasonMaxChars: STYLE_REASON_MAX_CHARS,
    signalMaxChars: STYLE_SIGNAL_MAX_CHARS,
  });
  const user = stylePicksUserContent(
    digest,
    shortlist.map(({ id, category, brand, name, notes, tags, priceTier }) => ({
      id,
      category,
      brand,
      name,
      notes,
      tags,
      priceTier,
    })),
  );

  const started = Date.now();
  const raw = await deps.callModel(system, user);
  const validated = validateStylePicks(raw, shortlist);
  console.info(
    `[style-picks] generation ${validated ? "ok" : "failed"} picks=${validated?.picks.length ?? 0}` +
      ` forYou=${validated?.picks.filter((p) => p.forYou).length ?? 0}` +
      ` inTokens≈${estimateTokens(system + user)} shortlist=${shortlist.length} ms=${Date.now() - started}`,
  );
  if (!validated) return fallback();

  const saved = await deps.saveSet(userId, { language, profileHash, payload: validated });
  return renderStylePicks(userId, saved, catalog, language, now) ?? fallback();
}

export const defaultDeps: StylePicksDeps = {
  loadSource: loadStyleDigestSource,
  async loadCatalog() {
    const rows = await prisma.styleProduct.findMany({ where: { active: true } });
    return rows.map(toCatalogItem).filter((item): item is StyleCatalogItem => item !== null);
  },
  callModel(system, user) {
    // Token spend is metered by `openaiFetch` against the request's usage
    // context (the route runs under `usageGuard`), like every other AI route.
    return callOpenAIJson<RawStylePicks>(system, user, {
      jsonSchema: STYLE_PICKS_JSON_SCHEMA,
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.4,
    });
  },
  async latestSet(userId) {
    const row = await prisma.stylePickSet.findFirst({
      where: { userId },
      orderBy: { generatedAt: "desc" },
    });
    if (!row || !isStoredPickSet(row.payload)) return null;
    return {
      language: row.language,
      profileHash: row.profileHash,
      payload: row.payload,
      generatedAt: row.generatedAt,
    };
  },
  async saveSet(userId, set) {
    // Only the latest set is kept: it is both the cache and the fallback.
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.stylePickSet.create({
        data: {
          userId,
          language: set.language,
          profileHash: set.profileHash,
          payload: set.payload as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.stylePickSet.deleteMany({ where: { userId, id: { not: created.id } } });
      return created;
    });
    return { ...set, generatedAt: row.generatedAt };
  },
  now: () => Date.now(),
};
