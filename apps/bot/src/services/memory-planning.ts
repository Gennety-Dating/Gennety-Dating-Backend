import { prisma, type Prisma } from "@gennety/db";
import { env } from "../config.js";
import {
  MEMORY_OVERLAP_MAX,
  MEMORY_OVERLAP_STATUSES,
  MEMORY_PLANNING_SUGGESTIONS,
  MEMORY_REMINDER_LEAD_MS,
  MEMORY_VIBE_QUESTION_MIN_IDEAS,
  mapVibeTagsToFacets,
  memoryIdeaFitsPlan,
  memoryVibeQuestion,
  preferenceVenueIds,
  isOverlapTopic,
  usableForOverlap,
  usableForOwnDates,
  type Language,
  type MemoryIntent,
  type MemoryRating,
  type MemoryVibeQuestion,
  type VenueAmbience,
  type VenueExperience,
  type VenueFormat,
  type MemoryReason,
} from "@gennety/shared";
import { getIdea, markPlanned, MemoryIdeaError, releasePlan, setIntent, type MemoryIdeaView } from "./memory-ideas.js";

/**
 * What ideas do outside the person's own list. Each function re-reads the grants
 * and the pair at call time, nothing is cached, so a revoked use or a new block
 * is gone from the very next answer. No function here books, pays, or moves a date.
 */

type IdeaRow = Prisma.MemoryIdeaGetPayload<object>;

function gate(row: IdeaRow) {
  return { ...row, intent: row.intent as MemoryIntent, reason: row.reason as MemoryReason | null };
}

/* ── places ─────────────────────────────────────────────────────────────── */

/** Place ids to nudge up on a venue board: a nudge inside a set both sides share. */
export async function wantedPlaceIds(userId: string): Promise<Set<string>> {
  const rows = await prisma.memoryIdea.findMany({ where: { userId, deletedAt: null, placeId: { not: null }, allowOwnDates: true } });
  return new Set(rows.filter((r) => usableForOwnDates(gate(r))).map((r) => r.placeId as string));
}

export interface MemoryMapItem {
  ideaId: string;
  title: string;
  placeId: string;
  lat: number;
  lng: number;
  intent: string;
}

/**
 * The person's own «хочу сюда» points, and the ideas without a point. A place is
 * shown only where the catalog knows it, and no coordinates are ever invented.
 */
export async function ideaMap(userId: string): Promise<{ points: MemoryMapItem[]; withoutPoint: Array<{ ideaId: string; title: string }> }> {
  const rows = await prisma.memoryIdea.findMany({
    where: { userId, deletedAt: null, kind: { in: ["place", "aesthetic", "food", "event", "activity"] }, intent: { not: "dropped" } },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });
  const ids = rows.flatMap((r) => (r.placeId ? [r.placeId] : []));
  const venues = ids.length
    ? await prisma.curatedVenue.findMany({ where: { placeId: { in: ids } }, select: { placeId: true, lat: true, lng: true } })
    : [];
  const pointOf = new Map(venues.flatMap((v) => (v.placeId && Number.isFinite(v.lat) && Number.isFinite(v.lng) ? [[v.placeId, v] as const] : [])));
  const points: MemoryMapItem[] = [];
  const withoutPoint: Array<{ ideaId: string; title: string }> = [];
  for (const row of rows) {
    const point = row.placeId ? pointOf.get(row.placeId) : undefined;
    if (point) points.push({ ideaId: row.id, title: row.title, placeId: row.placeId as string, lat: point.lat, lng: point.lng, intent: row.intent });
    else withoutPoint.push({ ideaId: row.id, title: row.title });
  }
  return { points, withoutPoint };
}

