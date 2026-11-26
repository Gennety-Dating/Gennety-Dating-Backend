/**
 * Proactive place tips (decision 2026-11-26; spec
 * `docs/product/domains/agent-place-scenes.md`, phase 5, and agent-advisor
 * phase 4): the agent writes first with a `regulars` scene — a catalog place
 * near the places the person keeps going to, one they have never been to.
 *
 * Who gets one, all of it checked here and nowhere else:
 * - the flag `AGENT_PLACE_TIPS_ENABLED`, or the founder's preview list;
 * - frequent places switched on (the only source of «their places»);
 * - not banned, not muted by «только мои свидания», an app account;
 * - their local daytime (`PLACE_TIPS.dayFromHour`…`dayToHour`) and never in
 *   the quiet hours of their zone;
 * - at most one tip per `PLACE_TIPS.everyDays`, and none for
 *   `PLACE_TIPS.silenceDays` after two tips in a row went unanswered;
 * - a place within `PLACE_TIPS.radiusM` of one of their regulars that they
 *   have no visit at and were never tipped before.
 *
 * No model call: the line under the scene is a shared-i18n sentence. The
 * stored scene carries `proactive: true`, which is how the cadence is read
 * back — no table of its own.
 */
import { prisma, type Prisma } from "@gennety/db";
import { PLACE_TIPS, PLACE_TITLE_MAX_LEN, cityKeyToTimeZone, isQuietHourIn, isValidTimeZone, localHourIn, t, type Language } from "@gennety/shared";
import { CHAT_REPLY_PUSH_TYPE } from "./chat-reply-push.js";
import { NOT_ONLY_MY_DATES } from "./notification-mute.js";
import { PLACE_SCENE_KIND, cut, readPlaceScene, sceneVenue, type PlaceAnchor, type PlaceScene } from "./chat-place-scene.js";
import { touchChatSession } from "./chat-sessions.js";
import { loadRegulars, placeCatalogForCity, placeCityOf, placeClock, placeWalk, type PlaceCatalog, type PlaceFacts, type PlaceWalk, type RegularPlace } from "./place-catalog.js";
import { sendPushToUser } from "./push.js";

const DAY_MS = 86_400_000;

/** Their own zone when it is a real one, else their city's. */
function zoneOf(profile: { timeZone: string | null; homeCityKey: string | null } | null): string {
  const own = profile?.timeZone?.trim();
  return own && isValidTimeZone(own) ? own : cityKeyToTimeZone(profile?.homeCityKey ?? null);
}
/** A chat quiet longer than this gets the tip as a new chat, like a reminder. */
const CHAT_GAP_MS = 6 * 3600_000;

/** One earlier tip: when, whether the person wrote after it, which places it named. */
export interface PastTip {
  at: Date;
  answered: boolean;
  venueIds: string[];
}

export type TipGate =
  | { ok: true }
  | { ok: false; reason: "night" | "not_daytime" | "too_soon" | "ignored" };

/** Whether a tip may go now. Pure. `history` newest first. */
export function placeTipGate(input: { now: Date; timeZone: string; history: readonly PastTip[] }): TipGate {
  if (isQuietHourIn(input.now, input.timeZone)) return { ok: false, reason: "night" };
  const hour = localHourIn(input.now, input.timeZone);
  if (hour < PLACE_TIPS.dayFromHour || hour >= PLACE_TIPS.dayToHour) return { ok: false, reason: "not_daytime" };
  const last = input.history[0];
  if (last && input.now.getTime() - last.at.getTime() < PLACE_TIPS.everyDays * DAY_MS) return { ok: false, reason: "too_soon" };
  const recent = input.history.slice(0, PLACE_TIPS.ignoredInARow);
  if (
    last &&
    recent.length === PLACE_TIPS.ignoredInARow &&
    recent.every((tip) => !tip.answered) &&
    input.now.getTime() - last.at.getTime() < PLACE_TIPS.silenceDays * DAY_MS
  ) {
    return { ok: false, reason: "ignored" };
  }
  return { ok: true };
}

