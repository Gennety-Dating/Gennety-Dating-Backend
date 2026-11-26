import {
  PLACE_ANCHOR_LABEL_MAX_LEN,
  PLACE_ANCHORS_MAX,
  PLACE_CATEGORIES,
  PLACE_DISH_NAME_MAX_LEN,
  PLACE_DISH_NOTE_MAX_LEN,
  PLACE_DISHES_MAX,
  PLACE_FOOTNOTE_MAX_LEN,
  PLACE_LINK_PROVIDERS,
  PLACE_LINKS_MAX,
  PLACE_REASON_MAX_LEN,
  PLACE_REVIEWS,
  PLACE_SCENE_KINDS,
  PLACE_SCENE_RULES,
  PLACE_SCENE_VENUES,
  PLACE_SEARCH_ABOUT_MAX_LEN,
  PLACE_SEARCH_LIMIT_MAX,
  PLACE_SUBTITLE_MAX_LEN,
  PLACE_TAG_MAX_LEN,
  PLACE_TAGS_MAX,
  PLACE_TITLE_MAX_LEN,
  PLACE_VERDICT_MAX_LEN,
  PLACE_VERSUS_LABEL_MAX_LEN,
  PLACE_VERSUS_ROWS_MAX,
  PLACE_VERSUS_VALUE_MAX_LEN,
  t,
  type Language,
  type PlaceSceneKind,
} from "@gennety/shared";
import { env } from "../config.js";
import {
  loadRegulars,
  placeCatalogForCity,
  placeCategoryLabel,
  placeClock,
  placeWalk,
  searchPlaces,
  type PlaceCatalog,
  type PlaceFacts,
  type PlaceWalk,
  type RegularPlace,
} from "./place-catalog.js";
import { loadPlaceReviews, type PlaceReview, type ReviewFetchDeps } from "./place-reviews.js";

/**
 * Place scenes — an answer about places drawn as an animated scene after the
 * reply, not a bubble (decision 2026-11-26; spec
 * `docs/product/domains/agent-place-scenes.md`; contract `ChatPlaceScene`).
 *
 * The model finds places with `search_venues` (and the person's own with
 * `get_my_places`), then calls `show_place_scene` with ids, a kind and a few
 * words. Every fact on the scene — name, category, address, point, photo,
 * rating, price, open now, hours, walking minutes, links — is filled here from
 * the catalog; the model never writes one. Labels are in the account language
 * and stored with the scene, so history draws it as it was shown; only the
 * photo link is signed again on every read, because it expires.
 *
 * A `reviews` scene carries real Google reviews (`place-reviews.ts`). Their
 * text may not be stored (Google Maps Platform Terms 3.2.3), so the stored
 * scene keeps only the Google place ID (`reviewsFrom`) and a history read
 * fetches the reviews again; without them the scene is drawn as `venue`.
 *
 * Capability-gated by `X-Gennety-Chat-Cards: places` and
 * `AGENT_PLACE_SCENES_ENABLED`: a build that does not draw scenes never gets
 * the tools, and Telegram never sees them.
 */

export const PLACE_SCENE_KIND = "place_scene";
/** Token an app build lists in `X-Gennety-Chat-Cards` when it draws place scenes. */
export const PLACE_SCENE_CLIENT_TOKEN = "places";
export const SHOW_PLACE_SCENE_TOOL_NAME = "show_place_scene";
export const SEARCH_VENUES_TOOL_NAME = "search_venues";
export const GET_MY_PLACES_TOOL_NAME = "get_my_places";


export interface PlaceSceneInterval {
  open: string;
  close: string;
}

/** One venue as stored; `photoVenueId` becomes a freshly signed `photoUrl` on every read. */
export interface StoredPlaceVenue {
  id: string;
  name: string;
  categoryLabel: string | null;
  address: string | null;
  lat: number;
  lng: number;
  photoVenueId: string | null;
  rating: number | null;
  ratingCount: number | null;
  priceLevel: number | null;
  openNow: boolean | null;
  hoursLabel: string | null;
  today: PlaceSceneInterval[];
  nowLocal: string | null;
  walkMinutes: number | null;
  distanceM: number | null;
  reason: string | null;
  tags: string[];
}

export interface PlaceAnchor {
  label: string;
  lat: number;
  lng: number;
  visits: number | null;
}

export interface PlaceDish {
  name: string;
  note: string | null;
  price: string | null;
}

export interface PlaceLink {
  provider: string;
  label: string;
  url: string;
}

export type VersusSide = "a" | "b" | "tie";

export interface PlaceVersus {
  winner: VersusSide;
  verdict: string | null;
  rows: Array<{ label: string; a: string; b: string; better: VersusSide }>;
}

