/**
 * Regression tests from the 2026-11 backend audit of the screenshot library and
 * ideas (docs/audits/2026-11-screenshots-backend-audit.md). Each block names its
 * finding. Synthetic users and rows only; storage and the model are stubbed, so
 * nothing here reaches Supabase or OpenAI.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./storage.js")>()),
  createScreenshotSignedUpload: vi.fn(async (path: string) => `https://upload.test/${path}`),
  createScreenshotSignedUrls: vi.fn(async (paths: readonly string[]) => paths.map((p) => `https://signed.test/${p}`)),
}));

const { integrationPrisma: db, seedUser } = await import("../../../../packages/db/src/test-integration.js");
const { connectLibrary, deleteItem, readItem, reserveUpload, listItems, disconnectLibrary } = await import("./screenshot-library.js");
const { indexBatch } = await import("../workers/screenshot-library.js");
const { sendDueReminders } = await import("../workers/memory-ideas.js");
const { reconcilePlans, setReminder, planningSuggestions } = await import("./memory-planning.js");
const {
  deleteIdea,
  getIdea,
  listIdeas,
  mergeIdeas,
  removeSource,
  saveIdea,
  setIntent,
  setReason,
  setUsage,
  splitIdea,
} = await import("./memory-ideas.js");
const { executeScreenshotTool } = await import("./chat-screenshots.js");
const { executeMemoryTool } = await import("./chat-memory.js");
const { SCREENSHOT_CONSENT_VERSION } = await import("@gennety/shared");

const DAY = 24 * 3_600_000;
const hash = () => randomUUID().replace(/-/g, "").padEnd(64, "a").slice(0, 64);
const person = (quote: string) => ({ kind: "chat" as const, provenance: "person" as const, quote });

let a: string;
let b: string;

beforeEach(async () => {
  await db.$executeRawUnsafe("TRUNCATE TABLE users CASCADE");
  await db.$executeRawUnsafe("TRUNCATE TABLE curated_venues CASCADE");
  a = (await seedUser({ telegramId: 9101n })).id;
  b = (await seedUser({ telegramId: 9102n })).id;
});

afterAll(async () => {
  await db.$disconnect();
});

async function readyShot(userId: string, fields: { title?: string; ocr?: string } = {}): Promise<string> {
  const id = randomUUID();
  await db.screenshotItem.create({
    data: {
      id, userId, generation: 1, source: "auto", sourceKey: `k-${id}`, contentHash: hash(), storagePath: `${userId}/${id}.jpg`,
      state: "ready", title: fields.title ?? "Лоза", ocrText: fields.ocr ?? "Лоза wine bar", category: "place",
    },
  });
  return id;
}

/* ── F-02: a reminder nobody would ever receive ─────────────────────────── */