export interface TipPick {
  place: PlaceFacts;
  regular: RegularPlace;
  walk: PlaceWalk;
}

/**
 * The place to tip, or null. Pure. Within `PLACE_TIPS.radiusM` of a regular,
 * never one they visited or were tipped, never a regular itself, a place with
 * a photo and not known to be closed now; the best one by rating weighted by
 * its count, a place newer to the catalog first among equals, then the nearest.
 */
export function pickTipPlace(input: {
  catalog: PlaceCatalog;
  regulars: readonly RegularPlace[];
  visitedPlaceIds: ReadonlySet<string>;
  tippedVenueIds: ReadonlySet<string>;
  now: Date;
}): TipPick | null {
  const regularIds = new Set(input.regulars.map((r) => r.anchorId));
  let best: { pick: TipPick; quality: number } | null = null;
  for (const place of input.catalog.places) {
    if (!place.photoVenueId) continue;
    if (place.placeId && (regularIds.has(place.placeId) || input.visitedPlaceIds.has(place.placeId))) continue;
    if (place.ids.some((id) => input.tippedVenueIds.has(id))) continue;
    let near: { regular: RegularPlace; walk: PlaceWalk } | null = null;
    for (const regular of input.regulars) {
      const walk = placeWalk(regular, place);
      if (walk.distanceM <= PLACE_TIPS.radiusM && (!near || walk.distanceM < near.walk.distanceM)) near = { regular, walk };
    }
    if (!near || near.walk.walkMinutes == null) continue;
    if (placeClock(place.periods, place.utcOffsetMinutes, input.now, "en").openNow === false) continue;
    const fresh = input.now.getTime() - place.createdAt.getTime() < 30 * DAY_MS ? 0.3 : 0;
    const quality = (place.rating ?? 3.5) * Math.log10(10 + (place.ratingCount ?? 0)) + fresh - near.walk.distanceM / 10_000;
    if (!best || quality > best.quality || (quality === best.quality && place.id < best.pick.place.id)) {
      best = { pick: { place, regular: near.regular, walk: near.walk }, quality };
    }
  }
  return best?.pick ?? null;
}

/** The tip as a stored scene and the line above it. Pure. */
export function buildTip(pick: TipPick, regulars: readonly RegularPlace[], language: Language, now: Date): { scene: PlaceScene; line: string } {
  const venue = sceneVenue(pick.place, { language, now, walk: pick.walk });
  const minutes = pick.walk.walkMinutes ?? 1;
  const anchors: PlaceAnchor[] = regulars.map((r) => ({ label: r.name, lat: r.lat, lng: r.lng, visits: r.visits }));
  const scene: PlaceScene = {
    kind: PLACE_SCENE_KIND,
    sceneKind: "regulars",
    title: cut(t(language, "placeTipTitle"), PLACE_TITLE_MAX_LEN),
    subtitle: t(language, "placeFromAnchor", { minutes, place: pick.regular.name }),
    venues: [venue],
    anchors,
    dishes: [],
    links: pick.place.mapsUri ? [{ provider: "maps", label: t(language, "placeLinkMaps"), url: pick.place.mapsUri }] : [],
    versus: null,
    footnote: null,
    proactive: true,
  };
  const line = t(language, "placeTipLine", { venue: pick.place.name, minutes, anchor: pick.regular.name });
  return { scene, line };
}

