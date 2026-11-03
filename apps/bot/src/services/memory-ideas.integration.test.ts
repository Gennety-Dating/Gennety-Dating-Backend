import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@gennety/db";
import { usableForOwnDates } from "@gennety/shared";
import { sendDueReminders, sweepOrphanSources } from "../workers/memory-ideas.js";
import {
  dateMemo,
  ideaMap,
  pairOverlap,
  pendingImpressions,
  planningSuggestions,
  reconcilePlans,
  recordImpression,
  setEventDate,
  setReminder,
  styleReferenceTexts,
  wantedPlaceIds,
} from "./memory-planning.js";
import { personalizeOrder } from "./venue-change-personalization.js";
import { executeMemoryTool } from "./chat-memory.js";
import { deleteItem, disconnectLibrary } from "./screenshot-library.js";
import {
  confirmPreference,
  deleteIdea,
  deletionScope,
  getIdea,
  listIdeas,
  markPlanned,
  mergeIdeas,
  MemoryIdeaError,
  reasonQuestions,
  releasePlan,
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
} from "./memory-ideas.js";

/** Uniqueness and transactions are the thing being tested, so a real database it is. */

async function newUser(): Promise<string> {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (id, telegram_id, created_at, updated_at) VALUES ('${id}'::uuid, ${Math.floor(Math.random() * 1e12)}, NOW(), NOW())`,
  );
  return id;
}

async function newShot(userId: string): Promise<string> {
  const id = randomUUID();
  await prisma.screenshotItem.create({
    data: { id, userId, generation: 1, source: "manual", sourceKey: `k-${id}`, contentHash: id.replace(/-/g, "") + "0000", storagePath: `${userId}/${id}`, state: "ready", title: "shot" },
  });
  return id;
}

const person = (quote: string) => ({ kind: "chat" as const, provenance: "person" as const, quote });

describe("ideas on a real database", () => {
  let user: string;
  beforeAll(async () => {
    await prisma.$connect();
  });

  it("joins a screenshot, a link and words on one place, each kept as a source", async () => {
    user = await newUser();
    const shot = await newShot(user);
    const first = await saveIdea(user, { kind: "place", title: "Roof", placeId: "gp1", city: "Kyiv", source: { kind: "screenshot", provenance: "model", screenshotItemId: shot } });
    const second = await saveIdea(user, { kind: "place", title: "Roof bar", placeId: "gp1", source: { kind: "link", provenance: "person", url: "https://roof.example/?utm_source=x" } });
    const third = await saveIdea(user, { kind: "place", title: "Roof", placeId: "gp1", source: person("Хочу в этот ресторан") });
    expect(first.created).toBe(true);
    expect(second.idea.id).toBe(first.idea.id);
    expect(third.idea.sources.map((s) => s.kind)).toEqual(["screenshot", "link", "chat"]);

    // Removing one source leaves the idea and the others.
    await removeSource(user, first.idea.id, third.idea.sources[2]!.id);
    expect((await getIdea(user, first.idea.id)).sources).toHaveLength(2);
    // Repeating a known source changes nothing.
    const again = await saveIdea(user, { kind: "place", title: "Roof", source: { kind: "screenshot", provenance: "model", screenshotItemId: shot } });
    expect(again.created).toBe(false);
    expect(again.idea.sources).toHaveLength(2);
  });

  it("keeps the same name in two cities apart, and asks about the same name in one city", async () => {
    const u = await newUser();
    const kyiv = await saveIdea(u, { kind: "place", title: "Роза", city: "Kyiv", source: person("хочу в Розу в Киеве") });
    const lviv = await saveIdea(u, { kind: "place", title: "Роза", city: "Lviv", source: person("хочу в Розу во Львове") });
    expect(lviv.idea.id).not.toBe(kyiv.idea.id);
    expect(lviv.candidates).toEqual([]);
    const second = await saveIdea(u, { kind: "place", title: "РОЗА!", city: "kyiv", source: person("та самая Роза") });
    expect(second.created).toBe(true);
    expect(second.candidates.map((c) => c.id)).toEqual([kyiv.idea.id]);
  });

  it("a wrong join can be undone without losing sources, and the split gets no grants", async () => {
    const u = await newUser();
    const a = await saveIdea(u, { kind: "outfit", title: "Black coat", source: person("чёрное пальто") });
    await setUsage(u, a.idea.id, "own_dates", true);
    const b = await saveIdea(u, { kind: "outfit", title: "Grey coat", source: person("серое пальто") });
    const merged = await mergeIdeas(u, a.idea.id, b.idea.id);
    expect(merged.sources).toHaveLength(2);
    const { kept, split } = await splitIdea(u, a.idea.id, [merged.sources[1]!.id], "Grey coat");
    expect(kept.sources).toHaveLength(1);
    expect(split.sources[0]!.quote).toBe("серое пальто");
    expect(split.usage.onlyForMe).toBe(true);
  });

  it("«это подарок сестре» leaves own dates and stays in personal search", async () => {
    const u = await newUser();
    const gift = await saveIdea(u, { kind: "gift", title: "Шарф", source: person("этот шарф") });
    await setUsage(u, gift.idea.id, "own_dates", true);
    const view = await setReason(u, gift.idea.id, "gift", "сестра");
    expect(view.usage.onlyForMe).toBe(true);
    const row = await prisma.memoryIdea.findUniqueOrThrow({ where: { id: gift.idea.id } });
    expect(usableForOwnDates({ ...row, intent: row.intent as "want", reason: "gift" })).toBe(false);
    expect((await listIdeas(u, { query: "сестра" })).items.map((i) => i.id)).toEqual([gift.idea.id]);
    await expect(setUsage(u, gift.idea.id, "own_dates", true)).rejects.toMatchObject({ code: "not-own-wish" });
  });

  it("the system cannot widen a use, and a foreign id acts on nothing", async () => {
    const u = await newUser();
    const other = await newUser();
    const idea = await saveIdea(u, { kind: "place", title: "Bar", source: person("бар") });
    await expect(setUsage(u, idea.idea.id, "matching", true, { actor: "system" })).rejects.toMatchObject({ code: "needs-the-person" });
    await expect(setUsage(other, idea.idea.id, "own_dates", true)).rejects.toBeInstanceOf(MemoryIdeaError);
    const answer = JSON.parse(await executeMemoryTool(other, "delete_idea", { id: idea.idea.id })) as { success: boolean };
    expect(answer.success).toBe(false);
    expect((await getIdea(u, idea.idea.id)).id).toBe(idea.idea.id);
  });

  it("a repeated event changes nothing, and a stale version is refused", async () => {
    const u = await newUser();
    const idea = await saveIdea(u, { kind: "activity", title: "Керамика", source: person("керамика") });
    const one = await setIntent(u, idea.idea.id, "want", { idempotencyKey: "tap-1" });
    const two = await setIntent(u, idea.idea.id, "dropped", { idempotencyKey: "tap-1" });
    expect(two.intent).toBe("want");
    expect(two.version).toBe(one.version);
    await expect(setIntent(u, idea.idea.id, "tried", { expectedVersion: 1 })).rejects.toMatchObject({ code: "version-conflict" });
    expect(await prisma.memoryIdeaEvent.count({ where: { ideaId: idea.idea.id, type: "intent" } })).toBe(1);
  });

  it("a cancelled plan returns the wish; a closed wish stays closed", async () => {
    const u = await newUser();
    const match = randomUUID();
    const idea = await saveIdea(u, { kind: "place", title: "Sad", intent: "want", source: person("сад") });
    await markPlanned(u, idea.idea.id, match);
    await markPlanned(u, idea.idea.id, match);
    expect((await getIdea(u, idea.idea.id)).intent).toBe("planned");
    await releasePlan(u, match);
    expect((await getIdea(u, idea.idea.id)).intent).toBe("want");

    const match2 = randomUUID();
    await markPlanned(u, idea.idea.id, match2);
    await setIntent(u, idea.idea.id, "dropped");
    await releasePlan(u, match2);
    expect((await getIdea(u, idea.idea.id)).intent).toBe("dropped");
  });

  it("an idea only screenshots supported closes with them; words keep the other alive", async () => {
    const u = await newUser();
    await prisma.screenshotLibrary.create({ data: { userId: u, status: "active", generation: 1 } });
    const lone = await newShot(u);
    const shared = await newShot(u);
    const a = await saveIdea(u, { kind: "place", title: "Only shot", source: { kind: "screenshot", provenance: "model", screenshotItemId: lone } });
    const b = await saveIdea(u, { kind: "place", title: "Both", placeId: "gp2", source: { kind: "screenshot", provenance: "model", screenshotItemId: shared } });
    await saveIdea(u, { kind: "place", title: "Both", placeId: "gp2", source: person("хочу туда") });
    await setUsage(u, a.idea.id, "own_dates", true);
    await deleteItem(u, lone);
    await expect(getIdea(u, a.idea.id)).rejects.toMatchObject({ code: "not-found" });
    const row = await prisma.memoryIdea.findUniqueOrThrow({ where: { id: a.idea.id } });
    expect([row.title, row.allowOwnDates, row.canonicalKey]).toEqual(["", false, null]);
    await disconnectLibrary(u);
    expect((await getIdea(u, b.idea.id)).sources.map((s) => s.kind)).toEqual(["chat"]);
  });

  it("the sweep catches a screenshot hidden by a path unaware of ideas", async () => {
    const u = await newUser();
    const shot = await newShot(u);
    const idea = await saveIdea(u, { kind: "note", title: "Quote", source: { kind: "screenshot", provenance: "ocr", screenshotItemId: shot } });
    await prisma.screenshotItem.update({ where: { id: shot }, data: { deletedAt: new Date() } });
    expect(await sweepOrphanSources()).toBeGreaterThan(0);
    await expect(getIdea(u, idea.idea.id)).rejects.toMatchObject({ code: "not-found" });
  });

  it("deleting tells its scope first, gives the identity back, and repeats harmlessly", async () => {
    const u = await newUser();
    const idea = await saveIdea(u, { kind: "place", title: "Bar", placeId: "gp9", source: person("бар") });
    expect((await deletionScope(u, idea.idea.id)).sources).toEqual({ chat: 1 });
    await deleteIdea(u, idea.idea.id);
    await deleteIdea(u, idea.idea.id);
    const again = await saveIdea(u, { kind: "place", title: "Bar", placeId: "gp9", source: person("снова бар") });
    expect(again.created).toBe(true);
    expect(again.idea.id).not.toBe(idea.idea.id);
  });

  it("no coordinates never block keeping it, and a wrong place can be taken off", async () => {
    const u = await newUser();
    const vibe = await saveIdea(u, { kind: "aesthetic", title: "Тихий двор", source: person("как тут") });
    expect(vibe.idea.placeId).toBeNull();
    const placed = await setPlace(u, vibe.idea.id, "gp5", "Kyiv");
    expect(placed.placeId).toBe("gp5");
    const removed = await setPlace(u, vibe.idea.id, null, "Kyiv");
    expect(removed.placeId).toBeNull();
    await setOnlyForMe(u, vibe.idea.id);
  });

  it("asks a few questions, and «позже» stops asking", async () => {
    const u = await newUser();
    const ids = [];
    for (const title of ["a", "b", "c", "d"]) ids.push((await saveIdea(u, { kind: "note", title, source: person(title) })).idea.id);
    expect(await reasonQuestions(u)).toHaveLength(3);
    await snoozeReason(u, ids[0]!);
    await setReason(u, ids[1]!, "reference", null);
    expect((await reasonQuestions(u)).map((i) => i.id)).toEqual([ids[2], ids[3]]);
  });

  async function newMatch(a: string, b: string, data: Record<string, unknown> = {}): Promise<string> {
    // The pair's yes comes after every idea these tests save: only ideas saved before it count (decision 2026-11-03).
    const match = await prisma.match.create({ data: { userAId: a, userBId: b, status: "negotiating_venue", createdAt: new Date(Date.now() + 60_000), ...data } as never, select: { id: true } });
    return match.id;
  }

  async function grantedIdea(user: string, title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const saved = await saveIdea(user, { kind: "activity", title, intent: "want", source: person(title), ...extra } as never);
    await setUsage(user, saved.idea.id, "own_dates", true);
    return saved.idea.id;
  }

  it("two sources of one interest meet for the pair, showing each only their own words", async () => {
    const a = await newUser();
    const b = await newUser();
    const match = await newMatch(a, b);
    await grantedIdea(a, "Студия Глина", { topic: "ceramics", placeId: "gpc" });
    await grantedIdea(b, "Попробовать керамику", { topic: "ceramics" });
    const forA = await pairOverlap(match, a);
    const forB = await pairOverlap(match, b);
    expect(forA.map((o) => [o.label, o.kind])).toEqual([["Студия Глина", "same_kind"]]);
    expect(forB.map((o) => o.label)).toEqual(["Попробовать керамику"]);
    expect(JSON.stringify(forB)).not.toContain("Глина");
  });

  it("nothing is shared while the decision is blind, with a private idea, a block or a revoked use", async () => {
    const a = await newUser();
    const b = await newUser();
    const proposed = await newMatch(a, b, { status: "proposed" });
    const live = await newMatch(a, b);
    const ideaA = await grantedIdea(a, "Джаз", { topic: "jazz" });
    const ideaB = await grantedIdea(b, "Джаз-клуб", { topic: "jazz" });
    expect(await pairOverlap(proposed, a)).toEqual([]);
    expect(await pairOverlap(live, a)).toHaveLength(1);

    await setUsage(b, ideaB, "own_dates", false);
    expect(await pairOverlap(live, a)).toEqual([]);
    await setUsage(b, ideaB, "own_dates", true);
    expect(await pairOverlap(live, a)).toHaveLength(1);

    await setReason(a, ideaA, "reference", null);
    expect(await pairOverlap(live, b)).toEqual([]);
    await setReason(a, ideaA, "date_idea", null);
    await setUsage(a, ideaA, "own_dates", true);

    await prisma.userBlock.create({ data: { blockerId: b, blockedId: a } as never });
    expect(await pairOverlap(live, a)).toEqual([]);
    const outsider = await newUser();
    await expect(pairOverlap(live, outsider)).rejects.toMatchObject({ code: "not-found" });
  });

  it("planning offers what fits, drops another city or a past date, and flags an unconfirmed one", async () => {
    const a = await newUser();
    const b = await newUser();
    const at = new Date(Date.now() + 5 * 24 * 3_600_000);
    const match = await newMatch(a, b, { agreedTime: at });
    await grantedIdea(a, "Здесь", { city: "Kyiv" });
    await grantedIdea(a, "Там", { city: "Lviv" });
    await grantedIdea(a, "Прошло", { eventAt: new Date(Date.now() - 3_600_000) });
    await grantedIdea(a, "В тот вечер", { eventAt: new Date(at.getTime() + 3_600_000) });
    await saveIdea(a, { kind: "activity", title: "Не разрешено", source: person("не разрешено") });
    const plan = await planningSuggestions(match, a, { city: "Kyiv" });
    expect(plan.suggestions.map((s) => s.title).sort()).toEqual(["В тот вечер", "Здесь"]);
    expect(plan.suggestions.find((s) => s.title === "В тот вечер")?.needsCheck).toBe(true);
  });

  it("a board keeps the same set and only moves a wanted place up, until the use is revoked", async () => {
    const a = await newUser();
    const idea = await grantedIdea(a, "Бар", { placeId: "gpw" });
    const board = ["g1", "g2", "g3", "gpw", "g5"].map((placeId) => ({ placeId, lat: 0, lng: 0 }));
    const nudged = personalizeOrder(board, { anchors: [], beenThere: new Set(), wanted: await wantedPlaceIds(a) });
    expect(nudged.map((v) => v.placeId).sort()).toEqual(board.map((v) => v.placeId).sort());
    expect(nudged.findIndex((v) => v.placeId === "gpw")).toBeLessThan(3);
    await setOnlyForMe(a, idea);
    expect((await wantedPlaceIds(a)).size).toBe(0);
  });

  it("a real date plans the idea, a cancellation restores it, and a visit is needed to rate", async () => {
    const a = await newUser();
    const b = await newUser();
    const idea = await grantedIdea(a, "Сад", { placeId: "gps" });
    const match = await newMatch(a, b, { status: "scheduled", venuePlaceId: "gps", agreedTime: new Date(Date.now() + 86_400_000) });
    await reconcilePlans();
    await reconcilePlans();
    expect((await getIdea(a, idea)).intent).toBe("planned");
    await expect(recordImpression(match, a, { placeRating: "liked" })).rejects.toMatchObject({ code: "not-attended" });
    expect(await pendingImpressions(a)).toEqual([]);

    await prisma.match.update({ where: { id: match }, data: { dateAttendedA: true } });
    expect((await pendingImpressions(a)).map((p) => p.matchId)).toEqual([match]);
    await recordImpression(match, a, { placeRating: "liked", formatRating: "disliked", repeatFormat: false });
    expect((await getIdea(a, idea)).intent).toBe("tried");
    // Corrected, not duplicated, and never about the partner.
    await recordImpression(match, a, { skipped: true });
    const rows = await prisma.memoryImpression.findMany({ where: { matchId: match } });
    expect(rows.map((r) => [r.userId, r.skipped, r.placeRating])).toEqual([[a, true, null]]);

    const other = await grantedIdea(a, "Парк", { placeId: "gpp" });
    const cancelled = await newMatch(a, b, { status: "scheduled", venuePlaceId: "gpp", agreedTime: new Date(Date.now() + 86_400_000) });
    await reconcilePlans();
    expect((await getIdea(a, other)).intent).toBe("planned");
    await prisma.match.update({ where: { id: cancelled }, data: { status: "cancelled" } });
    await reconcilePlans();
    expect((await getIdea(a, other)).intent).toBe("want");
  });

  it("a confirmed preference reaches matching only through its grant, and a revocation marks the vector stale", async () => {
    const a = await newUser();
    await prisma.$executeRawUnsafe(`INSERT INTO profiles (id, user_id, updated_at) VALUES (gen_random_uuid(), '${a}'::uuid, NOW())`);
    const pref = await confirmPreference(a, "wish", "больше активных свиданий");
    expect(pref.usage).toEqual({ ownDates: true, matching: false });
    expect((await prisma.profile.findFirstOrThrow({ where: { userId: a } })).embeddingDirty).toBe(false);
    await setPreferenceMatching(a, pref.id, true);
    expect((await prisma.profile.findFirstOrThrow({ where: { userId: a } })).embeddingDirty).toBe(true);
    await prisma.profile.updateMany({ where: { userId: a }, data: { embeddingDirty: false } });
    await revokePreference(a, pref.id);
    expect((await prisma.profile.findFirstOrThrow({ where: { userId: a } })).embeddingDirty).toBe(true);
    expect(await prisma.memoryPreference.count({ where: { userId: a, allowMatching: true, revokedAt: null } })).toBe(0);
  });

  it("a reference reaches Style Picks in words, and a memo stays with its owner", async () => {
    const a = await newUser();
    const b = await newUser();
    const match = await newMatch(a, b);
    const look = await saveIdea(a, { kind: "outfit", title: "Чёрный тренч", reason: "style", source: person("этот образ") });
    expect(await styleReferenceTexts(a)).toEqual(["Чёрный тренч"]);
    const memoA = await dateMemo(match, a);
    const memoB = await dateMemo(match, b);
    expect(memoA.references.map((r) => r.id)).toEqual([look.idea.id]);
    expect(memoB.references).toEqual([]);
    await setIntent(a, look.idea.id, "dropped");
    expect(await styleReferenceTexts(a)).toEqual([]);
  });

  it("a dated idea gets one reminder; moving, dropping and repeats leave no stale push", async () => {
    const a = await newUser();
    const now = new Date();
    const eventAt = new Date(now.getTime() + 24 * 3_600_000);
    const idea = await grantedIdea(a, "Концерт", { eventAt, eventTimezone: "Europe/Kyiv" });
    const noDate = await grantedIdea(a, "Без даты");
    await expect(setReminder(a, noDate)).rejects.toMatchObject({ code: "no-date" });
    await setReminder(a, idea);
    await setReminder(a, idea);
    expect(await prisma.memoryReminder.count({ where: { ideaId: idea } })).toBe(1);

    const later = new Date(now.getTime() + 20 * 24 * 3_600_000);
    await setEventDate(a, idea, later, "Europe/Kyiv", "confirmed");
    const rows = await prisma.memoryReminder.findMany({ where: { ideaId: idea }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.state)).toEqual(["cancelled", "pending"]);

    const pushes: string[] = [];
    const send = async (_u: string, p: { body: string }) => { pushes.push(p.body); return true; };
    const deps = { send: send as never, quiet: () => false };
    expect(await sendDueReminders(now, deps)).toBe(0);
    const whenDue = new Date(later.getTime() - 3_600_000);
    expect(await sendDueReminders(whenDue, { ...deps, quiet: () => true })).toBe(0);
    expect(await sendDueReminders(whenDue, deps)).toBe(1);
    expect(await sendDueReminders(whenDue, deps)).toBe(0);
    expect(pushes).toHaveLength(1);

    const dropped = await grantedIdea(a, "Выставка", { eventAt: new Date(now.getTime() + 2 * 86_400_000) });
    await setReminder(a, dropped);
    await setIntent(a, dropped, "dropped");
    await sendDueReminders(new Date(now.getTime() + 2 * 86_400_000 - 1000), deps);
    expect(pushes).toHaveLength(1);
    expect((await prisma.memoryReminder.findFirstOrThrow({ where: { ideaId: dropped } })).state).toBe("cancelled");
  });

  it("the map shows catalog points and never invents one", async () => {
    const a = await newUser();
    const known = await saveIdea(a, { kind: "place", title: "Известное", placeId: "gpm", source: person("известное") });
    const vibe = await saveIdea(a, { kind: "aesthetic", title: "Атмосфера", source: person("атмосфера") });
    await prisma.$executeRawUnsafe(`INSERT INTO curated_venues (id, name, lat, lng, place_id, category, address, updated_at) VALUES (gen_random_uuid(), 'Известное', 50.4, 30.5, 'gpm', 'cafe', 'addr', NOW())`);
    const map = await ideaMap(a);
    expect(map.points.map((p) => [p.ideaId, p.lat])).toEqual([[known.idea.id, 50.4]]);
    expect(map.withoutPoint.map((p) => p.ideaId)).toEqual([vibe.idea.id]);
  });
});