/** «Найди место с атмосферой, как у этих»: shared tags of real catalog places, in a city. Never the ones named. */
export async function similarPlaces(userId: string, ideaIds: readonly string[], cityKey: string | null): Promise<Array<{ placeId: string; name: string; sharedTags: string[] }>> {
  const ideas = await prisma.memoryIdea.findMany({ where: { userId, deletedAt: null, id: { in: [...ideaIds] }, placeId: { not: null } }, select: { placeId: true } });
  const named = ideas.map((i) => i.placeId as string);
  if (named.length === 0) return [];
  const sources = await prisma.curatedVenue.findMany({ where: { placeId: { in: named } }, select: { vibeTags: true } });
  const counts = new Map<string, number>();
  for (const source of sources) for (const tag of new Set(source.vibeTags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([tag]) => tag);
  if (tags.length === 0) return [];
  const rows = await prisma.curatedVenue.findMany({
    where: { active: true, vibeTags: { hasSome: tags }, placeId: { not: null, notIn: named }, ...(cityKey ? { cityKey } : {}) },
    select: { placeId: true, name: true, vibeTags: true },
    take: 60,
  });
  const seen = new Set<string>();
  return rows
    .flatMap((row) => {
      const placeId = row.placeId as string;
      if (seen.has(placeId)) return [];
      seen.add(placeId);
      return [{ placeId, name: row.name, sharedTags: row.vibeTags.filter((t) => tags.includes(t)) }];
    })
    .sort((a, b) => b.sharedTags.length - a.sharedTags.length)
    .slice(0, 5);
}

/* ── a pair ─────────────────────────────────────────────────────────────── */

interface PairContext {
  matchId: string;
  viewerId: string;
  partnerId: string;
  status: string;
  agreedTime: Date | null;
  /** The Date Ticket step is behind them (or tickets are off). */
  ticketDone: boolean;
  /** When the second «да» landed; ideas saved later never count for this pair. */
  mutualYesAt: Date;
}

/**
 * The paid step is over: both paid, or the offer lapsed and scheduling opened
 * for free (`refunded`, `expired`). `pending`/`partial` is the gate itself, also
 * before the offer is stamped; with tickets off there is no gate.
 */
const TICKET_DONE = new Set(["completed", "refunded", "expired"]);
function ticketStepDone(match: { status: string; ticketStatus: string }): boolean {
  if (!env.TICKET_FEATURE_ENABLED) return true;
  return match.status === "scheduled" || TICKET_DONE.has(match.ticketStatus);
}

/**
 * The moment both had said yes: the later of the two first ACCEPTED events. A
 * match without them (older rows) falls back to when it was sent, which is
 * earlier still, so the cut only ever leaves out more.
 */
async function mutualYesAt(match: { id: string; userAId: string; userBId: string; dispatchedAt: Date | null; createdAt: Date }): Promise<Date> {
  const accepted = await prisma.matchEvent.findMany({
    where: { matchId: match.id, actionType: "ACCEPTED", actorId: { in: [match.userAId, match.userBId] } },
    orderBy: { createdAt: "asc" },
    select: { actorId: true, createdAt: true },
  });
  const a = accepted.find((e) => e.actorId === match.userAId)?.createdAt;
  const b = accepted.find((e) => e.actorId === match.userBId)?.createdAt;
  if (a && b) return a > b ? a : b;
  return match.dispatchedAt ?? match.createdAt;
}

async function readPair(matchId: string, viewerId: string): Promise<PairContext> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, userAId: true, userBId: true, status: true, agreedTime: true, ticketStatus: true, dispatchedAt: true, createdAt: true },
  });
  if (!match || (match.userAId !== viewerId && match.userBId !== viewerId)) throw new MemoryIdeaError("not-found", 404);
  return {
    matchId: match.id,
    viewerId,
    partnerId: match.userAId === viewerId ? match.userBId : match.userAId,
    status: match.status,
    agreedTime: match.agreedTime,
    ticketDone: ticketStepDone(match),
    mutualYesAt: await mutualYesAt(match),
  };
}

async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  const found = await prisma.userBlock.findFirst({
    where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
    select: { id: true },
  });
  return found !== null;
}

export interface PairOverlap {
  /** The viewer's own title, so the partner's words are never the ones shown. */
  label: string;
  kind: "same_place" | "same_kind";
  ideaId: string;
}

/**
 * Ideas both sides allowed for their dates, compared on the server. Only the
 * viewer's own idea comes back, and an empty list reads the same for every
 * reason: too early, the ticket not done, a block, a private idea or nothing shared.
 *
 * Against probing (audit F-03, decision 2026-11-03): only ideas saved before both
 * said yes take part, a topic only from `MEMORY_OVERLAP_TOPICS` and a place only
 * if the catalog knows it. A new idea made to test the partner's never counts.
 */
