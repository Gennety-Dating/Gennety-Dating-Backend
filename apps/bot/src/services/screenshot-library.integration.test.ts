/**
 * The screenshot library's SQL against a real Postgres with pgvector: the unit
 * tests mock `$queryRaw`, so none of this runs anywhere else. Owner isolation,
 * filters, paging, the distance limit and the reindex pick. Uses the synthetic
 * labelled set, with a toy embedding: this checks the queries, and says nothing
 * about the limit's right value (`evals/screenshot-search/threshold.ts` does).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { integrationPrisma as db, seedUser } from "../../../../packages/db/src/test-integration.js";
import { LABELLED_ITEMS, LABELLED_QUERIES } from "../../evals/screenshot-search/labelled-set.js";
import { reindexBatch, SCREENSHOT_PROCESSING_VERSION } from "../workers/screenshot-library.js";
import { executeScreenshotTool } from "./chat-screenshots.js";
import { listItems, listScreenshotsPage, searchScreenshotsPage } from "./screenshot-library.js";

const DIMENSIONS = 1536;

/** A PNG header the server's image check accepts: the indexer re-checks bytes before reading. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** Words hashed into a vector: same words, near; no shared words, orthogonal. */
function toyEmbedding(text: string): number[] {
  const vector: number[] = Array.from({ length: DIMENSIONS }, () => 0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3)) {
    let hash = 0;
    for (const ch of word) hash = (hash * 31 + ch.codePointAt(0)!) % DIMENSIONS;
    vector[hash] = 1;
  }
  if (!vector.some((v) => v !== 0)) vector[0] = 1;
  return vector;
}
const embed = async (text: string) => toyEmbedding(text);

let owner: string;
let stranger: string;
const idOf = new Map<string, string>();

async function connect(userId: string, generation = 1): Promise<void> {
  await db.screenshotLibrary.create({
    data: { userId, status: "active", generation, autoImport: true, consentAt: new Date(), consentVersion: "t" },
  });
}

async function addItem(
  userId: string,
  fields: { title: string; description: string; ocr: string; category: string | null; takenAt?: Date | null; state?: string; version?: number },
): Promise<string> {
  const id = randomUUID();
  await db.screenshotItem.create({
    data: {
      id, userId, generation: 1, source: "auto", sourceKey: id, contentHash: id, storagePath: `${userId}/${id}.jpg`,
      state: fields.state ?? "ready", title: fields.title, description: fields.description, ocrText: fields.ocr,
      category: fields.category, capturedAt: fields.takenAt ?? null, processingVersion: fields.version ?? SCREENSHOT_PROCESSING_VERSION,
    },
  });
  const literal = `[${toyEmbedding(`${fields.title} ${fields.description} ${fields.ocr}`).join(",")}]`;
  await db.$executeRawUnsafe(`UPDATE screenshot_items SET embedding = '${literal}'::vector WHERE id = '${id}'::uuid`);
  return id;
}

beforeEach(async () => {
  await db.$executeRawUnsafe("TRUNCATE TABLE users CASCADE");
  owner = (await seedUser({ telegramId: 7001n })).id;
  stranger = (await seedUser({ telegramId: 7002n })).id;
  await connect(owner);
  await connect(stranger);
  idOf.clear();
  let day = 1;
  for (const item of LABELLED_ITEMS) {
    idOf.set(item.key, await addItem(owner, {
      title: item.title, description: item.description, ocr: item.ocr, category: item.kind,
      takenAt: new Date(Date.UTC(2026, 9, day++)),
    }));
  }
});

afterAll(async () => {
  await db.$disconnect();
});

describe("owner", () => {
  it("another person's row is never found, by word, by meaning or in a list", async () => {
    const theirs = await addItem(stranger, { title: "Лоза", description: "wine bar terrace", ocr: "Лоза", category: "place" });
    const words = await searchScreenshotsPage(owner, "Лоза wine bar terrace", [], { limit: 50 }, { embed });
    expect(words.hits.map((h) => h.id)).not.toContain(theirs);
    const list = await listScreenshotsPage(owner, { filter: { kind: "place" }, limit: 50 });
    expect(list.hits.map((h) => h.id)).not.toContain(theirs);
    expect(list.total).toBe(3);
    const read = JSON.parse((await executeScreenshotTool(owner, "read_screenshot", { id: theirs })).result);
    expect(read.error).toBe("not_found");
    const view = await executeScreenshotTool(owner, "view_screenshot", { id: theirs }, { overBudget: () => false });
    expect(view.image).toBeUndefined();
  });
});

