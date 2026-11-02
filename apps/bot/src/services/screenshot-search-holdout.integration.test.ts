/**
 * The search's word path on the audit's held-out set (evals/screenshot-search/
 * holdout-set.ts), against real Postgres. Meaning search needs the real
 * embedding model, which no test calls, so here it is off and every number is
 * the word path's alone: what the person gets when a name is remembered.
 *
 * Asserted: safety (another person's row and a deleted row are never returned,
 * negatives answer nothing). Measured, written to $HOLDOUT_OUT when set: recall
 * at the page size, precision, and the share of negatives given an answer.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCREENSHOT_SEARCH_HITS } from "@gennety/shared";
import { integrationPrisma as db, seedUser } from "../../../../packages/db/src/test-integration.js";
import { HOLDOUT_ITEMS, HOLDOUT_QUERIES } from "../../evals/screenshot-search/holdout-set.js";
import { searchScreenshotsPage } from "./screenshot-library.js";

const noMeaning = { embed: async (): Promise<number[]> => { throw new Error("no embedding in tests"); } };

let owner: string;
const idOf = new Map<string, string>();
const keyOf = new Map<string, string>();
let foreignId: string;
let deletedId: string;

async function add(userId: string, item: { title: string; description: string; ocr: string; kind: string }, deleted = false): Promise<string> {
  const id = randomUUID();
  await db.screenshotItem.create({
    data: {
      id, userId, generation: 1, source: "auto", sourceKey: id, contentHash: deleted ? null : id, storagePath: `${userId}/${id}.jpg`,
      state: "ready", title: item.title, description: item.description, ocrText: item.ocr || null, category: item.kind,
      ...(deleted ? { deletedAt: new Date() } : {}),
    },
  });
  return id;
}

beforeAll(async () => {
  await db.$executeRawUnsafe("TRUNCATE TABLE users CASCADE");
  owner = (await seedUser({ telegramId: 9301n })).id;
  const stranger = (await seedUser({ telegramId: 9302n })).id;
  for (const item of HOLDOUT_ITEMS) {
    const id = await add(owner, item);
    idOf.set(item.key, id);
    keyOf.set(id, item.key);
  }
  // Same words as the queries, but someone else's, or deleted: never an answer.
  foreignId = await add(stranger, { title: "Boulderhaus", description: "climbing gym wine bar terrace", ocr: "Boulderhaus Роза Глина Sakura", kind: "place" });
  deletedId = await add(owner, { title: "Hotel Morskoy", description: "hotel by the sea", ocr: "Hotel Morskoy sea view", kind: "place" }, true);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("held-out set, word path", () => {
  it("never answers with someone else's or a deleted row, and measures the rest", async () => {
    const rows: Array<{ query: string; probe: string; found: string[]; relevant: readonly string[] }> = [];
    for (const q of HOLDOUT_QUERIES) {
      const { hits } = await searchScreenshotsPage(owner, q.query, q.keywords, { limit: SCREENSHOT_SEARCH_HITS }, noMeaning);
      const ids = hits.map((h) => h.id);
      expect(ids).not.toContain(foreignId);
      expect(ids).not.toContain(deletedId);
      rows.push({ query: q.query, probe: q.probe, found: ids.map((id) => keyOf.get(id) ?? id), relevant: q.relevant });
    }

    const positives = rows.filter((r) => r.relevant.length > 0);
    const negatives = rows.filter((r) => r.relevant.length === 0);
    const recall = positives.reduce((sum, r) => sum + r.relevant.filter((k) => r.found.includes(k)).length / r.relevant.length, 0) / positives.length;
    const returned = positives.flatMap((r) => r.found.map((k) => r.relevant.includes(k)));
    const precision = returned.length ? returned.filter(Boolean).length / returned.length : 0;
    const falseAnswers = negatives.filter((r) => r.found.length > 0).length;

    // Negatives must answer nothing on the word path: a common word is not a match.
    expect(falseAnswers).toBe(0);
    const out = process.env.HOLDOUT_OUT;
    if (out) {
      writeFileSync(out, JSON.stringify({ queries: rows.length, positives: positives.length, negatives: negatives.length, recallAtPage: recall, precision, falseAnswers, rows }, null, 2));
    }
  });
});
