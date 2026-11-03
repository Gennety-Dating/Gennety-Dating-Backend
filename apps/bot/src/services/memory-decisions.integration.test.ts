/**
 * The founder's decisions of 2026-11-03 on the audit's findings
 * (docs/architecture/decisions/2026-11-02-screenshots-backend-audit.md), on a
 * real database. Synthetic users only; storage is stubbed, no model is called.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./storage.js")>()),
  createScreenshotSignedUpload: vi.fn(async (path: string) => `https://upload.test/${path}`),
  createScreenshotSignedUrls: vi.fn(async (paths: readonly string[]) => paths.map((p) => `https://signed.test/${p}`)),
}));

const { integrationPrisma: db, seedUser } = await import("../../../../packages/db/src/test-integration.js");
const { env } = await import("../config.js");
const { connectLibrary, deleteItem, disconnectLibrary, reconcile, reserveUpload } = await import("./screenshot-library.js");
const { indexBatch } = await import("../workers/screenshot-library.js");
const { memoryIdeasTick, sendDueReminders } = await import("../workers/memory-ideas.js");
const { pairOverlap, planningSuggestions, reconcilePlans, setReminder } = await import("./memory-planning.js");
const { deleteIdea, getIdea, removeSource, revokePreference, confirmPreference, saveIdea, setUsage } = await import("./memory-ideas.js");
const { SCREENSHOT_CONSENT_VERSION } = await import("@gennety/shared");

const DAY = 24 * 3_600_000;
const HOUR = 3_600_000;
const hash = () => randomUUID().replace(/-/g, "").padEnd(64, "a").slice(0, 64);
const person = (quote: string) => ({ kind: "chat" as const, provenance: "person" as const, quote });
type Mutable = Record<string, unknown>;
const savedEnv: Mutable = {};
const ENV_KEYS = ["TICKET_FEATURE_ENABLED", "SCREENSHOT_LIBRARY_ENABLED", "MEMORY_IDEAS_ENABLED", "SCREENSHOT_LIBRARY_USER_IDS", "MEMORY_IDEAS_USER_IDS"];

let a: string;
let b: string;

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = (env as Mutable)[k];
  await db.$executeRawUnsafe("TRUNCATE TABLE users CASCADE");
  await db.$executeRawUnsafe("TRUNCATE TABLE curated_venues CASCADE");
  a = (await seedUser({ telegramId: 9401n })).id;
  b = (await seedUser({ telegramId: 9402n })).id;
});
afterEach(() => {
  Object.assign(env as Mutable, savedEnv);
});
afterAll(async () => {
  await db.$disconnect();
});

async function catalogPlace(placeId: string): Promise<void> {
  await db.$executeRawUnsafe(`INSERT INTO curated_venues (id, name, lat, lng, place_id, category, address, updated_at) VALUES (gen_random_uuid(), '${placeId}', 50.4, 30.5, '${placeId}', 'cafe', 'addr', NOW())`);
}

/** An idea allowed for own dates, its creation moved to `at`. */
async function allowedIdea(userId: string, title: string, extra: { topic?: string | null; placeId?: string | null }, at: Date): Promise<string> {
  const saved = await saveIdea(userId, { kind: "activity", title, ...extra, source: person(title) });
  await setUsage(userId, saved.idea.id, "own_dates", true);
  await db.memoryIdea.update({ where: { id: saved.idea.id }, data: { createdAt: at } });
  return saved.idea.id;
}

/** A pair that both said yes at `yesAt`. */
async function mutualMatch(status: "negotiating" | "scheduled", yesAt: Date, extra: Record<string, unknown> = {}): Promise<string> {
  const match = await db.match.create({ data: { userAId: a, userBId: b, status, acceptedByA: true, acceptedByB: true, ...extra } as never });
  await db.matchEvent.createMany({
    data: [
      { matchId: match.id, actorId: a, targetId: b, actionType: "ACCEPTED", createdAt: new Date(yesAt.getTime() - 60_000) },
      { matchId: match.id, actorId: b, targetId: a, actionType: "ACCEPTED", createdAt: yesAt },
    ],
  });
  return match.id;
}

