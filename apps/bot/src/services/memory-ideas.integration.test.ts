import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@gennety/db";
import { usableForOwnDates, usableForPartnerWishlist } from "@gennety/shared";
import { sweepOrphanSources } from "../workers/memory-ideas.js";
import { executeMemoryTool } from "./chat-memory.js";
import { deleteItem, disconnectLibrary } from "./screenshot-library.js";
import {
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
  saveIdea,
  setIntent,
  setOnlyForMe,
  setPlace,
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
    await setUsage(u, gift.idea.id, "partner", true);
    const view = await setReason(u, gift.idea.id, "gift", "сестра");
    expect(view.usage.onlyForMe).toBe(true);
    const row = await prisma.memoryIdea.findUniqueOrThrow({ where: { id: gift.idea.id } });
    expect(usableForOwnDates({ ...row, intent: row.intent as "want", reason: "gift" })).toBe(false);
    expect(usableForPartnerWishlist({ ...row, intent: row.intent as "want", reason: "gift" })).toBe(false);
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
});