export async function pairOverlap(matchId: string, viewerId: string): Promise<PairOverlap[]> {
  const pair = await readPair(matchId, viewerId);
  return overlapOf(pair);
}

async function overlapOf(pair: PairContext): Promise<PairOverlap[]> {
  if (!MEMORY_OVERLAP_STATUSES.has(pair.status) || !pair.ticketDone) return [];
  if (await isBlockedEitherWay(pair.viewerId, pair.partnerId)) return [];
  const load = (userId: string) =>
    prisma.memoryIdea.findMany({ where: { userId, deletedAt: null, allowOwnDates: true, createdAt: { lt: pair.mutualYesAt } }, take: 500 });
  const [mineRaw, theirsRaw] = await Promise.all([load(pair.viewerId), load(pair.partnerId)]);
  const mine = mineRaw.filter((r) => usableForOverlap(gate(r)));
  const theirs = theirsRaw.filter((r) => usableForOverlap(gate(r)));
  const placeIds = [...new Set([...mine, ...theirs].flatMap((r) => (r.placeId ? [r.placeId] : [])))];
  const catalog = placeIds.length
    ? new Set((await prisma.curatedVenue.findMany({ where: { placeId: { in: placeIds } }, select: { placeId: true } })).map((v) => v.placeId as string))
    : new Set<string>();
  const placeOf = (r: IdeaRow) => (r.placeId && catalog.has(r.placeId) ? r.placeId : null);
  const topicOf = (r: IdeaRow) => (isOverlapTopic(r.topic) ? r.topic : null);
  const theirPlaces = new Set(theirs.flatMap((r) => { const p = placeOf(r); return p ? [p] : []; }));
  const theirTopics = new Set(theirs.flatMap((r) => { const t = topicOf(r); return t ? [t] : []; }));
  const out: PairOverlap[] = [];
  for (const row of mine) {
    const place = placeOf(row);
    const topic = topicOf(row);
    if (place && theirPlaces.has(place)) out.push({ label: row.title, kind: "same_place", ideaId: row.id });
    else if (topic && theirTopics.has(topic)) out.push({ label: row.title, kind: "same_kind", ideaId: row.id });
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "same_place" ? -1 : 1)).slice(0, MEMORY_OVERLAP_MAX);
}

export interface PlanningSuggestion {
  ideaId: string;
  title: string;
  kind: string;
  placeId: string | null;
  /** As saved, in any language, so nothing here treats a spelling as a known mismatch. */
  city: string | null;
  /** The person's own reason, for the sentence the app builds. */
  reason: string | null;
  /** The date is not confirmed. The app says so; it never claims it is on. */
  needsCheck: boolean;
}

/** Their allowed wishes that can fit this plan. A mismatch on anything known drops it. */
export async function planningSuggestions(
  matchId: string,
  viewerId: string,
  options: { city: string | null; now?: Date },
): Promise<{ suggestions: PlanningSuggestion[]; shared: PairOverlap[]; vibe: string[]; vibeIds: { experiences: VenueExperience[]; ambiences: VenueAmbience[] } }> {
  const pair = await readPair(matchId, viewerId);
  const now = options.now ?? new Date();
  // Both said yes and the ticket step is done (decision 2026-11-03); before that
  // the answer is empty and looks the same as having nothing.
  const live = MEMORY_OVERLAP_STATUSES.has(pair.status) && pair.ticketDone;
  if (!live) return { suggestions: [], shared: [], vibe: [], vibeIds: { experiences: [], ambiences: [] } };
  const [rows, shared, preferences] = await Promise.all([
    prisma.memoryIdea.findMany({ where: { userId: viewerId, deletedAt: null, allowOwnDates: true }, orderBy: { updatedAt: "desc" }, take: 200 }),
    overlapOf(pair),
    prisma.memoryPreference.findMany({ where: { userId: viewerId, revokedAt: null, allowOwnDates: true, facet: { in: ["experience", "ambience", "format", "wish"] } }, take: 8, orderBy: { confirmedAt: "desc" }, select: { facet: true, value: true } }),
  ]);
  const vibeIds = preferenceVenueIds(preferences);
  const fitting = rows
    .filter((r) => usableForOwnDates(gate(r)))
    .filter((r) => memoryIdeaFitsPlan(r, { city: options.city, at: pair.agreedTime, now }));
  const ordered = await byConfirmedVibe(fitting, vibeIds);
  const suggestions = ordered
    .slice(0, MEMORY_PLANNING_SUGGESTIONS)
    .map((r) => ({
      ideaId: r.id,
      title: r.title,
      kind: r.kind,
      placeId: r.placeId,
      city: r.city,
      reason: r.reason,
      // An event with no date to its name is as unchecked as one with a wrong date.
      needsCheck: (r.eventAt !== null || r.kind === "event") && r.eventCheck !== "confirmed",
    }));
  return { suggestions, shared, vibe: preferences.map((p) => p.value), vibeIds };
}

