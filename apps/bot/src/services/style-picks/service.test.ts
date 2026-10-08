import { describe, expect, it, vi } from "vitest";
import { getStylePicks, type CachedSet, type StylePicksDeps } from "./service.js";
import type { RawStylePicks } from "./validate.js";
import { item, source } from "./__fixtures__/fixtures.js";

const USER = "11111111-1111-4111-8111-111111111111";
const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 86_400_000;

const catalog = [
  item("s1", { gender: "men", tags: ["polished", "calm"] }),
  item("s2", { tags: ["warm"] }),
  item("a1", {
    category: "accents",
    gender: "men",
    badges: [
      {
        kind: "seenOn",
        text: { en: "Seen in X", ru: "В кадре X", uk: "У кадрі X", de: "In X", pl: "W X" },
        sourceUrl: "https://example.com/x",
      },
    ],
  }),
  item("a2", { category: "accents" }),
  item("g1", { category: "grooming" }),
  item("g2", { category: "grooming" }),
  item("w1", { gender: "women" }),
];

const answer: RawStylePicks = {
  basis: ["calm evenings", "polished"],
  picks: [
    { id: "s1", fitScore: 92, reason: "Your calm, polished evenings.", signals: ["calm tempo"], personalSignalCited: true },
    { id: "s2", fitScore: 70, reason: "Warm for lounges you go to.", signals: ["lounges"], personalSignalCited: true },
    { id: "a1", fitScore: 88, reason: "Matches your tennis-and-film mix.", signals: ["tennis"], personalSignalCited: true },
    { id: "a2", fitScore: 60, reason: "Easy everyday.", signals: [], personalSignalCited: false },
    { id: "g1", fitScore: 75, reason: "For night-owl mornings.", signals: ["night owl"], personalSignalCited: true },
    { id: "g2", fitScore: 65, reason: "Small and tidy.", signals: [], personalSignalCited: false },
  ],
};

function deps(over: Partial<StylePicksDeps> = {}, store: { set: CachedSet | null } = { set: null }) {
  const callModel = vi.fn(async () => answer);
  const d: StylePicksDeps = {
    loadSource: async () => ({ source: source(), language: "uk" }),
    loadCatalog: async () => catalog,
    callModel,
    latestSet: async () => store.set,
    saveSet: vi.fn(async (_userId: string, set: Omit<CachedSet, "generatedAt">) => {
      const saved: CachedSet = { ...set, generatedAt: new Date(NOW) };
      store.set = saved;
      return saved;
    }),
    now: () => NOW,
    ...over,
  };
  return { d, callModel, store };
}

describe("getStylePicks", () => {
  it("generates, validates, badges and signs", async () => {
    const { d, callModel } = deps();
    const res = (await getStylePicks(USER, d))!;
    expect(callModel).toHaveBeenCalledTimes(1);
    const [system, user] = callModel.mock.calls[0] as unknown as [string, string];
    expect(system).toContain("**uk**");
    expect(user).not.toContain("w1"); // a women's item never reaches a man's shortlist
    expect(res.language).toBe("uk");
    expect(res.picks.map((p) => p.id)).toEqual(["s1", "s2", "a1", "a2", "g1", "g2"]);
    expect(res.picks[0]!.badges).toEqual([{ kind: "forYou" }]);
    expect(res.picks[2]!.badges).toEqual([
      { kind: "forYou" },
      { kind: "seenOn", text: "У кадрі X", sourceUrl: "https://example.com/x" },
    ]);
    expect(res.picks[1]!.badges).toEqual([]);
    expect(res.picks[0]!.outUrl).toMatch(/\/v1\/style\/out\/s1\?u=.*&l=uk$/);
    expect(Object.keys(res.picks[0]!).sort()).toEqual(
      ["badges", "brand", "category", "id", "imageUrl", "name", "outUrl", "priceTier", "reason", "signals", "sponsored"],
    );
  });

  it("reuses a fresh cached set with the same language and profile", async () => {
    const first = deps();
    await getStylePicks(USER, first.d);
    const again = deps({}, first.store);
    const res = await getStylePicks(USER, again.d);
    expect(again.callModel).not.toHaveBeenCalled();
    expect(res!.picks).toHaveLength(6);
  });

  it("regenerates when the cache is older than seven days, or the language changed", async () => {
    const first = deps();
    await getStylePicks(USER, first.d);
    const stale = deps({ now: () => NOW + 8 * DAY }, first.store);
    await getStylePicks(USER, stale.d);
    expect(stale.callModel).toHaveBeenCalledTimes(1);
    const otherLang = deps({ loadSource: async () => ({ source: source(), language: "en" }) }, first.store);
    await getStylePicks(USER, otherLang.d);
    expect(otherLang.callModel).toHaveBeenCalledTimes(1);
  });

  it("serves the latest cached set when a regeneration fails", async () => {
    const first = deps();
    await getStylePicks(USER, first.d);
    const failing = deps({ now: () => NOW + 8 * DAY, callModel: vi.fn(async () => null) }, first.store);
    const res = await getStylePicks(USER, failing.d);
    expect(res!.picks).toHaveLength(6);
    expect(failing.d.saveSet).not.toHaveBeenCalled();
  });

  it("returns null (→ 204) on failure with nothing cached, or for a thin profile", async () => {
    const failing = deps({ callModel: vi.fn(async () => ({ basis: [], picks: [] })) });
    expect(await getStylePicks(USER, failing.d)).toBeNull();
    const thin = deps({ loadSource: async () => ({ source: source({ gender: null }), language: "en" }) });
    expect(await getStylePicks(USER, thin.d)).toBeNull();
    expect(thin.callModel).not.toHaveBeenCalled();
  });

  it("drops a cached pick whose product was retired since", async () => {
    const first = deps();
    await getStylePicks(USER, first.d);
    const retired = deps(
      { loadCatalog: async () => catalog.map((p) => (p.id === "g2" ? { ...p, active: false } : p)) },
      first.store,
    );
    // The shortlist changed, so this regenerates; make the regeneration fail to see the fallback.
    retired.callModel.mockResolvedValue(null as never);
    const res = await getStylePicks(USER, retired.d);
    expect(res!.picks.map((p) => p.id)).not.toContain("g2");
  });
});