/** Stored on `messages.attachment`. Everything here is shown; nothing is secret. */
export interface PlaceScene {
  kind: typeof PLACE_SCENE_KIND;
  sceneKind: PlaceSceneKind;
  title: string;
  subtitle: string | null;
  venues: StoredPlaceVenue[];
  anchors: PlaceAnchor[];
  dishes: PlaceDish[];
  links: PlaceLink[];
  versus: PlaceVersus | null;
  footnote: string | null;
  /**
   * `reviews` only: the board, in memory for the live reply and filled again
   * on a history read — ALWAYS empty in `messages.attachment`
   * ({@link storedPlaceScene}).
   */
  reviews: PlaceReview[];
  /** `reviews` only: where to fetch them again — a Google place ID may be stored. */
  reviewsFrom?: { placeId: string; language: Language };
  /** Written by the proactive tip worker, not by a turn (`place-tips.ts`). */
  proactive?: boolean;
}

/** `ChatPlaceReview` in the OpenAPI contract. */
export interface PlaceReviewView {
  author: string;
  rating: number | null;
  text: string;
  when: string | null;
  source: string;
}

/** What the app gets — `ChatPlaceScene` in the OpenAPI contract. */
export interface PlaceSceneView {
  kind: PlaceSceneKind;
  title: string;
  subtitle: string | null;
  venues: Array<Omit<StoredPlaceVenue, "photoVenueId"> & { photoUrl: string | null }>;
  anchors: PlaceAnchor[];
  dishes: PlaceDish[];
  links: PlaceLink[];
  reviews?: PlaceReviewView[];
  versus?: PlaceVersus;
  footnote: string | null;
}

/* ── the tools ──────────────────────────────────────────────────────────── */

export const SEARCH_VENUES_TOOL = {
  type: "function" as const,
  function: {
    name: SEARCH_VENUES_TOOL_NAME,
    description:
      "Search the places of their city in our catalog: cafés, coffee, restaurants, bars, parks, museums. Call it whenever they ask about a place — where to go, what is near, is X open, how far, A or B, what is good there — before show_place_scene. Returns ids and facts; only these ids may go on a scene.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "A place name, a street or district, a cuisine or a vibe, in any language («Win Bar», «Подол», «specialty coffee»). Omit to browse by category or nearness." },
        category: { type: "string", enum: [...PLACE_CATEGORIES], description: "lounge = bars." },
        near: { type: "string", description: "Rank by walking distance from this point: an id from get_my_places or from an earlier search_venues result." },
        open_now: { type: "boolean", description: "Only places open right now." },
        limit: { type: "integer", minimum: 1, maximum: PLACE_SEARCH_LIMIT_MAX },
      },
    },
  },
};

export const GET_MY_PLACES_TOOL = {
  type: "function" as const,
  function: {
    name: GET_MY_PLACES_TOOL_NAME,
    description:
      "The places they go to regularly (from frequently visited places, which they switched on): names and ids, top five by days visited in the last 60 days. Use for «что нового рядом с моими местами», a route from one of them, or a regulars scene. Never their home or work — only catalog venues.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  },
};

export const SHOW_PLACE_SCENE_TOOL = {
  type: "function" as const,
  function: {
    name: SHOW_PLACE_SCENE_TOOL_NAME,
    description:
      "Draw ONE animated place scene after your reply, with venue ids from search_venues. The server fills every fact (name, photo, rating, price, hours, open now, walking minutes, links) — pass only ids and your words. Kinds: venue (one place), picks (2–3 recommendations), regulars (a new place near their regular places; anchor_ids from get_my_places), reviews (one place worth an evening; the server pins 2–3 real Google reviews — never write one yourself), hours (is it open / until when), route (how far on foot; anchor_ids = one start), versus (exactly two places compared).",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "title", "venues"],
      properties: {
        kind: { type: "string", enum: [...PLACE_SCENE_KINDS] },
        title: { type: "string", description: `Short headline in their language, ≤${PLACE_TITLE_MAX_LEN} chars («Кофе рядом с Подолом»).` },
        subtitle: { type: "string", description: `One line under it, ≤${PLACE_SUBTITLE_MAX_LEN} chars. Omit for regulars and route: the server writes «4 мин от …».` },
        venues: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          description: "In order. venue/hours/route/reviews/regulars: 1; picks: 2–3; versus: exactly 2 (A then B).",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: {
              id: { type: "string", description: "An id from search_venues." },
              reason: { type: "string", description: `Why this one for THEM, ≤${PLACE_REASON_MAX_LEN} chars, their language. No facts the scene already shows.` },
              tags: { type: "array", maxItems: PLACE_TAGS_MAX, items: { type: "string" }, description: `Up to ${PLACE_TAGS_MAX} words from the search result's about/tags, their language, ≤${PLACE_TAG_MAX_LEN} chars each.` },
            },
          },
        },
        anchor_ids: {
          type: "array",
          maxItems: PLACE_ANCHORS_MAX,
          items: { type: "string" },
          description: "regulars: ids from get_my_places (omit = all of them). route: one start — an id from get_my_places or search_venues.",
        },
        versus: {
          type: "object",
          additionalProperties: false,
          required: ["winner"],
          description: "versus only. The server adds rating, price and walking rows itself; your rows are the qualities it cannot know (noise, view, vibe, for a date).",
          properties: {
            winner: { type: "string", enum: ["a", "b", "tie"] },
            verdict: { type: "string", description: `Who wins in a few words, ≤${PLACE_VERDICT_MAX_LEN} chars.` },
            rows: {
              type: "array",
              maxItems: PLACE_VERSUS_ROWS_MAX,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "a", "b", "better"],
                properties: {
                  label: { type: "string", description: `≤${PLACE_VERSUS_LABEL_MAX_LEN} chars («Шум»).` },
                  a: { type: "string", description: `≤${PLACE_VERSUS_VALUE_MAX_LEN} chars («тихо»).` },
                  b: { type: "string" },
                  better: { type: "string", enum: ["a", "b", "tie"] },
                },
              },
            },
          },
        },
        dishes: {
          type: "array",
          maxItems: PLACE_DISHES_MAX,
          description: "reviews only: names of things to try you expect there. The server keeps one only when a chosen review names it literally; anything else is dropped.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: { name: { type: "string" }, note: { type: "string" } },
          },
        },
        footnote: { type: "string", description: `Optional small print, ≤${PLACE_FOOTNOTE_MAX_LEN} chars.` },
      },
    },
  },
};