/** What they said they like comes first. An order only: nothing is added or dropped. */
async function byConfirmedVibe(rows: IdeaRow[], vibe: { experiences: VenueExperience[]; ambiences: VenueAmbience[] }): Promise<IdeaRow[]> {
  if (vibe.experiences.length + vibe.ambiences.length === 0) return rows;
  const placeIds = rows.flatMap((r) => (r.placeId ? [r.placeId] : []));
  if (placeIds.length === 0) return rows;
  const venues = await prisma.curatedVenue.findMany({ where: { placeId: { in: placeIds } }, select: { placeId: true, vibeTags: true } });
  const score = new Map(venues.map((venue) => {
    const facets = mapVibeTagsToFacets(venue.vibeTags);
    const hits = facets.experiences.filter((id) => vibe.experiences.includes(id)).length + facets.ambiences.filter((id) => vibe.ambiences.includes(id)).length;
    return [venue.placeId, hits] as const;
  }));
  const of = (row: IdeaRow) => (row.placeId ? (score.get(row.placeId) ?? 0) : 0);
  return rows.map((row, index) => ({ row, index })).sort((a, b) => of(b.row) - of(a.row) || a.index - b.index).map(({ row }) => row);
}

/** The pair a chat means by «наше свидание»: a booked date first, then the one being arranged. */
export async function currentPairMatchId(userId: string): Promise<string | null> {
  const matches = await prisma.match.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }], status: { in: [...MEMORY_OVERLAP_STATUSES] as Array<"negotiating" | "negotiating_venue" | "scheduled"> } },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: { id: true, status: true },
  });
  return (matches.find((m) => m.status === "scheduled") ?? matches[0])?.id ?? null;
}

export type IntentSuggestion = { experiences: VenueExperience[]; ambiences: VenueAmbience[]; formats: VenueFormat[] };

/**
 * First-screen chips for a venue intent, with what the person confirmed first. Only
 * suggestions: the intent is still theirs to confirm, and hard constraints and the
 * final selection read none of this.
 */
export async function suggestionsWithPreferences(userId: string, suggestions: IntentSuggestion[]): Promise<IntentSuggestion[]> {
  const rows = await prisma.memoryPreference.findMany({
    where: { userId, revokedAt: null, allowOwnDates: true, facet: { in: ["experience", "ambience", "format"] } },
    orderBy: { confirmedAt: "desc" },
    take: 12,
    select: { facet: true, value: true },
  });
  const vibe = preferenceVenueIds(rows);
  if (vibe.experiences.length + vibe.ambiences.length === 0) return suggestions;
  const hits = (s: IntentSuggestion) => s.experiences.filter((id) => vibe.experiences.includes(id)).length + s.ambiences.filter((id) => vibe.ambiences.includes(id)).length;
  const ordered = suggestions.map((s, index) => ({ s, index })).sort((a, b) => hits(b.s) - hits(a.s) || a.index - b.index).map(({ s }) => s);
  // A chip needs an experience to stand on; an ambience alone has reordered above.
  if (vibe.experiences.length === 0 || (ordered[0] && hits(ordered[0]) > 0)) return ordered;
  return [{ experiences: vibe.experiences.slice(0, 3), ambiences: vibe.ambiences.slice(0, 3), formats: [] }, ...ordered].slice(0, 3);
}

/**
 * «Что тебе ближе» once there are a few moods or activities saved and the person
 * has not said. Same input, same question. The answer is a plain confirmed
 * preference; using it in matching stays a separate grant.
 */