describe("F-02 / decision 2026-11-03: turning a reminder on also allows the idea for own dates", () => {
  it("one request: the reminder is set, own dates is on, and the idea says both", async () => {
    const saved = await saveIdea(a, { kind: "event", title: "Концерт", eventAt: new Date(Date.now() + 10 * DAY), source: person("хочу на концерт") });
    expect(saved.idea.reminder).toEqual({ state: "off", dueAt: null });
    const set = await setReminder(a, saved.idea.id);
    expect(set.ownDatesTurnedOn).toBe(true);
    expect(set.idea.usage.ownDates).toBe(true);
    expect(set.idea.reminder.state).toBe("on");
    expect(set.idea.reminder.dueAt).toBe(set.dueAt);
    expect((await getIdea(a, saved.idea.id)).reminder.state).toBe("on");
    const usage = await db.memoryIdeaEvent.findMany({ where: { ideaId: saved.idea.id, type: "usage" } });
    expect(usage.map((e) => e.payload)).toEqual([{ use: "own_dates", allow: true, via: "reminder" }]);
  });

  it("it is then delivered once, with no idea title on the lock screen", async () => {
    const saved = await saveIdea(a, { kind: "event", title: "Тайный концерт", eventAt: new Date(Date.now() + 10 * DAY), source: person("концерт") });
    await setReminder(a, saved.idea.id);
    const pushes: Array<{ title: string; body: string; data?: Record<string, unknown> }> = [];
    const send = async (_u: string, p: { title: string; body: string; data?: Record<string, unknown> }) => { pushes.push(p); return true; };
    await sendDueReminders(new Date(Date.now() + 8 * DAY), { send: send as never, quiet: () => false });
    expect(pushes).toHaveLength(1);
    expect(JSON.stringify([pushes[0]!.title, pushes[0]!.body])).not.toContain("Тайный");
    expect(pushes[0]!.title).toBe("Idea reminder");
    expect(pushes[0]!.data).toMatchObject({ type: "memory.reminder", ideaId: saved.idea.id });
    expect((await getIdea(a, saved.idea.id)).reminder.state).toBe("sent");
  });

  it("a gift or a reference is refused with not-own-wish, a dropped idea with idea-closed; nothing is granted", async () => {
    const gift = await saveIdea(a, { kind: "gift", title: "Шарф", eventAt: new Date(Date.now() + 10 * DAY), reason: "gift", recipient: "сестра", source: person("шарф") });
    await expect(setReminder(a, gift.idea.id)).rejects.toMatchObject({ code: "not-own-wish" });
    const dropped = await saveIdea(a, { kind: "event", title: "Выставка", eventAt: new Date(Date.now() + 10 * DAY), source: person("выставка") });
    await setIntent(a, dropped.idea.id, "dropped");
    await expect(setReminder(a, dropped.idea.id)).rejects.toMatchObject({ code: "idea-closed" });
    for (const id of [gift.idea.id, dropped.idea.id]) {
      expect((await getIdea(a, id)).usage.ownDates).toBe(false);
      expect(await db.memoryReminder.count({ where: { ideaId: id } })).toBe(0);
    }
  });

  it("the chat tool says own dates came on with it", async () => {
    const saved = await saveIdea(a, { kind: "event", title: "Выставка", eventAt: new Date(Date.now() + 10 * DAY), source: person("выставка") });
    const out = JSON.parse(await executeMemoryTool(a, "set_idea_reminder", { id: saved.idea.id, on: true }));
    expect(out.success).toBe(true);
    expect(out.idea.uses.ownDates).toBe(true);
    expect(String(out.instruction)).toMatch(/own dates/);
  });
});

/* ── F-04: an upload reserved while the library is being disconnected ───── */