/* ── turn gating ────────────────────────────────────────────────────────── */

/** Whether this turn offers the place tools: the flag and a build that draws scenes. */
export function placeScenesThisTurn(chatCards: ReadonlySet<string> | undefined): boolean {
  return env.AGENT_PLACE_SCENES_ENABLED && (chatCards?.has(PLACE_SCENE_CLIENT_TOKEN) ?? false);
}

/** The prompt block on a turn that offers the tools. */
export const PLACE_SCENE_ADDENDUM = PLACE_SCENE_RULES;

/* ── text helpers ───────────────────────────────────────────────────────── */

/** Trim, collapse spaces, cut at a word where possible, never mid-surrogate. */
export function cut(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const clean = raw.replace(/\s+/g, " ").trim();
  const chars = [...clean];
  if (chars.length <= max) return clean;
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}

function side(raw: unknown): VersusSide | null {
  return raw === "a" || raw === "b" || raw === "tie" ? raw : null;
}

function normalized(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Dishes the venue's reviews actually name. Pure. A dish is kept only when its
 * name appears in one of the review texts; without any review text there are
 * no dishes at all — never an invented one.
 */
export function groundDishes(raw: unknown, reviewTexts: readonly string[]): PlaceDish[] {
  if (!Array.isArray(raw) || reviewTexts.length === 0) return [];
  const sources = reviewTexts.map(normalized);
  const out: PlaceDish[] = [];
  for (const item of raw) {
    const d = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const name = cut(d.name, PLACE_DISH_NAME_MAX_LEN);
    if (name.length < 3 || !sources.some((s) => s.includes(normalized(name)))) continue;
    if (out.some((dish) => normalized(dish.name) === normalized(name))) continue;
    out.push({ name, note: cut(d.note, PLACE_DISH_NOTE_MAX_LEN) || null, price: null });
    if (out.length >= PLACE_DISHES_MAX) break;
  }
  return out;
}

/* ── building a scene ───────────────────────────────────────────────────── */

export interface PlaceSceneContext {
  catalog: PlaceCatalog;
  /** Null: frequent places are off for them. */
  regulars: RegularPlace[] | null;
  language: Language;
  now: Date;
  /**
   * `reviews` only: the board already chosen for the first venue
   * (`loadPlaceReviews`, fetched by the caller so this stays pure).
   */
  reviews?: PlaceReview[] | null;
}

export type PlaceSceneOutcome =
  | { ok: true; scene: PlaceScene; result: string }
  | { ok: false; result: string };

function refused(error: string, instruction: string): PlaceSceneOutcome {
  return { ok: false, result: JSON.stringify({ success: false, error, instruction }) };
}

/** One venue as the scene shows it, every fact from the catalog. */
export function sceneVenue(
  place: PlaceFacts,
  input: { language: Language; now: Date; walk: PlaceWalk | null; reason?: unknown; tags?: unknown },
): StoredPlaceVenue {
  const clock = placeClock(place.periods, place.utcOffsetMinutes, input.now, input.language);
  const tags = (Array.isArray(input.tags) ? input.tags : [])
    .map((tag) => cut(tag, PLACE_TAG_MAX_LEN))
    .filter((tag) => tag.length > 0)
    .slice(0, PLACE_TAGS_MAX);
  return {
    id: place.id,
    name: place.name,
    categoryLabel: placeCategoryLabel(place.category, input.language),
    address: place.address.trim() || null,
    lat: place.lat,
    lng: place.lng,
    photoVenueId: place.photoVenueId,
    rating: place.rating,
    ratingCount: place.ratingCount,
    priceLevel: place.priceLevel,
    openNow: clock.openNow,
    hoursLabel: clock.hoursLabel,
    today: clock.today,
    nowLocal: clock.nowLocal,
    walkMinutes: input.walk?.walkMinutes ?? null,
    distanceM: input.walk?.distanceM ?? null,
    reason: cut(input.reason, PLACE_REASON_MAX_LEN) || null,
    tags,
  };
}

function anchorOf(regular: RegularPlace): PlaceAnchor {
  return { label: cut(regular.name, PLACE_ANCHOR_LABEL_MAX_LEN), lat: regular.lat, lng: regular.lng, visits: regular.visits };
}

/** A start point: one of their regular places first, then any catalog place. */
function resolveOrigin(id: unknown, ctx: PlaceSceneContext): { anchor: PlaceAnchor; point: { lat: number; lng: number } } | null {
  if (typeof id !== "string" || !id.trim()) return null;
  const key = id.trim();
  const regular = ctx.regulars?.find((r) => r.anchorId === key);
  if (regular) return { anchor: anchorOf(regular), point: regular };
  const place = ctx.catalog.byId.get(key);
  if (place) return { anchor: { label: cut(place.name, PLACE_ANCHOR_LABEL_MAX_LEN), lat: place.lat, lng: place.lng, visits: null }, point: place };
  return null;
}

function priceSigns(level: number | null): string | null {
  if (level == null) return null;
  return level === 0 ? "0" : "₴".repeat(level);
}

function betterOf(a: number | null, b: number | null, higherWins: boolean): VersusSide {
  if (a == null || b == null || a === b) return "tie";
  return (a > b) === higherWins ? "a" : "b";
}

/** The rows the server knows: rating, price, walking minutes. */
function factRows(a: StoredPlaceVenue, b: StoredPlaceVenue, language: Language): PlaceVersus["rows"] {
  const rows: PlaceVersus["rows"] = [];
  if (a.rating != null && b.rating != null) {
    rows.push({ label: t(language, "placeVersusRating"), a: a.rating.toFixed(1), b: b.rating.toFixed(1), better: betterOf(a.rating, b.rating, true) });
  }
  const pa = priceSigns(a.priceLevel);
  const pb = priceSigns(b.priceLevel);
  if (pa && pb) rows.push({ label: t(language, "placeVersusPrice"), a: pa, b: pb, better: betterOf(a.priceLevel, b.priceLevel, false) });
  if (a.walkMinutes != null && b.walkMinutes != null) {
    rows.push({ label: t(language, "placeVersusWalk"), a: `${a.walkMinutes}′`, b: `${b.walkMinutes}′`, better: betterOf(a.walkMinutes, b.walkMinutes, false) });
  }
  return rows;
}

function buildVersus(raw: unknown, a: StoredPlaceVenue, b: StoredPlaceVenue, language: Language): PlaceVersus {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rows = factRows(a, b, language);
  const taken = new Set(rows.map((r) => normalized(r.label)));
  for (const item of Array.isArray(v.rows) ? v.rows : []) {
    if (rows.length >= PLACE_VERSUS_ROWS_MAX) break;
    const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const label = cut(r.label, PLACE_VERSUS_LABEL_MAX_LEN);
    const va = cut(r.a, PLACE_VERSUS_VALUE_MAX_LEN);
    const vb = cut(r.b, PLACE_VERSUS_VALUE_MAX_LEN);
    // A number in the model's own row would be a fact it was told not to write.
    if (!label || !va || !vb || taken.has(normalized(label)) || /\d/.test(va + vb)) continue;
    taken.add(normalized(label));
    rows.push({ label, a: va, b: vb, better: side(r.better) ?? "tie" });
  }
  let winner = side(v.winner);
  if (!winner) {
    const score = rows.reduce((s, r) => s + (r.better === "a" ? 1 : r.better === "b" ? -1 : 0), 0);
    winner = score > 0 ? "a" : score < 0 ? "b" : "tie";
  }
  return { winner, verdict: cut(v.verdict, PLACE_VERDICT_MAX_LEN) || null, rows };
}

/**
 * Maps or web only — never a delivery service (founder, 2026-11-26). On a
 * `reviews` scene the Maps link is also where the person reads every review
 * in full, which Google's policies ask for.
 */
function linksFor(kind: PlaceSceneKind, place: PlaceFacts, language: Language): PlaceLink[] {
  const links: PlaceLink[] = [];
  if (place.mapsUri && kind !== "picks" && kind !== "versus") {
    links.push({ provider: "maps", label: t(language, "placeLinkMaps"), url: place.mapsUri });
  }
  return links.slice(0, PLACE_LINKS_MAX);
}

/** A link a scene may carry: a known provider, an https URL. */
function allowedLink(link: unknown): link is PlaceLink {
  if (!link || typeof link !== "object") return false;
  const l = link as Record<string, unknown>;
  return (
    PLACE_LINK_PROVIDERS.some((p) => p === l.provider) &&
    typeof l.label === "string" &&
    typeof l.url === "string" &&
    l.url.startsWith("https://")
  );
}

/** The venues the model named, in order: unknown ids drop out, one place twice counts once. */
export function pickedVenues(raw: unknown, catalog: PlaceCatalog): Array<{ place: PlaceFacts; reason: unknown; tags: unknown }> {
  const seen = new Set<string>();
  const picked: Array<{ place: PlaceFacts; reason: unknown; tags: unknown }> = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const v = (item && typeof item === "object" ? item : typeof item === "string" ? { id: item } : {}) as Record<string, unknown>;
    const place = typeof v.id === "string" ? catalog.byId.get(v.id.trim()) : undefined;
    if (!place || seen.has(place.id)) continue;
    seen.add(place.id);
    picked.push({ place, reason: v.reason, tags: v.tags });
  }
  return picked;
}