export async function vibeQuestion(userId: string, language: Language): Promise<MemoryVibeQuestion | null> {
  const rows = await prisma.memoryIdea.findMany({
    where: { userId, deletedAt: null, kind: { in: ["aesthetic", "activity"] }, intent: { not: "dropped" }, OR: [{ reason: null }, { reason: { notIn: ["gift", "reference"] } }] },
    select: { kind: true },
    take: 200,
  });
  if (rows.length < MEMORY_VIBE_QUESTION_MIN_IDEAS) return null;
  const answered = await prisma.memoryPreference.findMany({ where: { userId, revokedAt: null, facet: { in: ["ambience", "experience"] } }, select: { facet: true } });
  const said = new Set(answered.map((a) => a.facet));
  const aesthetic = rows.filter((r) => r.kind === "aesthetic").length;
  const first: "ambience" | "experience" = aesthetic * 2 >= rows.length ? "ambience" : "experience";
  const second: "ambience" | "experience" = first === "ambience" ? "experience" : "ambience";
  const facet = [first, second].find((f) => !said.has(f));
  return facet ? memoryVibeQuestion(facet, language) : null;
}

/**
 * The owner's own note for a date: what they wanted from this place. Never for
 * the partner, and carrying nothing about weather, dress code or opening hours.
 */
export async function dateMemo(matchId: string, viewerId: string): Promise<{ ideas: MemoryIdeaView[]; references: MemoryIdeaView[] }> {
  await readPair(matchId, viewerId);
  const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId }, select: { venuePlaceId: true } });
  const rows = await prisma.memoryIdea.findMany({
    where: {
      userId: viewerId,
      deletedAt: null,
      OR: [{ plannedMatchId: matchId }, ...(match.venuePlaceId ? [{ placeId: match.venuePlaceId }] : []), { kind: "outfit", reason: "style" }],
    },
    select: { id: true, kind: true },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  const views = await Promise.all(rows.map(async (r) => ({ kind: r.kind, view: await getIdea(viewerId, r.id) })));
  return {
    ideas: views.filter((v) => v.kind !== "outfit").map((v) => v.view),
    references: views.filter((v) => v.kind === "outfit").map((v) => v.view),
  };
}

/** For Style Picks: references the person chose. Words only, and no one's body in them. */
export async function styleReferenceTexts(userId: string): Promise<string[]> {
  const rows = await prisma.memoryIdea.findMany({
    where: { userId, deletedAt: null, kind: "outfit", reason: "style", intent: { not: "dropped" } },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: { title: true, note: true },
  });
  return rows.map((r) => (r.note ? `${r.title}: ${r.note}` : r.title));
}

/* ── after a date ───────────────────────────────────────────────────────── */

async function attendedSide(matchId: string, viewerId: string): Promise<boolean> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: { userAId: true, userBId: true, dateAttendedA: true, dateAttendedB: true } });
  if (!match || (match.userAId !== viewerId && match.userBId !== viewerId)) throw new MemoryIdeaError("not-found", 404);
  return (match.userAId === viewerId ? match.dateAttendedA : match.dateAttendedB) === true;
}

export interface ImpressionInput {
  placeRating?: MemoryRating | null;
  formatRating?: MemoryRating | null;
  repeatFormat?: boolean | null;
  note?: string | null;
  skipped?: boolean;
}

/**
 * One person's view of the place and the format, only after they confirmed they
 * went. It says nothing about the partner and nobody else reads it. A later
 * answer corrects it. `tried` is written only here, from a confirmed visit.
 */
export async function recordImpression(matchId: string, viewerId: string, input: ImpressionInput): Promise<void> {
  if (!(await attendedSide(matchId, viewerId))) throw new MemoryIdeaError("not-attended", 409);
  const idea = await prisma.memoryIdea.findFirst({ where: { userId: viewerId, plannedMatchId: matchId, deletedAt: null }, select: { id: true } });
  const data = {
    placeRating: input.skipped ? null : (input.placeRating ?? null),
    formatRating: input.skipped ? null : (input.formatRating ?? null),
    repeatFormat: input.skipped ? null : (input.repeatFormat ?? null),
    note: input.skipped ? null : (input.note?.trim().slice(0, 300) || null),
    skipped: input.skipped === true,
    ideaId: idea?.id ?? null,
  };
  await prisma.memoryImpression.upsert({
    where: { userId_matchId: { userId: viewerId, matchId } },
    create: { userId: viewerId, matchId, ...data },
    update: data,
  });
  if (idea) await setIntent(viewerId, idea.id, "tried", { actor: "system", idempotencyKey: `tried:${idea.id}:${matchId}` });
}