describe("filters", () => {
  it("every one of the nine lines is told apart by its kind", async () => {
    for (const kind of new Set(LABELLED_ITEMS.map((i) => i.kind))) {
      const { hits, total } = await listScreenshotsPage(owner, { filter: { kind } });
      expect(total).toBe(3);
      expect(hits.every((h) => h.category === kind)).toBe(true);
    }
  });

  it("a search stays inside the kind", async () => {
    const all = await searchScreenshotsPage(owner, "x", ["handmade", "date"], { limit: 50 }, { embed });
    const kinds = new Set(all.hits.map((h) => h.category));
    expect(kinds.size).toBeGreaterThan(1);
    const only = await searchScreenshotsPage(owner, "x", ["handmade", "date"], { limit: 50, filter: { kind: "item" } }, { embed });
    expect(only.hits.length).toBeGreaterThan(0);
    expect(only.hits.every((h) => h.category === "item")).toBe(true);
  });

  it("`item` also finds a row indexed before the kinds", async () => {
    const old = await addItem(owner, { title: "Old thing", description: "a lamp", ocr: "", category: "thing", version: 1 });
    const { hits } = await listScreenshotsPage(owner, { filter: { kind: "item" } });
    expect(hits.map((h) => h.id)).toContain(old);
  });

  it("dates are whole days, and no capture time counts by the import", async () => {
    const noTime = await addItem(owner, { title: "No time", description: "x", ocr: "", category: "text", takenAt: null });
    const october = await listScreenshotsPage(owner, {
      filter: { capturedFrom: new Date("2026-10-02T00:00:00Z"), capturedBefore: new Date("2026-10-04T00:00:00Z") },
    });
    expect(october.total).toBe(2);
    const today = await listScreenshotsPage(owner, { filter: { capturedFrom: new Date(Date.now() - 60_000) } });
    expect(today.hits.map((h) => h.id)).toEqual([noTime]);
  });

  it("a deleted, a reserved or an unindexed row stays out", async () => {
    await db.screenshotItem.update({ where: { id: idOf.get("place-wine")! }, data: { deletedAt: new Date() } });
    await addItem(owner, { title: "Reserved", description: "wine", ocr: "", category: "place", state: "reserved" });
    const { hits, total } = await listScreenshotsPage(owner, { filter: { kind: "place" } });
    expect(total).toBe(2);
    expect(hits.map((h) => h.title)).not.toContain("Лоза");
  });
});