/* ── 1. F-03: the probe finds nothing ──────────────────────────────────── */

describe("F-03 shared ideas cannot be probed", () => {
  it("the audit's nine-call probe, run after both said yes, finds nothing", async () => {
    const before = new Date(Date.now() - 2 * HOUR);
    await catalogPlace("gp-loza");
    await allowedIdea(b, "Керамика", { topic: "ceramics" }, before);
    await allowedIdea(b, "Бар Лоза", { placeId: "gp-loza" }, before);
    const match = await mutualMatch("negotiating", new Date(Date.now() - HOUR));

    const probes = [
      ...["jazz", "ceramics", "picnic", "yoga", "wine", "climbing"].map((topic) => ({ topic, placeId: null })),
      ...["gp-1", "gp-loza", "gp-3"].map((placeId) => ({ topic: null, placeId })),
    ];
    let calls = 0;
    const found: string[] = [];
    for (const probe of probes) {
      const label = probe.topic ?? probe.placeId ?? "";
      const s = await saveIdea(a, { kind: "activity", title: `probe ${label}`, topic: probe.topic, placeId: probe.placeId, source: person(`probe ${label}`) });
      await setUsage(a, s.idea.id, "own_dates", true);
      const { shared } = await planningSuggestions(match, a, { city: null });
      calls++;
      if (shared.some((x) => x.ideaId === s.idea.id)) found.push(label);
      await deleteIdea(a, s.idea.id);
    }
    expect(calls).toBe(9);
    expect(found).toEqual([]);
  });

  it("what both saved before the yes still meets: a listed topic and a catalog place", async () => {
    const before = new Date(Date.now() - 2 * HOUR);
    await catalogPlace("gp-loza");
    await allowedIdea(b, "Керамика", { topic: "ceramics" }, before);
    await allowedIdea(b, "Бар Лоза", { placeId: "gp-loza" }, before);
    const mineTopic = await allowedIdea(a, "Гончарка", { topic: "ceramics" }, before);
    const minePlace = await allowedIdea(a, "Лоза", { placeId: "gp-loza" }, before);
    const match = await mutualMatch("negotiating", new Date(Date.now() - HOUR));
    const shared = await pairOverlap(match, a);
    expect(shared.map((s) => [s.ideaId, s.kind]).sort()).toEqual([[minePlace, "same_place"], [mineTopic, "same_kind"]].sort());
  });

  it("a free-text topic or a place the catalog does not know never takes part", async () => {
    const before = new Date(Date.now() - 2 * HOUR);
    await allowedIdea(b, "Колесо", { topic: "pottery-wheel" }, before);
    await allowedIdea(b, "Секретное место", { placeId: "not-in-catalog" }, before);
    await allowedIdea(a, "Колесо", { topic: "pottery-wheel" }, before);
    await allowedIdea(a, "Секретное место", { placeId: "not-in-catalog" }, before);
    const match = await mutualMatch("negotiating", new Date(Date.now() - HOUR));
    expect(await pairOverlap(match, a)).toEqual([]);
  });
});

/* ── 3. The Date Ticket step ───────────────────────────────────────────── */

