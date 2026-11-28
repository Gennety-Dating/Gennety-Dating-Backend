import { beforeEach, describe, expect, it, vi } from "vitest";

const env = { OPENAI_API_KEY: "k", WISHLIST_SEARCH_MODEL: "search-model" };
vi.mock("../config.js", () => ({ env }));
const cache = new Map<string, { payload: unknown; expiresAt: Date }>();
vi.mock("@gennety/db", () => ({
  Prisma: {},
  prisma: {
    webLookupCache: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => cache.get(where.key) ?? null),
      upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: { payload: unknown; expiresAt: Date } }) => {
        cache.set(where.key, { payload: create.payload, expiresAt: create.expiresAt });
      }),
    },
  },
}));

const { citedSources, cleanSummary, isNearDuplicateQuery, queryWords, resetWebSearchCounts, searchWeb, webSearchToolResult, SEARCH_WEB_TOOL } = await import("./chat-web-search.js");

const now = new Date("2026-11-28T10:00:00.000Z");

function responseBody(text: string, cited: Array<{ url: string; title?: string }>, read: string[] = []) {
  return {
    output: [
      { type: "web_search_call", action: { sources: read.map((url) => ({ url })) } },
      {
        type: "message",
        content: [{ type: "output_text", text, annotations: cited.map((c) => ({ type: "url_citation", ...c })) }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function okFetch(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

beforeEach(() => {
  cache.clear();
  resetWebSearchCounts();
  env.OPENAI_API_KEY = "k";
});

describe("citedSources", () => {
  it("keeps cited pages first, then pages read, https only, without duplicates", () => {
    const body = responseBody("x", [{ url: "https://makeup.com.ua/black-friday/?utm_source=openai", title: "MAKEUP Black Friday" }], [
      "https://makeup.com.ua/black-friday/",
      "http://parfums.ua/sale",
      "ftp://bad.example/file",
    ]);
    expect(citedSources(body)).toEqual([
      { title: "MAKEUP Black Friday", url: "https://makeup.com.ua/black-friday/" },
      { title: "parfums.ua", url: "https://parfums.ua/sale" },
    ]);
  });
});

describe("cleanSummary", () => {
  it("drops citation tails and markdown", () => {
    expect(cleanSummary("**MAKEUP**: −50% ([makeup.com.ua](https://makeup.com.ua/bf))\nDetails [here](https://x.com/a)")).toBe("MAKEUP: −50%\nDetails here");
  });
});

describe("searchWeb", () => {
  it("searches with the hosted tool in the person's city and returns cited facts", async () => {
    const fetchFn = okFetch(responseBody("MAKEUP: до −50% на ароматы до 1 декабря", [{ url: "https://makeup.com.ua/bf", title: "Black Friday" }]));
    const result = await searchWeb("u1", "makeup black friday киев", "ua:kyiv", { fetchFn, now, overBudget: () => false });
    expect(result).toEqual({ status: "found", summary: "MAKEUP: до −50% на ароматы до 1 декабря", sources: [{ title: "Black Friday", url: "https://makeup.com.ua/bf" }] });
    const request = JSON.parse((fetchFn as unknown as { mock: { calls: Array<[string, { body: string }]> } }).mock.calls[0]![1].body);
    expect(request.model).toBe("search-model");
    expect(request.tools[0]).toMatchObject({ type: "web_search", user_location: { type: "approximate", country: "UA" } });
    expect(request.input).toBe("makeup black friday киев");
    expect(request.instructions).toContain("2026-11-28");
    // Token economy (2026-11-28): one look-up, little thinking, a short answer.
    expect(request.max_tool_calls).toBe(1);
    expect(request.reasoning).toEqual({ effort: "low" });
    expect(request.max_output_tokens).toBe(800);
  });

  it("answers a repeat from the cache without a second search", async () => {
    const fetchFn = okFetch(responseBody("facts", [{ url: "https://a.com/p" }]));
    await searchWeb("u1", "query", null, { fetchFn, now, overBudget: () => false });
    await searchWeb("u2", "Query", null, { fetchFn, now, overBudget: () => false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("the same question in other case, punctuation or word order is one search", async () => {
    const fetchFn = okFetch(responseBody("facts", [{ url: "https://a.com/p" }]));
    await searchWeb("u1", "Black Friday Parfums Kyiv", null, { fetchFn, now, overBudget: () => false });
    await searchWeb("u2", "parfums kyiv: black friday!", null, { fetchFn, now, overBudget: () => false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("an answer no page backs is not_found, kept for half an hour only", async () => {
    const fetchFn = okFetch(responseBody("made up", []));
    expect(await searchWeb("u1", "q", null, { fetchFn, now, overBudget: () => false })).toEqual({ status: "not_found" });
    expect(await searchWeb("u1", "q", null, { fetchFn, now, overBudget: () => false })).toEqual({ status: "not_found" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const later = new Date(now.getTime() + 31 * 60_000);
    await searchWeb("u1", "q", null, { fetchFn, now: later, overBudget: () => false });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("a failed search is not kept", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await searchWeb("u1", "q", null, { fetchFn, now, overBudget: () => false });
    expect(cache.size).toBe(0);
  });

  it("refuses an empty query, a spent budget, a missing key and the daily limit", async () => {
    const fetchFn = okFetch(responseBody("facts", [{ url: "https://a.com/p" }]));
    expect(await searchWeb("u1", "  https://x.com  ", null, { fetchFn, now })).toBeNull();
    expect(await searchWeb("u1", "q", null, { fetchFn, now, overBudget: () => true })).toEqual({ status: "over_budget" });
    env.OPENAI_API_KEY = "";
    expect(await searchWeb("u1", "q", null, { fetchFn, now, overBudget: () => false })).toEqual({ status: "unavailable" });
    env.OPENAI_API_KEY = "k";
    for (let i = 0; i < 8; i++) await searchWeb("u3", `q${i}`, null, { fetchFn, now, overBudget: () => false });
    expect(await searchWeb("u3", "one more", null, { fetchFn, now, overBudget: () => false })).toEqual({ status: "over_limit" });
  });

  it("a failed request is unavailable", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await searchWeb("u1", "q", null, { fetchFn, now, overBudget: () => false })).toEqual({ status: "unavailable" });
  });
});

describe("near-duplicate queries", () => {
  it("compares words, not case, punctuation or order", () => {
    expect(queryWords("Black-Friday, Parfums KYIV  kyiv")).toEqual(["black", "friday", "kyiv", "parfums"]);
    expect(isNearDuplicateQuery("Black Friday Parfums Kyiv", "parfums kyiv black friday 2026")).toBe(true);
    expect(isNearDuplicateQuery("Black Friday Parfums Kyiv", "Parfums Kyiv opening hours")).toBe(false);
    expect(isNearDuplicateQuery("", "anything")).toBe(false);
  });
});

describe("webSearchToolResult", () => {
  it("a repeated look-up says so and carries the same facts", () => {
    const repeated = JSON.parse(webSearchToolResult({ status: "found", summary: "facts", sources: [{ title: "a", url: "https://a.com" }] }, { repeated: true }));
    expect(repeated).toMatchObject({ success: true, repeated: true, summary: "facts" });
    expect(repeated.instruction).toMatch(/not searched again/);
  });

  it("never tells the agent to ask the person for a link", () => {
    for (const status of ["not_found", "over_limit", "over_budget", "unavailable"] as const) {
      const parsed = JSON.parse(webSearchToolResult({ status }));
      expect(parsed.success).toBe(false);
    }
    expect(JSON.parse(webSearchToolResult({ status: "unavailable" })).instruction).toContain("do not ask them for a link");
  });

  it("passes facts and links", () => {
    const parsed = JSON.parse(webSearchToolResult({ status: "found", summary: "s", sources: [{ title: "t", url: "https://a.com" }] }));
    expect(parsed).toMatchObject({ success: true, summary: "s", sources: [{ url: "https://a.com" }] });
  });

  it("describes when to search", () => {
    expect(SEARCH_WEB_TOOL.function.description).toMatch(/instead of asking the person for a link/);
  });
});