describe("F-04 a reservation racing «Отключить и удалить» does not survive it", () => {
  it("waits for the disconnect and then refuses, leaving no live row", async () => {
    await connectLibrary(a, { consentVersion: SCREENSHOT_CONSENT_VERSION, autoImport: true, rangeDays: null });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => (locked = resolve));
    // The same first statements as `disconnectLibrary`, held open at the barrier.
    const disconnecting = db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE screenshot_libraries SET status = 'off', consent_at = NULL, consent_version = NULL WHERE user_id = ${a}::uuid`;
      await tx.$executeRaw`UPDATE screenshot_items SET deleted_at = NOW(), content_hash = NULL WHERE user_id = ${a}::uuid AND deleted_at IS NULL`;
      locked();
      await gate;
    }, { timeout: 20_000 });
    await lockHeld;
    const reserving = reserveUpload(a, { generation: 1, source: "auto", sourceKey: "k1", contentHash: hash(), capturedAt: null, ocrText: null })
      .then(() => ({ code: "reserved" }), (err: { code?: string }) => ({ code: err.code ?? "error" }));
    // Without a lock the reservation finishes inside this pause.
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await disconnecting;
    expect((await reserving).code).toBe("library-off");
    expect(await db.screenshotItem.count({ where: { userId: a, deletedAt: null } })).toBe(0);
  });

  it("the cap is counted under the same lock, so two reservations cannot both take the last place", async () => {
    await connectLibrary(a, { consentVersion: SCREENSHOT_CONSENT_VERSION, autoImport: true, rangeDays: null });
    const { SCREENSHOT_LIBRARY_MAX_ITEMS } = await import("@gennety/shared");
    await db.$executeRawUnsafe(`
      INSERT INTO screenshot_items (id, user_id, generation, source, source_key, content_hash, storage_path, state, updated_at)
      SELECT gen_random_uuid(), '${a}'::uuid, 1, 'auto', 'fill-' || g, md5(g::text) || md5((g+1)::text), '${a}/fill-' || g, 'ready', NOW()
      FROM generate_series(1, ${SCREENSHOT_LIBRARY_MAX_ITEMS - 1}) g
    `);
    const results = await Promise.allSettled([1, 2, 3].map((n) =>
      reserveUpload(a, { generation: 1, source: "auto", sourceKey: `race-${n}`, contentHash: hash(), capturedAt: null, ocrText: null }),
    ));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.screenshotItem.count({ where: { userId: a, deletedAt: null } })).toBe(SCREENSHOT_LIBRARY_MAX_ITEMS);
  });
});

/* ── F-12: the chosen import period is the server's rule too ───────────── */

describe("F-12 automatic import stays inside the period the person chose", () => {
  it("refuses an automatic screenshot older than the period, and still takes a hand-picked one", async () => {
    await connectLibrary(a, { consentVersion: SCREENSHOT_CONSENT_VERSION, autoImport: true, rangeDays: 90 });
    const old = new Date(Date.now() - 200 * DAY);
    await expect(
      reserveUpload(a, { generation: 1, source: "auto", sourceKey: "old", contentHash: hash(), capturedAt: old, ocrText: null }),
    ).rejects.toMatchObject({ code: "out-of-range" });
    const picked = await reserveUpload(a, { generation: 1, source: "manual", sourceKey: "old", contentHash: hash(), capturedAt: old, ocrText: null });
    expect(picked.uploadUrl).not.toBeNull();
    const recent = await reserveUpload(a, { generation: 1, source: "auto", sourceKey: "new", contentHash: hash(), capturedAt: new Date(Date.now() - DAY), ocrText: null });
    expect(recent.uploadUrl).not.toBeNull();
  });
});

/* ── F-05: bytes are checked again before a paid reading ───────────────── */

describe("F-05 the indexer re-checks the stored bytes before paying for a reading", () => {
  it("bytes replaced after commit never reach the model", async () => {
    await connectLibrary(a, { consentVersion: SCREENSHOT_CONSENT_VERSION, autoImport: true, rangeDays: null });
    const id = randomUUID();
    await db.screenshotItem.create({
      data: { id, userId: a, generation: 1, source: "auto", sourceKey: "s", contentHash: hash(), storagePath: `${a}/${id}.jpg`, state: "queued", nextAttemptAt: new Date(0) },
    });
    const read = vi.fn(async () => ({ title: "x", description: "x", category: "other" as const, visibleText: "", entities: [] }));
    await indexBatch({
      download: async () => ({ ok: true as const, bytes: Buffer.from("<html><script>not an image</script></html>") }),
      read,
      embed: async () => Array.from({ length: 1536 }, () => 0.1),
    });
    expect(read).not.toHaveBeenCalled();
    const row = await db.screenshotItem.findUniqueOrThrow({ where: { id } });
    expect(row.state).toBe("failed");
  });
});

/* ── F-07: plans of cancelled dates were never released past the first page ── */

describe("F-07 a cancelled date releases its idea however many plans exist", () => {
  it("finished plans do not crowd out the one that needs releasing", async () => {
    const completed = await db.match.create({ data: { userAId: a, userBId: b, status: "completed", venuePlaceId: "done" } as never });
    for (let i = 0; i < 6; i++) {
      const s = await saveIdea(a, { kind: "place", title: `Done ${i}`, placeId: `done-${i}`, source: person(`done ${i}`) });
      await db.memoryIdea.update({ where: { id: s.idea.id }, data: { intent: "planned", plannedMatchId: completed.id, intentBeforePlan: "want" } });
    }
    const cancelled = await db.match.create({ data: { userAId: a, userBId: b, status: "cancelled", venuePlaceId: "gone" } as never });
    const wish = await saveIdea(a, { kind: "place", title: "Wish", placeId: "gone", source: person("wish") });
    await db.memoryIdea.update({ where: { id: wish.idea.id }, data: { intent: "planned", plannedMatchId: cancelled.id, intentBeforePlan: "want" } });

    const { released } = await reconcilePlans(new Date(), 2);
    expect(released).toBe(1);
    const after = await getIdea(a, wish.idea.id);
    expect(after.intent).toBe("want");
  });
});

/* ── F-08: a retried merge/split/change answers like the first one ─────── */

describe("F-08 retries with the same Idempotency-Key answer success", () => {
  it("a merge repeated after a lost answer returns the merged idea", async () => {
    const into = await saveIdea(a, { kind: "place", title: "Roof", source: person("roof") });
    const from = await saveIdea(a, { kind: "place", title: "Roof bar", source: person("roof bar") });
    const first = await mergeIdeas(a, into.idea.id, from.idea.id, { idempotencyKey: "merge-1" });
    const again = await mergeIdeas(a, into.idea.id, from.idea.id, { idempotencyKey: "merge-1" });
    expect(again.id).toBe(first.id);
    expect(again.sources).toHaveLength(2);
  });

  it("a split repeated after a lost answer returns the same two ideas", async () => {
    const saved = await saveIdea(a, { kind: "place", title: "Two", source: person("one") });
    await saveIdea(a, { kind: "place", title: "Two", source: { kind: "link", provenance: "person", url: "https://two.example/" } }).then(async (second) => {
      await mergeIdeas(a, saved.idea.id, second.idea.id);
    });
    const joined = await getIdea(a, saved.idea.id);
    const moving = [joined.sources[1]!.id];
    const first = await splitIdea(a, saved.idea.id, moving, "Other", { idempotencyKey: "split-1" });
    const again = await splitIdea(a, saved.idea.id, moving, "Other", { idempotencyKey: "split-1" });
    expect(again.split.id).toBe(first.split.id);
    expect(await db.memoryIdea.count({ where: { userId: a, deletedAt: null } })).toBe(2);
  });

  it("two concurrent changes with one key: both answer the idea, it changes once", async () => {
    const saved = await saveIdea(a, { kind: "place", title: "Bar", source: person("bar") });
    const results = await Promise.allSettled([
      setIntent(a, saved.idea.id, "dropped", { idempotencyKey: "intent-1" }),
      setIntent(a, saved.idea.id, "dropped", { idempotencyKey: "intent-1" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await db.memoryIdeaEvent.count({ where: { ideaId: saved.idea.id, type: "intent" } })).toBe(1);
  });
});

/* ── Evidence: account isolation across every entry point (A vs B) ──────── */

describe("isolation: B's known ids act on nothing of A's", () => {
  it("screenshots, ideas, sources, chat tools and planning all answer as for a missing id", async () => {
    await connectLibrary(a, { consentVersion: SCREENSHOT_CONSENT_VERSION, autoImport: true, rangeDays: null });
    await connectLibrary(b, { consentVersion: SCREENSHOT_CONSENT_VERSION, autoImport: true, rangeDays: null });
    const shot = await readyShot(a);
    const idea = await saveIdea(a, { kind: "place", title: "Секрет", placeId: "p-secret", source: { kind: "screenshot", provenance: "person", screenshotItemId: shot } });
    const ideaId = idea.idea.id;
    const sourceId = idea.idea.sources[0]!.id;

    await expect(readItem(b, shot)).rejects.toMatchObject({ code: "not-found" });
    await deleteItem(b, shot);
    expect((await db.screenshotItem.findUniqueOrThrow({ where: { id: shot } })).deletedAt).toBeNull();
    expect((await listItems(b, {})).items).toHaveLength(0);
    for (const tool of ["read_screenshot", "view_screenshot"]) {
      const out = JSON.parse((await executeScreenshotTool(b, tool, { id: shot }, { overBudget: () => false })).result);
      expect(out.error).toBe("not_found");
    }
    const shown = JSON.parse((await executeScreenshotTool(b, "show_screenshots", { items: [{ id: shot, reason: "x" }] })).result);
    expect(shown.error).toBe("not_found");
    const search = JSON.parse((await executeScreenshotTool(b, "search_screenshots", { purpose: "find_saved", query: "Лоза wine bar", keywords: ["Лоза"] }, { embed: async () => Array.from({ length: 1536 }, () => 0.1) })).result);
    expect(search.hits).toHaveLength(0);

    await expect(getIdea(b, ideaId)).rejects.toMatchObject({ code: "not-found" });
    await expect(setUsage(b, ideaId, "own_dates", true)).rejects.toMatchObject({ code: "not-found" });
    await expect(setReason(b, ideaId, "gift", "x")).rejects.toMatchObject({ code: "not-found" });
    await expect(removeSource(b, ideaId, sourceId)).rejects.toMatchObject({ code: "not-found" });
    const bOwn = (await saveIdea(b, { kind: "place", title: "mine", source: person("mine") })).idea.id;
    await expect(mergeIdeas(b, ideaId, bOwn)).rejects.toMatchObject({ code: "not-found" });
    await expect(mergeIdeas(b, bOwn, ideaId)).rejects.toMatchObject({ code: "not-found" });
    await deleteIdea(b, ideaId);
    await expect(saveIdea(b, { kind: "place", title: "steal", source: { kind: "screenshot", provenance: "person", screenshotItemId: shot } })).rejects.toMatchObject({ code: "source-not-found" });
    expect((await listIdeas(b, { query: "Секрет" })).items).toHaveLength(0);
    const viaTool = JSON.parse(await executeMemoryTool(b, "grant_idea_use", { id: ideaId, use: "partner" }));
    expect(viaTool.success).toBe(false);

    const c = (await seedUser({ telegramId: 9103n })).id;
    const theirMatch = await db.match.create({ data: { userAId: a, userBId: c, status: "negotiating" } as never });
    await expect(planningSuggestions(theirMatch.id, b, { city: null })).rejects.toMatchObject({ code: "not-found" });

    const still = await getIdea(a, ideaId);
    expect(still.usage.partner).toBe(false);
    expect(still.sources).toHaveLength(1);
  });
});

/* ── Evidence: disconnect closes everything at once ─────────────────────── */

describe("disconnect: nothing searchable or readable survives the answer", () => {
  it("rows, text, ideas built only on screenshots and search all go in one step", async () => {
    await connectLibrary(a, { consentVersion: SCREENSHOT_CONSENT_VERSION, autoImport: true, rangeDays: null });
    const shot = await readyShot(a);
    const onlyShot = await saveIdea(a, { kind: "place", title: "Только скрин", source: { kind: "screenshot", provenance: "person", screenshotItemId: shot } });
    const both = await saveIdea(a, { kind: "place", title: "Сказано", source: person("сказано") });
    await disconnectLibrary(a);
    const row = await db.screenshotItem.findUniqueOrThrow({ where: { id: shot } });
    expect([row.ocrText, row.title, row.contentHash, row.deletedAt === null]).toEqual([null, null, null, false]);
    await expect(getIdea(a, onlyShot.idea.id)).rejects.toMatchObject({ code: "not-found" });
    expect((await getIdea(a, both.idea.id)).title).toBe("Сказано");
    const out = JSON.parse((await executeScreenshotTool(a, "read_screenshot", { id: shot })).result);
    expect(out.success).toBe(false);
    expect((await listItems(a, {})).items).toHaveLength(0);
  });
});