describe("ticket gate: shared ideas and suggestions only once the ticket step is done", () => {
  it("nothing while pending or partial; both once it is completed; tickets off changes nothing", async () => {
    (env as Mutable).TICKET_FEATURE_ENABLED = true;
    const before = new Date(Date.now() - 2 * HOUR);
    await allowedIdea(b, "Керамика", { topic: "ceramics" }, before);
    const mine = await allowedIdea(a, "Гончарка", { topic: "ceramics" }, before);
    const match = await mutualMatch("negotiating", new Date(Date.now() - HOUR), { ticketStatus: "pending", ticketExpiresAt: new Date(Date.now() + DAY) });

    for (const ticketStatus of ["pending", "partial"]) {
      await db.match.update({ where: { id: match }, data: { ticketStatus } });
      const planning = await planningSuggestions(match, a, { city: null });
      expect(planning.suggestions).toEqual([]);
      expect(planning.shared).toEqual([]);
      expect(await pairOverlap(match, a)).toEqual([]);
    }
    await db.match.update({ where: { id: match }, data: { ticketStatus: "completed", ticketExpiresAt: null } });
    const done = await planningSuggestions(match, a, { city: null });
    expect(done.suggestions.map((s) => s.ideaId)).toContain(mine);
    expect(done.shared.map((s) => s.ideaId)).toEqual([mine]);

    (env as Mutable).TICKET_FEATURE_ENABLED = false;
    await db.match.update({ where: { id: match }, data: { ticketStatus: "pending" } });
    expect((await planningSuggestions(match, a, { city: null })).shared.map((s) => s.ideaId)).toEqual([mine]);
  });
});

/* ── 5. Deleting again after signing in again ──────────────────────────── */

describe("delete endpoints answer a late repeat like the first time", () => {
  it("screenshot, library, idea, source, reminder and preference", async () => {
    await connectLibrary(a, { consentVersion: SCREENSHOT_CONSENT_VERSION, autoImport: true, rangeDays: null });
    const shot = (await reserveUpload(a, { generation: 1, source: "manual", sourceKey: "s1", contentHash: hash(), capturedAt: null, ocrText: null })).item.id;
    const idea = await saveIdea(a, { kind: "place", title: "Two", source: person("one") });
    const second = await saveIdea(a, { kind: "place", title: "Other", source: person("two") });
    const pref = await confirmPreference(a, "ambience", "quiet");

    for (let i = 0; i < 2; i++) {
      await expect(deleteItem(a, shot)).resolves.toBeUndefined();
      await expect(deleteIdea(a, idea.idea.id)).resolves.toBeUndefined();
      await expect(removeSource(a, second.idea.id, second.idea.sources[0]!.id)).resolves.toEqual({ ideaDeleted: true });
      await expect(revokePreference(a, pref.id)).resolves.toBeUndefined();
    }
    for (let i = 0; i < 2; i++) expect((await disconnectLibrary(a)).status).toBe("off");
    // Someone else's id is still a 404, not a quiet success.
    await expect(removeSource(b, second.idea.id, second.idea.sources[0]!.id)).rejects.toMatchObject({ code: "not-found" });
  });
});

/* ── 6. An edited screenshot keeps its idea ────────────────────────────── */

describe("a new version of a screenshot carries its idea over", () => {
  it("the idea moves to the new version and is not closed by the sweep", async () => {
    await connectLibrary(a, { consentVersion: SCREENSHOT_CONSENT_VERSION, autoImport: true, rangeDays: null });
    const first = (await reserveUpload(a, { generation: 1, source: "auto", sourceKey: "photo-1", contentHash: hash(), capturedAt: null, ocrText: null })).item.id;
    await db.screenshotItem.update({ where: { id: first }, data: { state: "ready" } });
    const idea = await saveIdea(a, { kind: "place", title: "Крыша", source: { kind: "screenshot", provenance: "person", screenshotItemId: first } });
    const edited = (await reserveUpload(a, { generation: 1, source: "auto", sourceKey: "photo-1", contentHash: hash(), capturedAt: null, ocrText: null })).item.id;
    expect(edited).not.toBe(first);
    await memoryIdeasTick();
    const after = await getIdea(a, idea.idea.id);
    expect(after.title).toBe("Крыша");
    expect(after.sources.map((s) => s.screenshotId)).toEqual([edited]);
  });
});

/* ── 9. B-5: reconcile touches only what the automatic import brought ──── */