/** The date a chat means by «вчера было»: their latest one they confirmed going to. */
export async function latestAttendedMatch(viewerId: string): Promise<{ matchId: string; venueName: string | null } | null> {
  const match = await prisma.match.findFirst({
    where: { OR: [{ userAId: viewerId, dateAttendedA: true }, { userBId: viewerId, dateAttendedB: true }] },
    orderBy: { agreedTime: "desc" },
    select: { id: true, venueName: true },
  });
  return match ? { matchId: match.id, venueName: match.venueName } : null;
}

/** What they allowed and have not tried: the honest answer to «а что дальше». */
export async function nextAllowedIdeas(userId: string, limit = 2): Promise<Array<{ ideaId: string; title: string; kind: string }>> {
  const rows = await prisma.memoryIdea.findMany({ where: { userId, deletedAt: null, allowOwnDates: true, plannedMatchId: null }, orderBy: { updatedAt: "desc" }, take: 50 });
  return rows.filter((r) => usableForOwnDates(gate(r))).slice(0, limit).map((r) => ({ ideaId: r.id, title: r.title, kind: r.kind }));
}

/** Attended dates this person has not spoken about. Skipping counts as speaking. */
export async function pendingImpressions(viewerId: string, limit = 3): Promise<Array<{ matchId: string; venueName: string | null; ideaId: string | null }>> {
  const matches = await prisma.match.findMany({
    where: { OR: [{ userAId: viewerId, dateAttendedA: true }, { userBId: viewerId, dateAttendedB: true }] },
    orderBy: { agreedTime: "desc" },
    take: 20,
    select: { id: true, venueName: true },
  });
  if (matches.length === 0) return [];
  const [done, planned] = await Promise.all([
    prisma.memoryImpression.findMany({ where: { userId: viewerId, matchId: { in: matches.map((m) => m.id) } }, select: { matchId: true } }),
    prisma.memoryIdea.findMany({ where: { userId: viewerId, deletedAt: null, plannedMatchId: { in: matches.map((m) => m.id) } }, select: { id: true, plannedMatchId: true } }),
  ]);
  const answered = new Set(done.map((d) => d.matchId));
  const ideaOf = new Map(planned.map((p) => [p.plannedMatchId, p.id]));
  return matches.filter((m) => !answered.has(m.id) && ideaOf.has(m.id)).slice(0, limit).map((m) => ({ matchId: m.id, venueName: m.venueName, ideaId: ideaOf.get(m.id) ?? null }));
}

/* ── keeping plans and reminders true ───────────────────────────────────── */

/**
 * Ties ideas to real dates from the matches themselves, so no scheduling path
 * has to know about them. Keys make every step safe to repeat.
 */
export async function reconcilePlans(now: Date = new Date(), limit = 200, users: readonly string[] | null = null): Promise<{ planned: number; released: number }> {
  let planned = 0;
  let released = 0;
  const scheduled = await prisma.match.findMany({
    where: { status: "scheduled", venuePlaceId: { not: null }, agreedTime: { gt: now } },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { id: true, userAId: true, userBId: true, venuePlaceId: true },
  });
  // One read for every booked date instead of one per date (audit F-07: 203
  // statements a minute with 200 dates).
  const candidates = scheduled.length
    ? await prisma.memoryIdea.findMany({
        where: {
          // Planning writes to the idea, so only people the feature is on for
          // (`users`: a preview list, null for everyone). Releasing below is not limited.
          userId: { in: [...new Set(scheduled.flatMap((m) => [m.userAId, m.userBId]))].filter((id) => !users || users.includes(id)) },
          placeId: { in: [...new Set(scheduled.map((m) => m.venuePlaceId as string))] },
          deletedAt: null,
          allowOwnDates: true,
          plannedMatchId: null,
          intent: { in: ["interested", "want"] },
        },
      })
    : [];
  for (const match of scheduled) {
    const ideas = candidates.filter((r) => r.placeId === match.venuePlaceId && (r.userId === match.userAId || r.userId === match.userBId));
    for (const idea of ideas.filter((r) => usableForOwnDates(gate(r)))) {
      await markPlanned(idea.userId, idea.id, match.id);
      planned++;
    }
  }
  // Only plans that need releasing are read. Reading every planned idea and
  // filtering here let finished dates fill the page, so a cancelled date past
  // the first `limit` rows never gave its wish back (audit F-07).
  const stale = await prisma.$queryRaw<Array<{ user_id: string; planned_match_id: string }>>`
    SELECT DISTINCT i.user_id, i.planned_match_id
    FROM memory_ideas i
    LEFT JOIN matches m ON m.id = i.planned_match_id
    WHERE i.planned_match_id IS NOT NULL AND i.deleted_at IS NULL
      AND (
        m.id IS NULL
        OR m.status::text IN ('cancelled', 'expired')
        -- A booked date whose place moved is no longer this idea's plan.
        OR (m.status::text = 'scheduled' AND m.venue_place_id IS NOT NULL AND i.place_id IS NOT NULL AND m.venue_place_id <> i.place_id)
      )
    LIMIT ${limit}
  `;
  for (const row of stale) released += await releasePlan(row.user_id, row.planned_match_id);
  return { planned, released };
}