/**
 * The tool call as a scene, or the reason it is refused. Pure: the caller
 * stores it with the reply ({@link storedPlaceScene}).
 */
export function assemblePlaceScene(args: unknown, ctx: PlaceSceneContext): PlaceSceneOutcome {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const kind = PLACE_SCENE_KINDS.find((k) => k === a.kind);
  if (!kind) return refused("bad_kind", `kind must be one of ${PLACE_SCENE_KINDS.join(", ")}.`);

  const picked = pickedVenues(a.venues, ctx.catalog);
  const { min, max } = PLACE_SCENE_VENUES[kind];
  if (picked.length === 0) {
    return refused("no_valid_venue", "None of these ids is a place from search_venues. Call search_venues and use its ids, or answer in words.");
  }
  if (picked.length < min) {
    return refused("too_few_venues", kind === "versus"
      ? "versus needs exactly two places from search_venues."
      : "picks needs 2–3 places from search_venues; with one, use kind venue.");
  }
  const chosen = picked.slice(0, max);

  const rawAnchors = Array.isArray(a.anchor_ids) ? a.anchor_ids : [];
  let anchors: PlaceAnchor[] = [];
  let origin: { lat: number; lng: number } | null = null;
  let originLabel: string | null = null;
  let regularsFrom: RegularPlace[] = [];

  if (kind === "regulars") {
    if (!ctx.regulars || ctx.regulars.length === 0) {
      return refused("no_regulars", ctx.regulars
        ? "They have no regular places yet. Use kind venue or picks."
        : "Frequent places are off for them: no regulars scene. Use kind venue or picks, and do not talk about where they go.");
    }
    const asked = new Set(rawAnchors.filter((id): id is string => typeof id === "string").map((id) => id.trim()));
    regularsFrom = asked.size > 0 ? ctx.regulars.filter((r) => asked.has(r.anchorId)) : [];
    if (regularsFrom.length === 0) regularsFrom = ctx.regulars;
    anchors = regularsFrom.slice(0, PLACE_ANCHORS_MAX).map(anchorOf);
  } else if (rawAnchors.length > 0) {
    const start = resolveOrigin(rawAnchors[0], ctx);
    if (start) {
      origin = start.point;
      originLabel = start.anchor.label;
      if (kind === "route") anchors = [start.anchor];
    }
  }
  if (kind === "route" && !origin) {
    return refused("no_start", "route needs one start in anchor_ids: an id from get_my_places or search_venues. Ask where they start from, or use kind venue.");
  }

  const venues = chosen.map(({ place, reason, tags }) => {
    let walk: PlaceWalk | null = origin ? placeWalk(origin, place) : null;
    if (kind === "regulars") {
      let best: { walk: PlaceWalk; regular: RegularPlace } | null = null;
      for (const regular of regularsFrom) {
        if (regular.anchorId === place.placeId) continue;
        const w = placeWalk(regular, place);
        if (!best || w.distanceM < best.walk.distanceM) best = { walk: w, regular };
      }
      walk = best?.walk ?? null;
      if (best) originLabel = best.regular.name;
    }
    return sceneVenue(place, { language: ctx.language, now: ctx.now, walk, reason, tags });
  });

  const first = venues[0]!;
  const firstPlace = chosen[0]!.place;
  const links = linksFor(kind, firstPlace, ctx.language);
  const reviews = kind === "reviews" ? (ctx.reviews ?? []) : [];
  if (kind === "reviews" && (reviews.length < PLACE_REVIEWS.min || !firstPlace.placeId)) {
    return refused(
      "too_few_reviews",
      "This place has too few good reviews to pin on a board. Choose kind venue (or picks with another place) instead; never write a review yourself.",
    );
  }

  const autoSubtitle =
    (kind === "regulars" || kind === "route") && originLabel && first.walkMinutes != null
      ? cut(t(ctx.language, "placeFromAnchor", { minutes: first.walkMinutes, place: originLabel }), PLACE_SUBTITLE_MAX_LEN)
      : null;
  const scene: PlaceScene = {
    kind: PLACE_SCENE_KIND,
    sceneKind: kind,
    title: cut(a.title, PLACE_TITLE_MAX_LEN) || cut(first.name, PLACE_TITLE_MAX_LEN),
    subtitle: autoSubtitle ?? (cut(a.subtitle, PLACE_SUBTITLE_MAX_LEN) || null),
    venues,
    anchors,
    dishes: kind === "reviews" ? groundDishes(a.dishes, reviews.map((r) => r.text)) : [],
    links,
    versus: kind === "versus" ? buildVersus(a.versus, venues[0]!, venues[1]!, ctx.language) : null,
    // A reviews board says how its reviews were chosen (Google's policies), in our words.
    footnote: kind === "reviews"
      ? cut(t(ctx.language, "placeReviewsNotice"), PLACE_FOOTNOTE_MAX_LEN)
      : cut(a.footnote, PLACE_FOOTNOTE_MAX_LEN) || null,
    reviews,
    ...(kind === "reviews" && firstPlace.placeId ? { reviewsFrom: { placeId: firstPlace.placeId, language: ctx.language } } : {}),
  };

  return {
    ok: true,
    scene,
    result: JSON.stringify({
      success: true,
      shown: {
        kind,
        venues: venues.map((v) => ({ name: v.name, open: v.openNow, hours: v.hoursLabel, walkMinutes: v.walkMinutes })),
        ...(scene.versus ? { winner: scene.versus.winner } : {}),
        ...(kind === "reviews" ? { reviewsPinned: scene.reviews.length } : {}),
        dishes: scene.dishes.map((d) => d.name),
        links: scene.links.map((l) => l.provider),
      },
      instruction:
        "The scene is drawn AFTER your reply and shows the names, photo, rating, hours and minutes. Now write 1–2 short sentences in their language that add what it does not show — why it fits them, when to go, what to watch for. Do not repeat its facts." +
        (kind === "reviews"
          ? ` Real reviews are pinned on the board: do not quote, sum up or invent any.${scene.dishes.length === 0 ? " No dish was named in them: name no dish." : ""}`
          : ""),
    }),
  };
}