describe("paging", () => {
  it("a listing walks everything once, newest first", async () => {
    const seen: string[] = [];
    let offset = 0;
    let more = true;
    while (more) {
      const page = await listScreenshotsPage(owner, { offset, limit: 10 });
      seen.push(...page.hits.map((h) => h.id));
      more = page.hasMore;
      offset += 10;
    }
    expect(seen).toHaveLength(LABELLED_ITEMS.length);
    expect(new Set(seen).size).toBe(LABELLED_ITEMS.length);
    expect(seen[0]).toBe(idOf.get(LABELLED_ITEMS.at(-1)!.key));
  });

  it("a search walks its one order without repeats", async () => {
    const seen: string[] = [];
    let offset = 0;
    let more = true;
    while (more) {
      const page = await searchScreenshotsPage(owner, "wine", ["кафе", "Hotel"], { offset, limit: 2 }, { embed });
      seen.push(...page.hits.map((h) => h.id));
      more = page.hasMore;
      offset += 2;
    }
    expect(seen.length).toBeGreaterThan(2);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("the tool's nextOffset leads to the next page", async () => {
    const first = JSON.parse((await executeScreenshotTool(owner, "search_screenshots", { purpose: "find_saved" , taken_from: "2026-10-01" })).result);
    expect(first.total).toBe(LABELLED_ITEMS.length);
    expect(first.hits).toHaveLength(20);
    const second = JSON.parse((await executeScreenshotTool(owner, "search_screenshots", { purpose: "find_saved", taken_from: "2026-10-01", offset: first.nextOffset })).result);
    expect(second.hits).toHaveLength(LABELLED_ITEMS.length - 20);
    expect(second.nextOffset).toBeUndefined();
  });
});

describe("distance limit, in SQL", () => {
  it("nothing in common means nothing found, not the least unrelated", async () => {
    const page = await searchScreenshotsPage(owner, "qqqzzz", [], { limit: 50 }, { embed });
    expect(page.hits).toEqual([]);
  });

  it("a negative query of the set finds nothing by words either", async () => {
    for (const { query } of LABELLED_QUERIES.filter((q) => q.relevant.length === 0)) {
      const page = await searchScreenshotsPage(owner, query, [], { limit: 50 }, { embed: async () => toyEmbedding("qqqzzz") });
      expect(page.hits.filter((h) => h.match === "text").map((h) => h.title), query).toEqual([]);
    }
  });
});

describe("words", () => {
  const titles = async (query: string, keywords: string[] = []) =>
    (await searchScreenshotsPage(owner, query, keywords, { limit: 50 }, { embed: async () => toyEmbedding("qqqzzz") })).hits.map((h) => h.title);

  it("a Russian stem finds its inflected word, with non-Latin word edges", async () => {
    expect(await titles("x", ["Мастер-класс"])).toContain("Мастер-класс по акварели");
    expect(await titles("x", ["акварел"])).toContain("Мастер-класс по акварели");
    expect(await titles("x", ["варель"])).not.toContain("Мастер-класс по акварели");
  });

  it("a short word is whole, and punctuation in a word is literal", async () => {
    expect(await titles("x", ["car"])).toEqual([]);
    expect(await titles("x", ["(.*)"])).toEqual([]);
  });

  it("all the described words must be there, a keyword alone is enough", async () => {
    expect(await titles("wine bar with a terrace")).toContain("Лоза");
    expect(await titles("wine parking")).toEqual([]);
    expect(await titles("wine parking", ["Лоза"])).toContain("Лоза");
  });
});

describe("the old client's view", () => {
  it("never sees a value it cannot decode", async () => {
    const { items } = await listItems(owner, { limit: 60 });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(["place", "event", "thing", "other"]).toContain(item.category);
  });
});

describe("reindex", () => {
  const download = async () => ({ ok: true as const, bytes: png(400, 800) });
  const reading = { title: "New", description: "new reading", category: "food" as const, visibleText: "", entities: [] };

  it("re-reads only older rows, updates them, leaves the rest", async () => {
    const old = await addItem(owner, { title: "Old", description: "old", ocr: "stored words", category: "thing", version: 1 });
    expect(await reindexBatch({ download, read: async () => reading, embed })).toBe(1);
    const after = await db.screenshotItem.findUniqueOrThrow({ where: { id: old } });
    expect(after).toMatchObject({ state: "ready", title: "New", category: "food", ocrText: "stored words", processingVersion: SCREENSHOT_PROCESSING_VERSION, attempts: 0, nextAttemptAt: null });
    expect(await reindexBatch({ download, read: async () => reading, embed })).toBe(0);
  });

  it("a failed re-read keeps the row searchable and waits", async () => {
    const old = await addItem(owner, { title: "Old", description: "old", ocr: "", category: "thing", version: 1 });
    await reindexBatch({ download, read: async () => null, embed });
    const after = await db.screenshotItem.findUniqueOrThrow({ where: { id: old } });
    expect(after).toMatchObject({ state: "ready", title: "Old", category: "thing", processingVersion: 1, attempts: 1 });
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await reindexBatch({ download, read: async () => reading, embed })).toBe(0);
  });

  it("a paused library, or one of another generation, is not touched", async () => {
    const old = await addItem(owner, { title: "Old", description: "old", ocr: "", category: "thing", version: 1 });
    await db.screenshotLibrary.update({ where: { userId: owner }, data: { status: "paused" } });
    expect(await reindexBatch({ download, read: async () => reading, embed })).toBe(0);
    await db.screenshotLibrary.update({ where: { userId: owner }, data: { status: "active", generation: 2 } });
    expect(await reindexBatch({ download, read: async () => reading, embed })).toBe(0);
    expect((await db.screenshotItem.findUniqueOrThrow({ where: { id: old } })).title).toBe("Old");
  });

  it("a row deleted meanwhile is not restored", async () => {
    const old = await addItem(owner, { title: "Old", description: "old", ocr: "", category: "thing", version: 1 });
    await reindexBatch({
      download,
      read: async () => {
        await db.screenshotItem.update({ where: { id: old }, data: { deletedAt: new Date(), title: null } });
        return reading;
      },
      embed,
    });
    expect((await db.screenshotItem.findUniqueOrThrow({ where: { id: old } })).title).toBeNull();
  });

  it("failed under an older version returns to the queue once, under this one stays", async () => {
    const older = await addItem(owner, { title: "F1", description: "x", ocr: "", category: null, state: "failed", version: 1 });
    const current = await addItem(owner, { title: "F2", description: "x", ocr: "", category: null, state: "failed" });
    await reindexBatch({ download, read: async () => reading, embed });
    expect((await db.screenshotItem.findUniqueOrThrow({ where: { id: older } })).state).toBe("queued");
    expect((await db.screenshotItem.findUniqueOrThrow({ where: { id: current } })).state).toBe("failed");
  });
});