/** «Напомнить вовремя». One live reminder per occasion; a date without an event is refused, not guessed. */
export interface ReminderSet {
  dueAt: string;
  /** The idea as it now stands, with `usage.ownDates` and `reminder`. */
  idea: MemoryIdeaView;
  /** This request also turned on the use for their own dates. */
  ownDatesTurnedOn: boolean;
}

type ReminderDb = Pick<typeof prisma, "memoryReminder">;

/** One live reminder for the idea's current date; repeats and old dates are folded in. */
async function writeReminder(db: ReminderDb, userId: string, idea: { id: string; eventAt: Date }, now: Date): Promise<Date> {
  const dueAt = new Date(Math.max(idea.eventAt.getTime() - MEMORY_REMINDER_LEAD_MS, now.getTime()));
  const dedupeKey = `event:${idea.id}:${idea.eventAt.toISOString()}`;
  await db.memoryReminder.upsert({
    where: { userId_dedupeKey: { userId, dedupeKey } },
    create: { ideaId: idea.id, userId, dueAt, dedupeKey },
    update: {},
  });
  // Asked again after cancelling: it really is back on. One already sent stays sent.
  await db.memoryReminder.updateMany({ where: { userId, dedupeKey, state: "cancelled" }, data: { state: "pending", dueAt } });
  await db.memoryReminder.updateMany({ where: { ideaId: idea.id, state: "pending", dedupeKey: { not: dedupeKey } }, data: { state: "cancelled" } });
  return dueAt;
}

/**
 * «Напомнить вовремя». A reminder is only sent for an idea usable for the
 * person's own dates, so turning one on also turns that use on, in the same
 * transaction (decision 2026-11-03, replacing the 409 of audit F-02). An idea
 * that cannot be such a wish is refused: a gift or a reference (`not-own-wish`),
 * a dropped or tried one (`idea-closed`). A date without an event is refused, not guessed.
 */
export async function setReminder(userId: string, ideaId: string, now: Date = new Date()): Promise<ReminderSet> {
  const { dueAt, turnedOn } = await prisma.$transaction(async (tx) => {
    const idea = await tx.memoryIdea.findFirst({ where: { id: ideaId, userId, deletedAt: null } });
    if (!idea) throw new MemoryIdeaError("not-found", 404);
    if (idea.reason === "gift" || idea.reason === "reference") throw new MemoryIdeaError("not-own-wish", 409);
    if (idea.intent === "dropped" || idea.intent === "tried") throw new MemoryIdeaError("idea-closed", 409);
    if (!idea.eventAt) throw new MemoryIdeaError("no-date", 409);
    if (idea.eventCheck === "outdated" || idea.eventAt <= now) throw new MemoryIdeaError("date-passed", 409);
    let turnedOn = false;
    if (!idea.allowOwnDates) {
      const updated = await tx.memoryIdea.updateMany({
        where: { id: ideaId, userId, deletedAt: null, version: idea.version },
        data: { allowOwnDates: true, version: { increment: 1 } },
      });
      if (updated.count === 0) throw new MemoryIdeaError("version-conflict", 409);
      await tx.memoryIdeaEvent.create({
        data: { ideaId, userId, actor: "person", type: "usage", payload: { use: "own_dates", allow: true, via: "reminder" } },
      });
      turnedOn = true;
    }
    return { dueAt: await writeReminder(tx, userId, { id: idea.id, eventAt: idea.eventAt }, now), turnedOn };
  });
  return { dueAt: dueAt.toISOString(), idea: await getIdea(userId, ideaId), ownDatesTurnedOn: turnedOn };
}