/* ── the turn's tool state ──────────────────────────────────────────────── */

/**
 * What the place tools of one turn share: the city's catalog and the person's
 * regular places, each read at most once and only when a tool asks.
 */
export class PlaceTurn {
  private catalogP: Promise<PlaceCatalog> | null = null;
  private regularsP: Promise<RegularPlace[] | null> | null = null;

  constructor(
    readonly input: { userId: string; cityKey: string; language: Language; now?: Date; regularsOn: boolean },
  ) {}

  get now(): Date {
    return this.input.now ?? new Date();
  }

  catalog(): Promise<PlaceCatalog> {
    this.catalogP ??= placeCatalogForCity(this.input.cityKey);
    return this.catalogP;
  }

  /** Null when frequent places are off for them; an unreadable log reads as none. */
  regulars(): Promise<RegularPlace[] | null> {
    if (!this.input.regularsOn) return Promise.resolve(null);
    this.regularsP ??= this.catalog()
      .then((catalog) => loadRegulars(this.input.userId, catalog, this.now.getTime()))
      .catch((err: unknown) => {
        console.warn("[places] regulars unavailable:", err instanceof Error ? err.name : "error");
        return [];
      });
    return this.regularsP;
  }
}

/** `get_my_places` — never reached without the opt-in: the tool is not offered then. */
export async function runGetMyPlaces(turn: PlaceTurn): Promise<string> {
  const regulars = await turn.regulars();
  if (regulars === null) {
    return JSON.stringify({ success: false, error: "frequent_places_off", instruction: "Frequent places are off for them. Do not talk about where they go." });
  }
  return JSON.stringify({
    success: true,
    places: regulars.map((r) => ({ id: r.anchorId, name: r.name, category: r.category, daysVisited: r.visits })),
    ...(regulars.length === 0 ? { instruction: "No regular places yet — answer without them." } : {}),
  });
}