/** Earlier tips of one person, newest first, with whether they wrote after each. */
async function pastTips(userId: string, now: Date): Promise<PastTip[]> {
  const rows = await prisma.message.findMany({
    where: {
      userId,
      role: "assistant",
      createdAt: { gte: new Date(now.getTime() - 365 * DAY_MS) },
      attachment: { path: ["proactive"], equals: true },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { createdAt: true, attachment: true },
  });
  const tips: PastTip[] = [];
  for (const row of rows) {
    const scene = readPlaceScene(row.attachment);
    if (!scene?.proactive) continue;
    tips.push({ at: row.createdAt, answered: false, venueIds: scene.venues.map((v) => v.id) });
  }
  // Answered = they wrote anything after it. Two reads at most: the cadence
  // only ever looks at the newest two.
  for (const tip of tips.slice(0, PLACE_TIPS.ignoredInARow)) {
    const after = await prisma.message.findFirst({ where: { userId, role: "user", createdAt: { gt: tip.at } }, select: { id: true } });
    tip.answered = after !== null;
  }
  return tips;
}

async function tipChatFor(userId: string, now: Date): Promise<string> {
  const recent = await prisma.chatSession.findFirst({
    where: { userId, archivedAt: null },
    orderBy: { updatedAt: "desc" },
    select: { id: true, updatedAt: true },
  });
  if (recent && now.getTime() - recent.updatedAt.getTime() < CHAT_GAP_MS) return recent.id;
  const created = await prisma.chatSession.create({ data: { userId }, select: { id: true } });
  return created.id;
}

export interface TipDeps {
  /** The preview list; null = everyone (the flag is on). */
  users: readonly string[] | null;
  push?: typeof sendPushToUser;
}

/**
 * One pass: every eligible person gets at most one tip. Returns how many went.
 * A person's failure costs that person's tip, never the pass.
 */
export async function sendPlaceTips(now: Date, deps: TipDeps): Promise<number> {
  if (deps.users !== null && deps.users.length === 0) return 0;
  const candidates = await prisma.user.findMany({
    where: {
      ...(deps.users ? { id: { in: [...deps.users] } } : {}),
      frequentPlacesOptIn: true,
      // «Только мои свидания» mutes the tip (`notification-mute.ts`, kind `place_tip`).
      ...NOT_ONLY_MY_DATES,
      status: { not: "banned" },
      platform: { in: ["mobile", "both"] },
      placeVisits: { some: { visitDay: { gte: new Date(now.getTime() - 60 * DAY_MS) } } },
    },
    take: PLACE_TIPS.batch,
    orderBy: { id: "asc" },
    select: { id: true, language: true, profile: { select: { homeCityKey: true, timeZone: true } } },
  });
  let sent = 0;
  for (const user of candidates) {
    try {
      if (await sendOneTip(user, now, deps)) sent++;
    } catch (err) {
      console.warn("[place-tips] tip failed:", err instanceof Error ? err.name : "error");
    }
  }
  return sent;
}

async function sendOneTip(
  user: { id: string; language: string | null; profile: { homeCityKey: string | null; timeZone: string | null } | null },
  now: Date,
  deps: TipDeps,
): Promise<boolean> {
  const zone = zoneOf(user.profile);
  const history = await pastTips(user.id, now);
  if (!placeTipGate({ now, timeZone: zone, history }).ok) return false;
  const catalog = await placeCatalogForCity(placeCityOf(user.profile?.homeCityKey), now.getTime());
  const regulars = await loadRegulars(user.id, catalog, now.getTime());
  if (!regulars || regulars.length === 0) return false;
  const visited = await prisma.userPlaceVisit.findMany({ where: { userId: user.id }, distinct: ["placeId"], select: { placeId: true } });
  const pick = pickTipPlace({
    catalog,
    regulars,
    visitedPlaceIds: new Set(visited.map((v) => v.placeId)),
    tippedVenueIds: new Set(history.flatMap((tip) => tip.venueIds)),
    now,
  });
  if (!pick) return false;
  const language = (user.language ?? "en") as Language;
  const { scene, line } = buildTip(pick, regulars, language, now);
  const sessionId = await tipChatFor(user.id, now);
  const message = await prisma.message.create({
    data: {
      userId: user.id,
      sessionId,
      role: "assistant",
      content: line,
      imageUrls: [],
      attachment: scene as unknown as Prisma.InputJsonValue,
    },
    select: { id: true, createdAt: true },
  });
  await touchChatSession(sessionId, message.createdAt).catch(() => undefined);
  await (deps.push ?? sendPushToUser)(user.id, {
    title: t(language, "placeTipTitle"),
    body: line,
    collapseId: `place.tip.${message.id}`,
    data: { type: CHAT_REPLY_PUSH_TYPE, sessionId },
  }).catch(() => false);
  return true;
}
