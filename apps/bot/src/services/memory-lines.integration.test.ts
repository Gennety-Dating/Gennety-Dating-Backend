import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@gennety/db";
import { isSensitivePreference, memoryKindOfScreenshot, memoryVibeQuestion, SCREENSHOT_KINDS, VENUE_AMBIENCES, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { sendDueReminders } from "../workers/memory-ideas.js";
import { executeScreenshotTool } from "./chat-screenshots.js";
import { executeMemoryTool } from "./chat-memory.js";
import { giftIdeasIn, resolveWishlistCard, type ResolveDeps, type WishlistCardItem } from "./chat-wishlist.js";
import { applyEventCheck, dateMemo, ideaMap, pairOverlap, planningSuggestions, reconcilePlans, setEventDate, setReminder, styleReferenceTexts, suggestionsWithPreferences, vibeQuestion, wantedPlaceIds } from "./memory-planning.js";
import { confirmPreference, getIdea, listPreferences, reasonQuestions, saveIdea, setUsage } from "./memory-ideas.js";
import { stylePicksHash } from "./style-picks/service.js";
import { buildStyleDigest, type StyleDigestSource } from "./style-picks/digest.js";
import { deleteWishlistItem } from "./wishlist.js";

/**
 * The founder's nine kinds of saved thing, and six whole journeys, on a real
 * database and through the agent's real tools. No model is called: each tool call
 * is what the model would send, and the consent gate is tested in `chat-consent`.
 */

const person = (quote: string) => ({ kind: "chat" as const, provenance: "person" as const, quote });
const tool = async (user: string, name: string, args: unknown = {}) => JSON.parse(await executeMemoryTool(user, name, args)) as Record<string, any>;

async function newUser(): Promise<string> {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(`INSERT INTO users (id, telegram_id, created_at, updated_at) VALUES ('${id}'::uuid, ${Math.floor(Math.random() * 1e12)}, NOW(), NOW())`);
  return id;
}

async function shot(userId: string, category: string, title: string): Promise<string> {
  const id = randomUUID();
  await prisma.screenshotItem.create({
    data: { id, userId, generation: 1, source: "manual", sourceKey: `k-${id}`, contentHash: id, storagePath: `${userId}/${id}`, state: "ready", title, category },
  });
  return id;
}

// The pair's yes comes after every idea these tests save: only ideas saved before it count (decision 2026-11-03).
const newMatch = async (a: string, b: string, data: Record<string, unknown> = {}) =>
  (await prisma.match.create({ data: { userAId: a, userBId: b, status: "negotiating_venue", createdAt: new Date(Date.now() + 60_000), ...data } as never, select: { id: true } })).id;

beforeAll(async () => {
  await prisma.$connect();
  (env as { MEMORY_IDEAS_ENABLED: boolean }).MEMORY_IDEAS_ENABLED = true;
  (env as { SCREENSHOT_LIBRARY_ENABLED: boolean }).SCREENSHOT_LIBRARY_ENABLED = true;
});

describe("the nine lines", () => {
  it("every screenshot kind has an idea kind", () => {
    expect(SCREENSHOT_KINDS.map(memoryKindOfScreenshot)).toEqual(["place", "event", "activity", "outfit", "gift", "food", "aesthetic", "culture", "note", "note"]);
  });

  it("1 place: from screenshot to idea with its reason, kind and title from the source", async () => {
    const u = await newUser();
    const id = await shot(u, "place", "Лоза");
    const out = await tool(u, "save_idea", { screenshotId: id, topic: "Wine bar", reason: "this_place" });
    expect(out.success).toBe(true);
    expect(out.idea).toMatchObject({ kind: "place", title: "Лоза", topic: "wine", reason: "this_place", intent: "want" });
    expect(out.idea.uses.onlyForMe).toBe(true);
  });

  it("1 place: another person's screenshot saves nothing", async () => {
    const [u, other] = [await newUser(), await newUser()];
    const out = await tool(u, "save_idea", { screenshotId: await shot(other, "place", "Лоза"), title: "x", kind: "place" });
    expect(out).toMatchObject({ success: false, error: "source-not-found" });
  });

  it("2 event: a check on a saved idea lands on it; on someone else's id it does not", async () => {
    const [u, other] = [await newUser(), await newUser()];
    const { idea } = await saveIdea(u, { kind: "event", title: "Jazz", source: person("хочу на джаз") });
    const passed = JSON.parse((await executeScreenshotTool(u, "check_event", { name: "Jazz", city: "Kyiv", date: "2020-01-01", idea_id: idea.id })).result);
    expect(passed).toMatchObject({ status: "outdated", ideaNowSays: "outdated" });
    expect((await getIdea(u, idea.id)).eventCheck).toBe("outdated");
    const foreign = JSON.parse((await executeScreenshotTool(other, "check_event", { name: "Jazz", city: "Kyiv", date: "2020-01-01", idea_id: idea.id })).result);
    expect(foreign.ideaNowSays).toBeUndefined();
  });

  it("2 event: only the search's verdict is written, an outage leaves the last state", async () => {
    const u = await newUser();
    const { idea } = await saveIdea(u, { kind: "event", title: "Show", source: person("хочу") });
    expect(await applyEventCheck(u, idea.id, { status: "confirmed", reason: "source", startDate: "2099-05-01" })).toBe("confirmed");
    const after = await getIdea(u, idea.id);
    expect(after).toMatchObject({ eventCheck: "confirmed", eventAt: "2099-05-01T12:00:00.000Z" });
    expect(await applyEventCheck(u, idea.id, { status: "unverified", reason: "unavailable" })).toBeNull();
    expect((await getIdea(u, idea.id)).eventCheck).toBe("confirmed");
    expect(await applyEventCheck(u, idea.id, { status: "unverified", reason: "no_source" })).toBe("unknown");
    expect(await applyEventCheck(u, idea.id, { status: "confirmed", reason: "source", startDate: "2099-05-01", endDate: "2099-06-01" })).toBe("unknown");
    expect((await getIdea(u, idea.id)).eventAt).toBeNull();
  });

  it("3 activity: a format they stated reaches the planning vibe and venue chips", async () => {
    const [a, b] = [await newUser(), await newUser()];
    const match = await newMatch(a, b);
    const out = await tool(a, "confirm_preference", { facet: "experience", value: "playful_activity" });
    expect(out.success).toBe(true);
    const planning = await planningSuggestions(match, a, { city: null });
    expect(planning.vibeIds.experiences).toEqual(["playful_activity"]);
    const chips = await suggestionsWithPreferences(a, [{ experiences: ["coffee_treats"], ambiences: [], formats: [] }]);
    expect(chips[0]!.experiences).toEqual(["playful_activity"]);
    expect(chips).toHaveLength(2);
  });

  it("3 activity: a confirmed mood orders suggestions by the catalog's tags and drops nothing", async () => {
    const [a, b] = [await newUser(), await newUser()];
    const match = await newMatch(a, b);
    const placeA = `pa-${randomUUID()}`;
    const placeB = `pb-${randomUUID()}`;
    await prisma.curatedVenue.createMany({ data: [
      { placeId: placeA, name: "Loud", address: "a", category: "bar", lat: 1, lng: 1, vibeTags: ["lively"] },
      { placeId: placeB, name: "Calm", address: "a", category: "cafe", lat: 1, lng: 1, vibeTags: ["quiet"] },
    ] as never });
    const save = async (title: string, placeId: string) => {
      const { idea } = await saveIdea(a, { kind: "place", title, placeId, intent: "want", source: person(title) });
      await setUsage(a, idea.id, "own_dates", true);
    };
    await save("Calm", placeB);
    await save("Loud", placeA); // the newest, so first without a preference
    expect((await planningSuggestions(match, a, { city: null })).suggestions.map((s) => s.title)).toEqual(["Loud", "Calm"]);
    await confirmPreference(a, "ambience", "quiet");
    expect((await planningSuggestions(match, a, { city: null })).suggestions.map((s) => s.title)).toEqual(["Calm", "Loud"]);
  });

  it("4 outfit: only a look can guide Style Picks, and the set's hash follows", async () => {
    const u = await newUser();
    const look = await tool(u, "save_idea", { screenshotId: await shot(u, "outfit", "Camel coat"), topic: "coat" });
    expect(look.idea.reason).toBeNull();
    expect(await styleReferenceTexts(u)).toEqual([]);
    const food = await saveIdea(u, { kind: "food", title: "Pasta", source: person("паста") });
    expect((await tool(u, "use_style_reference", { id: food.idea.id })).error).toBe("not_a_look");
    expect((await tool(u, "use_style_reference", { id: look.idea.id })).idea.reason).toBe("style");
    expect(await styleReferenceTexts(u)).toEqual(["Camel coat"]);
  });

  it("5 gift: for whom keeps it out of every wider use", async () => {
    const u = await newUser();
    const saved = await tool(u, "save_idea", { screenshotId: await shot(u, "item", "Пионы") });
    expect(saved.idea.kind).toBe("gift");
    const gift = await tool(u, "update_idea", { id: saved.idea.id, reason: "gift", recipient: "сестра" });
    expect(gift.idea).toMatchObject({ reason: "gift", recipient: "сестра" });
    expect((await tool(u, "grant_idea_use", { id: saved.idea.id, use: "own_dates" })).error).toBe("not-own-wish");
    expect((await tool(u, "grant_idea_use", { id: saved.idea.id, use: "partner" })).error).toBe("use-unavailable");
    expect(await giftIdeasIn(u, { items: [{ title: "Пионы", ideaId: saved.idea.id }] })).toEqual(["Пионы"]);
  });

  it("6 food: taste is kept; a diet or an allergy is refused in every language, on every path", async () => {
    const u = await newUser();
    expect((await tool(u, "confirm_preference", { facet: "food", value: "обожаю суши" })).success).toBe(true);
    for (const value of ["аллергия на орехи", "я вегетарианец", "vegan", "lactose free", "алергія на горіхи", "дієта", "Laktoseintoleranz", "vegetarisch", "koszerne", "alergia", "cukrzyca", "w ciąży", "I am gay", "мусульманин", "Я ГЕЙ"]) {
      const out = await tool(u, "confirm_preference", { facet: "food", value });
      expect(out, value).toMatchObject({ success: false, error: "sensitive-value" });
    }
    await expect(confirmPreference(u, "food", "halal only")).rejects.toThrow("sensitive-value");
    expect((await listPreferences(u)).map((p) => p.value)).toEqual(["обожаю суши"]);
    for (const value of ["гейзеры", "Gaya street", "dieting-free bar".replace("dieting-free ", ""), "суши", "wine", "pasta"]) {
      expect(isSensitivePreference(value), value).toBe(false);
    }
  });

  it("7 aesthetic: a picture alone says nothing; the question is deterministic in five languages", async () => {
    const u = await newUser();
    await tool(u, "save_idea", { screenshotId: await shot(u, "aesthetic", "Room") });
    expect(await vibeQuestion(u, "ru")).toBeNull();
    expect(await listPreferences(u)).toEqual([]);
    await tool(u, "save_idea", { screenshotId: await shot(u, "aesthetic", "Lake") });
    const question = await vibeQuestion(u, "ru");
    expect(question).toEqual(await vibeQuestion(u, "ru"));
    expect(question!.facet).toBe("ambience");
    expect(question!.options.map((o) => o.id)).toEqual([...VENUE_AMBIENCES]);
    await confirmPreference(u, "ambience", "quiet");
    expect((await vibeQuestion(u, "ru"))!.facet).toBe("experience");
    await confirmPreference(u, "experience", "walk_view");
    expect(await vibeQuestion(u, "ru")).toBeNull();
    for (const lang of ["en", "ru", "uk", "de", "pl"] as Language[]) {
      for (const facet of ["ambience", "experience"] as const) {
        const q = memoryVibeQuestion(facet, lang);
        expect(q.title.length).toBeGreaterThan(0);
        expect(q.options.every((o) => o.label.length > 0)).toBe(true);
        expect(q.options.map((o) => o.id)).not.toContain("surprise_me");
      }
    }
  });

  it("8 culture: stays an idea; matching needs its own grant", async () => {
    const u = await newUser();
    const book = await tool(u, "save_idea", { screenshotId: await shot(u, "media", "Мастер и Маргарита"), topic: "bulgakov" });
    expect(book.idea).toMatchObject({ kind: "culture", topic: "bulgakov" });
    expect(book.idea.uses.matching).toBe(false);
    expect(book.idea.reason).toBeNull();
  });

  it("9 text: a stated wish is a preference; skipping a question ends it", async () => {
    const u = await newUser();
    const saved = await tool(u, "save_idea", { screenshotId: await shot(u, "text", "Note") });
    expect(saved.idea.kind).toBe("note");
    expect((await tool(u, "confirm_preference", { facet: "wish", value: "хочу больше активных свиданий" })).success).toBe(true);
    expect((await tool(u, "idea_questions")).ideas.map((i: { id: string }) => i.id)).toContain(saved.idea.id);
    await tool(u, "skip_idea_question", { id: saved.idea.id });
    expect((await reasonQuestions(u, new Date(Date.now() + 90 * 24 * 3_600_000))).map((i) => i.id)).not.toContain(saved.idea.id);
  });

  it("nonsense from a model reaches no row", async () => {
    const u = await newUser();
    expect((await tool(u, "save_idea", { kind: "weapon", title: "x", quote: "y" })).error).toBe("bad_kind");
    expect((await tool(u, "confirm_preference", { facet: "secret", value: "x" })).error).toBe("bad_facet");
    const { idea } = await saveIdea(u, { kind: "place", title: "p", source: person("p") });
    expect((await tool(u, "grant_idea_use", { id: idea.id, use: "sell" })).error).toBe("no_use");
    expect((await tool(u, "update_idea", { id: idea.id, reason: "because" })).error).toBe("nothing_to_change");
  });
});

describe("six journeys", () => {
  it("restaurant → reason → idea → map → suggestion → date → impression", async () => {
    const [u, partner] = [await newUser(), await newUser()];
    const place = `p-${randomUUID()}`;
    await prisma.curatedVenue.create({ data: { placeId: place, name: "Лоза", address: "a", category: "bar", lat: 50.1, lng: 30.1, vibeTags: [] } as never });
    const saved = await tool(u, "save_idea", { screenshotId: await shot(u, "place", "Лоза"), reason: "this_place" });
    await prisma.memoryIdea.update({ where: { id: saved.idea.id }, data: { placeId: place } });
    expect((await ideaMap(u)).points.map((p) => p.placeId)).toEqual([place]);
    expect(await wantedPlaceIds(u)).toEqual(new Set()); // saved is not allowed
    await tool(u, "grant_idea_use", { id: saved.idea.id, use: "own_dates" });
    expect(await wantedPlaceIds(u)).toEqual(new Set([place]));

    const match = await newMatch(u, partner, { status: "negotiating_venue" });
    const planning = await tool(u, "planning_ideas");
    expect(planning.suggestions.map((s: { ideaId: string }) => s.ideaId)).toEqual([saved.idea.id]);
    expect(planning.note).toMatch(/never say what the partner saved/);

    expect((await tool(u, "record_impression", { place_rating: "liked" })).error).toBe("not-attended");
    await prisma.match.update({ where: { id: match }, data: { status: "scheduled", venuePlaceId: place, agreedTime: new Date(Date.now() + 3_600_000), venueName: "Лоза" } });
    await reconcilePlans();
    expect((await getIdea(u, saved.idea.id)).intent).toBe("planned");

    await prisma.match.update({ where: { id: match }, data: { status: "completed", dateAttendedA: true } });
    const later = await saveIdea(u, { kind: "activity", title: "Керамика", intent: "want", source: person("керамика") });
    await setUsage(u, later.idea.id, "own_dates", true);
    const said = await tool(u, "record_impression", { place_rating: "liked", format_rating: "neutral", repeat_format: true });
    expect(said).toMatchObject({ success: true, recorded: "Лоза" });
    expect(said.next.map((n: { title: string }) => n.title)).toEqual(["Керамика"]);
    expect((await getIdea(u, saved.idea.id)).intent).toBe("tried");
    const row = await prisma.memoryImpression.findFirstOrThrow({ where: { userId: u, matchId: match } });
    expect(row).toMatchObject({ placeRating: "liked", formatRating: "neutral", repeatFormat: true, ideaId: saved.idea.id });
    // Nothing about it reaches the partner, whose side never went on record.
    expect((await tool(partner, "record_impression", { place_rating: "liked" })).error).toBe("not-attended");
    expect((await dateMemo(match, partner)).ideas).toEqual([]);
  });

  it("two sources → overlap → the partner's sources are not revealed", async () => {
    const [a, b] = [await newUser(), await newUser()];
    const match = await newMatch(a, b);
    const shotId = await shot(a, "activity", "Лепка");
    const first = await tool(a, "save_idea", { screenshotId: shotId, topic: "ceramics" });
    const second = await saveIdea(b, { kind: "activity", title: "Секретная студия Глина", topic: "ceramics", intent: "want", source: { kind: "link", provenance: "person", url: "https://glina.ua/secret" } });
    expect(await pairOverlap(match, a)).toEqual([]);
    await tool(a, "grant_idea_use", { id: first.idea.id, use: "own_dates" });
    await setUsage(b, second.idea.id, "own_dates", true);
    const seen = await tool(a, "planning_ideas");
    expect(seen.shared.map((s: { label: string }) => s.label)).toEqual(["Лепка"]);
    const text = JSON.stringify(seen);
    for (const secret of ["Секретная", "Глина", "glina.ua", second.idea.id, b]) expect(text).not.toContain(secret);
  });

  it("gift → sister → no influence anywhere", async () => {
    const [u, partner] = [await newUser(), await newUser()];
    const match = await newMatch(u, partner);
    const saved = await tool(u, "save_idea", { title: "Шарф", kind: "gift", topic: "scarf", quote: "хочу подарить сестре", reason: "gift", recipient: "сестра" });
    expect(saved.idea.reason).toBe("gift");
    await saveIdea(partner, { kind: "gift", title: "Шарф", topic: "scarf", intent: "want", source: person("шарф") });
    const planning = await planningSuggestions(match, u, { city: null });
    expect(planning.suggestions).toEqual([]);
    expect(planning.shared).toEqual([]);
    expect((await tool(u, "grant_idea_use", { id: saved.idea.id, use: "own_dates" })).error).toBe("not-own-wish");
    expect((await tool(u, "grant_idea_use", { id: saved.idea.id, use: "matching" })).error).toBe("use-unavailable");
    const profile = await prisma.memoryPreference.count({ where: { userId: u } });
    expect(profile).toBe(0);
  });

  it("reference → Style Picks → hash changes, words only", async () => {
    const u = await newUser();
    const look = await tool(u, "save_idea", { screenshotId: await shot(u, "outfit", "Чёрное платье") });
    await tool(u, "use_style_reference", { id: look.idea.id });
    const source: StyleDigestSource = {
      gender: "female", preference: "men", age: 25, answers: [], places: [{ category: "bar", vibeTags: ["quiet"] }],
      profile: { appearanceTags: null, energyAxis: 0.1, orientationAxis: 0.2, socialRole: null, anchorTags: ["jazz"], hobbies: ["running"], psychologicalSummary: null },
    };
    const bare = buildStyleDigest(source);
    const withLook = buildStyleDigest({ ...source, references: await styleReferenceTexts(u) });
    if (!bare || !withLook) throw new Error("digest too thin for this test");
    expect(withLook.references).toEqual(["Чёрное платье"]);
    expect(stylePicksHash("ru", withLook, [])).not.toBe(stylePicksHash("ru", bare, []));
    await tool(u, "update_idea", { id: look.idea.id, intent: "dropped" });
    expect(await styleReferenceTexts(u)).toEqual([]);
  });

  it("preference → permission → revocation", async () => {
    const u = await newUser();
    await prisma.profile.create({ data: { userId: u, embeddingDirty: false } as never });
    const pref = (await tool(u, "confirm_preference", { facet: "ambience", value: "quiet" })).preference;
    expect(pref.usage).toEqual({ ownDates: true, matching: false });
    const granted = await tool(u, "grant_preference_matching", { id: pref.id });
    expect(granted.preference.usage.matching).toBe(true);
    // Confirming again turns matching off, and the vector has to hear it.
    await prisma.profile.updateMany({ where: { userId: u }, data: { embeddingDirty: false } });
    const again = await tool(u, "confirm_preference", { facet: "ambience", value: "quiet" });
    expect(again.preference.usage.matching).toBe(false);
    expect((await prisma.profile.findUniqueOrThrow({ where: { userId: u }, select: { embeddingDirty: true } })).embeddingDirty).toBe(true);
    await tool(u, "revoke_preference", { id: pref.id });
    expect(await listPreferences(u)).toEqual([]);
    expect(await suggestionsWithPreferences(u, [])).toEqual([]);
  });

  it("date → one reminder → moved", async () => {
    const u = await newUser();
    const { idea } = await saveIdea(u, { kind: "event", title: "Концерт", intent: "want", source: person("концерт") });
    await setUsage(u, idea.id, "own_dates", true);
    const at = new Date(Date.now() + 2 * 24 * 3_600_000);
    await setEventDate(u, idea.id, at, null, "confirmed");
    await setReminder(u, idea.id);
    // A repeat check of the same date keeps the one reminder.
    await setEventDate(u, idea.id, at, null, "confirmed");
    expect(await prisma.memoryReminder.count({ where: { ideaId: idea.id, state: "pending" } })).toBe(1);
    // Cancel, then asking again really brings it back.
    await tool(u, "set_idea_reminder", { id: idea.id, on: false });
    expect(await prisma.memoryReminder.count({ where: { ideaId: idea.id, state: "pending" } })).toBe(0);
    await setReminder(u, idea.id);
    expect(await prisma.memoryReminder.count({ where: { ideaId: idea.id, state: "pending" } })).toBe(1);

    const moved = new Date(at.getTime() + 24 * 3_600_000);
    await setEventDate(u, idea.id, moved, null, "confirmed");
    const pending = await prisma.memoryReminder.findMany({ where: { ideaId: idea.id, state: "pending" } });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.dedupeKey).toContain(moved.toISOString());

    const send = vi.fn(async () => undefined);
    const when = new Date(moved.getTime() - 3_600_000);
    expect(await sendDueReminders(when, { send: send as never, quiet: () => false })).toBe(1);
    expect(await sendDueReminders(when, { send: send as never, quiet: () => false })).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    // Over: nothing further, and a re-read of the sent occasion does not revive it.
    await applyEventCheck(u, idea.id, { status: "outdated", reason: "source_says_over" });
    await setEventDate(u, idea.id, moved, null, "confirmed");
    expect(await sendDueReminders(when, { send: send as never, quiet: () => false })).toBe(0);
  });
});

