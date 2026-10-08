import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, env: { ...actual.env, OPENAI_API_KEY: "test-openai-key" } };
});

import { WISHLIST_PASTE_MAX_ENTRIES } from "@gennety/shared";
import { env } from "../config.js";
import { MODELS } from "../models.js";
import {
  extractWishlistFromScreenshots,
  extractWishlistFromSpeech,
  ideasToEntries,
  parseScreenshotsAnswer,
} from "./wishlist-extract.js";

const mutableEnv = env as { -readonly [K in keyof typeof env]: (typeof env)[K] };

// The failure paths log on purpose; keep the test output readable.
vi.spyOn(console, "warn").mockImplementation(() => undefined);

beforeEach(() => {
  mutableEnv.OPENAI_API_KEY = "test-openai-key";
});

/** A chat-completions answer whose message content is `content`. */
function completion(content: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  ) as unknown as typeof fetch;
}

function requestBody(fetchFn: typeof fetch): Record<string, unknown> {
  const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

describe("ideasToEntries", () => {
  it("keeps categories, turns readable https links into url entries and drops repeats", () => {
    const result = ideasToEntries([
      { query: "  Chanel Chance Eau Tendre, ", category: "perfume", url: null },
      { query: "chanel chance eau tendre", category: "perfume", url: null },
      { query: "Пионы", category: "flowers" },
      { query: "Pandora ring", category: "jewelry", url: "http://www.pandora.net/ring?utm_source=ig#top" },
      { query: "—", category: "gift" },
      { query: "Spa", category: "nonsense" },
    ]);
    expect(result.mode).toBe("mixed");
    expect(result.entries).toEqual([
      { id: "e1", kind: "query", value: "Chanel Chance Eau Tendre", category: "perfume" },
      { id: "e2", kind: "query", value: "Пионы", category: "flowers" },
      { id: "e3", kind: "url", value: "https://www.pandora.net/ring", category: "jewelry" },
      { id: "e4", kind: "query", value: "Spa" },
    ]);
  });

  it("refuses a link to a private host and keeps its query instead", () => {
    const result = ideasToEntries([{ query: "Lamp", category: "gift", url: "https://192.168.0.1/lamp" }]);
    expect(result.entries).toEqual([{ id: "e1", kind: "query", value: "Lamp", category: "gift" }]);
  });

  it("caps the number of entries", () => {
    const many = Array.from({ length: WISHLIST_PASTE_MAX_ENTRIES + 4 }, (_, i) => ({ query: `Idea ${i}`, category: "gift" }));
    expect(ideasToEntries(many).entries).toHaveLength(WISHLIST_PASTE_MAX_ENTRIES);
  });
});

describe("extractWishlistFromSpeech", () => {
  it("lifts the ideas out of free talk with one structured call", async () => {
    const fetchFn = completion({
      items: [
        { query: "Chanel Chance", category: "perfume" },
        { query: "пионы", category: "flowers" },
        { query: "спа на двоих", category: "experience" },
      ],
    });
    const result = await extractWishlistFromSpeech(
      "Ну я люблю пионы, только не розы, и ещё хочу духи Шанель Шанс, ну и в спа сходить вдвоём",
      "ru",
      { fetchFn },
    );
    expect(result).toEqual({
      mode: "text",
      entries: [
        { id: "e1", kind: "query", value: "Chanel Chance", category: "perfume" },
        { id: "e2", kind: "query", value: "пионы", category: "flowers" },
        { id: "e3", kind: "query", value: "спа на двоих", category: "experience" },
      ],
    });
    const body = requestBody(fetchFn);
    expect(body.model).toBe(MODELS.fast);
    expect((body.response_format as { type: string }).type).toBe("json_schema");
    const system = ((body.messages as Array<{ content: string }>)[0]!).content;
    expect(system).toContain("Russian");
  });

  it("falls back to the paste split when the model is down", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const result = await extractWishlistFromSpeech("пионы, духи Chloé, спа", "ru", { fetchFn });
    expect(result.entries.map((entry) => entry.value)).toEqual(["пионы", "духи Chloé", "спа"]);
  });

  it("answers no entries for an empty transcript without calling out", async () => {
    const fetchFn = completion({ items: [] });
    expect(await extractWishlistFromSpeech("   ", "en", { fetchFn })).toEqual({ mode: "text", entries: [] });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("extractWishlistFromScreenshots", () => {
  it("sends every image to one vision call at high detail and reads the entries", async () => {
    const fetchFn = completion({
      items: [
        { query: "Le Labo Santal 33 50 ml", category: "perfume", url: null },
        { query: "Jacquemus Le Chiquito", category: "fashion", url: "https://www.jacquemus.com/le-chiquito" },
      ],
      unreadable: 1,
    });
    const result = await extractWishlistFromScreenshots(
      [
        { buffer: JPEG, mime: "image/jpeg" },
        { buffer: JPEG, mime: "image/jpeg" },
        { buffer: JPEG, mime: "image/jpeg" },
      ],
      "en",
      { fetchFn },
    );
    expect(result).toEqual({
      ok: true,
      mode: "mixed",
      entries: [
        { id: "e1", kind: "query", value: "Le Labo Santal 33 50 ml", category: "perfume" },
        { id: "e2", kind: "url", value: "https://www.jacquemus.com/le-chiquito", category: "fashion" },
      ],
      unreadable: 1,
    });
    const body = requestBody(fetchFn);
    expect(body.model).toBe(MODELS.visionFast);
    const content = (body.messages as Array<{ content: unknown }>)[1]!.content as Array<{
      type: string;
      image_url?: { url: string; detail: string };
    }>;
    const images = content.filter((part) => part.type === "image_url");
    expect(images).toHaveLength(3);
    expect(images[0]!.image_url!.url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(images[0]!.image_url!.detail).toBe("high");
  });

  it("reports the API, a timeout and a missing key as failures, not as an empty list", async () => {
    const down = vi.fn(async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    expect(await extractWishlistFromScreenshots([{ buffer: JPEG, mime: "image/jpeg" }], "en", { fetchFn: down })).toEqual({
      ok: false,
      error: "api",
    });

    const aborted = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
    expect(await extractWishlistFromScreenshots([{ buffer: JPEG, mime: "image/jpeg" }], "en", { fetchFn: aborted })).toEqual({
      ok: false,
      error: "timeout",
    });

    mutableEnv.OPENAI_API_KEY = "";
    expect(await extractWishlistFromScreenshots([{ buffer: JPEG, mime: "image/jpeg" }], "en")).toEqual({
      ok: false,
      error: "disabled",
    });
  });
});

describe("parseScreenshotsAnswer", () => {
  it("clamps `unreadable` to the images sent and tolerates a missing items array", () => {
    expect(parseScreenshotsAnswer(JSON.stringify({ unreadable: 9 }), 2)).toEqual({
      ok: true,
      mode: "text",
      entries: [],
      unreadable: 2,
    });
  });

  it("treats a body that is not JSON as an API failure", () => {
    expect(parseScreenshotsAnswer("I can't help with that.", 1)).toEqual({ ok: false, error: "api" });
  });
});