/** `search_venues`. */
export async function runSearchVenues(turn: PlaceTurn, args: unknown): Promise<string> {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const [catalog, regulars] = await Promise.all([turn.catalog(), turn.regulars()]);
  let near: { lat: number; lng: number } | null = null;
  if (typeof a.near === "string" && a.near.trim()) {
    const key = a.near.trim();
    near = regulars?.find((r) => r.anchorId === key) ?? catalog.byId.get(key) ?? null;
  }
  const category = PLACE_CATEGORIES.find((c) => c === a.category) ?? null;
  const hits = searchPlaces(
    catalog,
    {
      query: typeof a.query === "string" ? a.query : null,
      category,
      near,
      openNow: a.open_now === true,
      ...(typeof a.limit === "number" ? { limit: a.limit } : {}),
    },
    { now: turn.now, language: turn.input.language, regulars: regulars ?? [] },
  );
  const regularIds = new Set((regulars ?? []).map((r) => r.anchorId));
  return JSON.stringify({
    success: true,
    venues: hits.map(({ place, clock, walk, nearestRegular }) => ({
      id: place.id,
      name: place.name,
      category: placeCategoryLabel(place.category, turn.input.language) ?? place.category,
      address: place.address,
      rating: place.rating,
      ratingCount: place.ratingCount,
      priceLevel: place.priceLevel,
      openNow: clock.openNow,
      hours: clock.hoursLabel,
      ...(walk ? { walkMinutes: walk.walkMinutes, distanceM: walk.distanceM } : {}),
      ...(nearestRegular && nearestRegular.walk.walkMinutes != null && nearestRegular.walk.distanceM <= 3000
        ? { nearTheirPlace: { id: nearestRegular.regular.anchorId, name: nearestRegular.regular.name, walkMinutes: nearestRegular.walk.walkMinutes } }
        : {}),
      ...(place.placeId && regularIds.has(place.placeId) ? { theirRegular: true } : {}),
      about: place.summary ? cut(place.summary, PLACE_SEARCH_ABOUT_MAX_LEN) : null,
      tags: place.vibeTags.slice(0, PLACE_TAGS_MAX),
    })),
    ...(hits.length === 0
      ? { instruction: "Nothing matched. Try a broader query, only a category, or no open_now — or say in words that you found nothing fitting." }
      : {}),
  });
}