describe("wishlist bridge", () => {
  const item = (over: Partial<WishlistCardItem> = {}): WishlistCardItem => ({
    key: "i1", title: "Пионы", brand: null, category: "flowers", note: null, photoPath: null, remoteImageUrl: null, productUrl: null, priceBand: null, source: "text", ...over,
  });
  const deps = (card: unknown): ResolveDeps => ({
    findRow: async () => ({ attachment: card }),
    saveCard: async () => undefined,
    countItems: async () => 0,
    existingItems: async () => [],
    copyChatPhoto: async () => null,
    addItems: async (userId, inputs) => {
      const rows = await Promise.all(inputs.map((i) => prisma.wishlistItem.create({ data: { userId, category: i.category, title: i.title, source: "text" } as never })));
      return { ok: true, items: rows as never };
    },
  });

  it("a tap adds a wishlist source to the idea; removing the position takes it back and keeps a sourced idea", async () => {
    const u = await newUser();
    const { idea } = await saveIdea(u, { kind: "gift", title: "Пионы", intent: "want", source: person("хочу пионы") });
    const card = { kind: "wishlist_proposal", state: "open", items: [item({ ideaId: idea.id })], savedKeys: [], resolvedAt: null };
    const done = await resolveWishlistCard(u, randomUUID(), { action: "save", keys: ["i1"] }, deps(card));
    expect(done.ok).toBe(true);
    const after = await getIdea(u, idea.id);
    expect(after.sources.map((s) => s.kind)).toEqual(["chat", "wishlist"]);
    const wishlistId = after.sources[1]!.wishlistItemId as string;
    expect(await deleteWishlistItem(u, wishlistId)).toBe(true);
    expect((await getIdea(u, idea.id)).sources.map((s) => s.kind)).toEqual(["chat"]);
  });

  it("no idea named: the tap makes one; removing its only source closes it", async () => {
    const u = await newUser();
    const card = { kind: "wishlist_proposal", state: "open", items: [item({ title: "Santal", category: "perfume" })], savedKeys: [], resolvedAt: null };
    await resolveWishlistCard(u, randomUUID(), { action: "save", keys: ["i1"] }, deps(card));
    const idea = await prisma.memoryIdea.findFirstOrThrow({ where: { userId: u, title: "Santal" }, include: { sources: true } });
    expect(idea.kind).toBe("gift");
    await deleteWishlistItem(u, idea.sources[0]!.wishlistItemId as string);
    expect((await prisma.memoryIdea.findUniqueOrThrow({ where: { id: idea.id } })).deletedAt).not.toBeNull();
  });
});

describe("plans follow the date", () => {
  it("a date whose place moved releases the idea, and moving back plans it again", async () => {
    const [u, partner] = [await newUser(), await newUser()];
    const place = `m-${randomUUID()}`;
    const { idea } = await saveIdea(u, { kind: "place", title: "Bar", placeId: place, intent: "want", source: person("bar") });
    await setUsage(u, idea.id, "own_dates", true);
    const match = await newMatch(u, partner, { status: "scheduled", venuePlaceId: place, agreedTime: new Date(Date.now() + 3_600_000) });
    await reconcilePlans();
    expect((await getIdea(u, idea.id)).intent).toBe("planned");
    await prisma.match.update({ where: { id: match }, data: { venuePlaceId: `other-${place}` } });
    await reconcilePlans();
    expect((await getIdea(u, idea.id)).intent).toBe("want");
    await prisma.match.update({ where: { id: match }, data: { venuePlaceId: place } });
    await reconcilePlans();
    expect((await getIdea(u, idea.id)).intent).toBe("planned");
  });
});