export async function cancelReminder(userId: string, ideaId: string): Promise<void> {
  await prisma.memoryReminder.updateMany({ where: { ideaId, userId, state: "pending" }, data: { state: "cancelled" } });
}

/**
 * A moved or cancelled event. The old reminder ends with the old date, and a new
 * one is only set by the person asking again or by an existing reminder moving.
 */
export async function setEventDate(userId: string, ideaId: string, eventAt: Date | null, timezone: string | null, check: "unverified" | "confirmed" | "outdated" | "unknown", now: Date = new Date()): Promise<void> {
  const before = await prisma.memoryIdea.findFirst({ where: { id: ideaId, userId, deletedAt: null }, select: { eventAt: true } });
  if (!before) throw new MemoryIdeaError("not-found", 404);
  const hadReminder = await prisma.memoryReminder.count({ where: { ideaId, userId, state: "pending" } });
  const updated = await prisma.memoryIdea.updateMany({
    where: { id: ideaId, userId, deletedAt: null },
    data: { eventAt, eventTimezone: timezone, eventCheck: check, eventCheckedAt: now, version: { increment: 1 } },
  });
  if (updated.count === 0) throw new MemoryIdeaError("not-found", 404);
  await prisma.memoryIdeaEvent.create({ data: { ideaId, userId, actor: "system", type: "event_check", payload: { check, at: eventAt?.toISOString() ?? null } } });
  // The same date checked again keeps its reminder: cancelling it here would end it
  // for good, as a repeat of the same occasion must not send twice.
  const sameDate = before.eventAt?.getTime() === eventAt?.getTime();
  if (sameDate && check !== "outdated") return;
  await cancelReminder(userId, ideaId);
  if (hadReminder > 0 && eventAt && eventAt > now && check !== "outdated") {
    // The reminder moves with its date; a wish closed meanwhile keeps none, and
    // moving one never grants a use by itself.
    const after = await prisma.memoryIdea.findFirst({ where: { id: ideaId, userId, deletedAt: null } });
    if (after && usableForOwnDates(gate(after))) await writeReminder(prisma, userId, { id: ideaId, eventAt }, now);
  }
}

/**
 * What a web check says about a saved idea. Only the search's verdict lands here,
 * never the screenshot's own words. A limit or an outage says nothing, so it leaves
 * the last known state. A run of several days stays `unknown` with no date, since
 * one date would rule out the other days; its check is asked again next time.
 */
export async function applyEventCheck(
  userId: string,
  ideaId: string,
  result: { status: "confirmed" | "outdated" | "unverified"; reason: string; startDate?: string; endDate?: string },
  now: Date = new Date(),
): Promise<string | null> {
  if (result.status === "unverified" && result.reason !== "no_source") return null;
  const idea = await prisma.memoryIdea.findFirst({ where: { id: ideaId, userId, deletedAt: null }, select: { eventAt: true, eventTimezone: true } });
  if (!idea) return null;
  if (result.status === "confirmed") {
    if (result.endDate && result.endDate !== result.startDate) {
      await setEventDate(userId, ideaId, null, null, "unknown", now);
      return "unknown";
    }
    const day = result.startDate ?? result.endDate;
    if (!day) return null;
    const keep = idea.eventAt?.toISOString().slice(0, 10) === day;
    await setEventDate(userId, ideaId, keep ? idea.eventAt : new Date(`${day}T12:00:00.000Z`), keep ? idea.eventTimezone : null, "confirmed", now);
    return "confirmed";
  }
  const check = result.status === "outdated" ? "outdated" : "unknown";
  await setEventDate(userId, ideaId, idea.eventAt, idea.eventTimezone, check, now);
  return check;
}