/**
 * `show_place_scene`: the scene, or the refusal the model reads. A `reviews`
 * scene asks Google for the first venue's reviews here (one billed request).
 */
export async function runShowPlaceScene(turn: PlaceTurn, args: unknown, deps: ReviewFetchDeps = {}): Promise<PlaceSceneOutcome> {
  const [catalog, regulars] = await Promise.all([turn.catalog(), turn.regulars()]);
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  let reviews: PlaceReview[] | null = null;
  if (a.kind === "reviews") {
    const first = pickedVenues(a.venues, catalog)[0]?.place;
    reviews = first?.placeId ? await loadPlaceReviews(first.placeId, turn.input.language, turn.now, deps) : [];
  }
  return assemblePlaceScene(args, { catalog, regulars, language: turn.input.language, now: turn.now, reviews });
}

/* ── reading back ───────────────────────────────────────────────────────── */

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function readVenue(raw: unknown): StoredPlaceVenue | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const lat = num(v.lat);
  const lng = num(v.lng);
  if (typeof v.id !== "string" || typeof v.name !== "string" || lat === null || lng === null) return null;
  return {
    id: v.id,
    name: v.name,
    categoryLabel: str(v.categoryLabel),
    address: str(v.address),
    lat,
    lng,
    photoVenueId: str(v.photoVenueId),
    rating: num(v.rating),
    ratingCount: num(v.ratingCount),
    priceLevel: num(v.priceLevel),
    openNow: typeof v.openNow === "boolean" ? v.openNow : null,
    hoursLabel: str(v.hoursLabel),
    today: Array.isArray(v.today)
      ? v.today.filter((i): i is PlaceSceneInterval => Boolean(i) && typeof (i as PlaceSceneInterval).open === "string" && typeof (i as PlaceSceneInterval).close === "string")
      : [],
    nowLocal: str(v.nowLocal),
    walkMinutes: num(v.walkMinutes),
    distanceM: num(v.distanceM),
    reason: str(v.reason),
    tags: Array.isArray(v.tags) ? v.tags.filter((tag): tag is string => typeof tag === "string") : [],
  };
}