describe("reconcile only removes automatic imports of this generation", () => {
  it("a hand-picked screenshot with the same key stays", async () => {
    await connectLibrary(a, { consentVersion: SCREENSHOT_CONSENT_VERSION, autoImport: true, rangeDays: null });
    const picked = (await reserveUpload(a, { generation: 1, source: "manual", sourceKey: "k-manual", contentHash: hash(), capturedAt: null, ocrText: null })).item.id;
    const auto = (await reserveUpload(a, { generation: 1, source: "auto", sourceKey: "k-auto", contentHash: hash(), capturedAt: null, ocrText: null })).item.id;
    const { removed } = await reconcile(a, 1, ["k-manual", "k-auto"]);
    expect(removed).toBe(1);
    expect((await db.screenshotItem.findUniqueOrThrow({ where: { id: picked } })).deletedAt).toBeNull();
    expect((await db.screenshotItem.findUniqueOrThrow({ where: { id: auto } })).deletedAt).not.toBeNull();
  });
});

/* ── 10. Per-user preview in the jobs ──────────────────────────────────── */

describe("per-user preview: the jobs act only for listed people", () => {
  it("the indexer reads only a listed person's screenshots", async () => {
    for (const userId of [a, b]) {
      await connectLibrary(userId, { consentVersion: SCREENSHOT_CONSENT_VERSION, autoImport: true, rangeDays: null });
      await db.screenshotItem.create({
        data: { id: randomUUID(), userId, generation: 1, source: "auto", sourceKey: `q-${userId}`, contentHash: hash(), storagePath: `${userId}/x.jpg`, state: "queued", nextAttemptAt: new Date(0) },
      });
    }
    const read = vi.fn(async () => null);
    const download = vi.fn(async (path: string) => ({ ok: false as const, reason: "missing" as const, path }));
    await indexBatch({ users: [a], download: download as never, read });
    expect(download).toHaveBeenCalledTimes(1);
    expect(String(download.mock.calls[0]![0])).toContain(a);
    await indexBatch({ users: [], download: download as never, read });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("reminders and planning go only to listed people", async () => {
    const at = new Date(Date.now() + 10 * DAY);
    for (const userId of [a, b]) {
      const s = await saveIdea(userId, { kind: "event", title: "Концерт", eventAt: at, source: person("концерт") });
      await setReminder(userId, s.idea.id);
    }
    const sentTo: string[] = [];
    const send = async (userId: string) => { sentTo.push(userId); return true; };
    await sendDueReminders(new Date(at.getTime() - DAY), { send: send as never, quiet: () => false, users: [a] });
    expect(sentTo).toEqual([a]);

    await allowedIdea(a, "Место A", { placeId: "gp-plan" }, new Date());
    await allowedIdea(b, "Место B", { placeId: "gp-plan" }, new Date());
    await db.match.create({ data: { userAId: a, userBId: b, status: "scheduled", venuePlaceId: "gp-plan", agreedTime: new Date(Date.now() + DAY) } as never });
    expect((await reconcilePlans(new Date(), 200, [a])).planned).toBe(1);
    expect(await db.memoryIdea.count({ where: { userId: b, plannedMatchId: { not: null } } })).toBe(0);
  });

  it("the tick does nothing for ideas when the flag is off and the list empty", async () => {
    Object.assign(env as Mutable, { MEMORY_IDEAS_ENABLED: false, MEMORY_IDEAS_USER_IDS: [] });
    const at = new Date(Date.now() + DAY);
    const s = await saveIdea(a, { kind: "event", title: "Скоро", eventAt: at, source: person("скоро") });
    await setReminder(a, s.idea.id);
    await db.memoryReminder.updateMany({ where: { ideaId: s.idea.id }, data: { dueAt: new Date(Date.now() - HOUR) } });
    await memoryIdeasTick();
    expect((await db.memoryReminder.findFirstOrThrow({ where: { ideaId: s.idea.id } })).state).toBe("pending");
  });
});