/** The stored JSON as a scene, or null for anything that is not one. */
export function readPlaceScene(raw: unknown): PlaceScene | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (c.kind !== PLACE_SCENE_KIND) return null;
  const sceneKind = PLACE_SCENE_KINDS.find((k) => k === c.sceneKind);
  if (!sceneKind || typeof c.title !== "string") return null;
  const venues = (Array.isArray(c.venues) ? c.venues : []).map(readVenue).filter((v): v is StoredPlaceVenue => v !== null);
  if (venues.length === 0) return null;
  const versus = c.versus && typeof c.versus === "object" ? (c.versus as PlaceVersus) : null;
  return {
    kind: PLACE_SCENE_KIND,
    sceneKind,
    title: c.title,
    subtitle: str(c.subtitle),
    venues,
    anchors: Array.isArray(c.anchors) ? (c.anchors as PlaceAnchor[]) : [],
    dishes: Array.isArray(c.dishes) ? (c.dishes as PlaceDish[]) : [],
    links: Array.isArray(c.links) ? c.links.filter(allowedLink) : [],
    versus: versus && Array.isArray(versus.rows) && side(versus.winner) ? versus : null,
    footnote: str(c.footnote),
    // Review text is never read from storage, even if a row held some.
    reviews: [],
    ...(reviewsFromOf(c.reviewsFrom) ? { reviewsFrom: reviewsFromOf(c.reviewsFrom)! } : {}),
    ...(c.proactive === true ? { proactive: true } : {}),
  };
}

function reviewsFromOf(raw: unknown): PlaceScene["reviewsFrom"] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return typeof r.placeId === "string" && r.placeId && typeof r.language === "string"
    ? { placeId: r.placeId, language: r.language as Language }
    : null;
}

/**
 * What goes into `messages.attachment`: the scene without review text, which
 * Google's terms do not let us store — `reviewsFrom` (a place ID, which may be
 * stored) is enough to fetch them again.
 */
export function storedPlaceScene(scene: PlaceScene): PlaceScene {
  return { ...scene, reviews: [] };
}

/**
 * A stored `reviews` scene with its board fetched again from Google, the
 * dishes re-checked against the fresh texts. No board (Google failed, the
 * reviews changed): the scene comes back without reviews and is drawn as
 * `venue` ({@link placeSceneView}).
 */
export async function withFreshReviews(scene: PlaceScene, now: Date, deps: ReviewFetchDeps = {}): Promise<PlaceScene> {
  if (scene.sceneKind !== "reviews" || !scene.reviewsFrom) return scene;
  const reviews = await loadPlaceReviews(scene.reviewsFrom.placeId, scene.reviewsFrom.language, now, deps);
  return { ...scene, reviews, dishes: groundDishes(scene.dishes, reviews.map((r) => r.text)) };
}

/**
 * History: the `reviews` scenes of one page get their boards again, newest
 * first and at most `PLACE_REVIEWS.historyRefetchMax` per read (each is a
 * billed request); the rest are drawn as `venue`. Returns the refreshed
 * scenes by row id.
 */
export async function refreshHistoryReviews(
  rows: ReadonlyArray<{ id: string; createdAt: Date; scene: PlaceScene }>,
  now: Date,
  deps: ReviewFetchDeps = {},
): Promise<Map<string, PlaceScene>> {
  const wanted = rows
    .filter((r) => r.scene.sceneKind === "reviews" && r.scene.reviewsFrom)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, PLACE_REVIEWS.historyRefetchMax);
  const fresh = await Promise.all(wanted.map(async (r) => [r.id, await withFreshReviews(r.scene, now, deps)] as const));
  return new Map(fresh);
}

/**
 * `ChatPlaceScene` as the app draws it. `photoUrl` signs a catalog id at the
 * moment of the response — the route's signer (`/v1/venues/:id/photo`), kept
 * out of this layer.
 */
export function placeSceneView(scene: PlaceScene, photoUrl: (venueId: string) => string | null): PlaceSceneView {
  // A reviews board without its reviews is a postcard of the venue.
  const board = scene.sceneKind === "reviews" && scene.reviews.length >= PLACE_REVIEWS.min;
  const degraded = scene.sceneKind === "reviews" && !board;
  return {
    kind: degraded ? "venue" : scene.sceneKind,
    title: scene.title,
    subtitle: scene.subtitle,
    venues: scene.venues.map(({ photoVenueId, ...venue }) => ({
      ...venue,
      photoUrl: photoVenueId ? photoUrl(photoVenueId) : null,
    })),
    anchors: scene.anchors,
    dishes: degraded ? [] : scene.dishes,
    links: scene.links.filter(allowedLink),
    ...(board
      ? { reviews: scene.reviews.map(({ author, rating, text, when, source }) => ({ author, rating, text, when, source })) }
      : {}),
    ...(scene.versus ? { versus: scene.versus } : {}),
    footnote: degraded ? null : scene.footnote,
  };
}

/** What the model reads under its own earlier reply. */
export function placeSceneNote(scene: PlaceScene): string {
  const names = scene.venues.map((v) => `«${v.name}» (id ${v.id})`).join(", ");
  return `[Place scene (${scene.sceneKind}) after this reply: ${names}. Its facts are on their screen; don't repeat them. A follow-up about these places may reuse the ids.]`;
}
