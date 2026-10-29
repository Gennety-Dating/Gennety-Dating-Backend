import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  env: { OPENAI_API_KEY: "k", SHORT_VIDEO_FETCH_TIMEOUT_MS: 8000 },
}));
vi.mock("@gennety/db", () => ({ prisma: {} }));

const { classifyShortVideoUrl } = await import("../short-video/links.js");
const { classifyShareVideoUrl, isSharePosterHost, isShareVideoHost } = await import("./links.js");
const {
  clearShareVideoCache,
  parseShareVideoAnalysis,
  readSharedVideo,
} = await import("./read.js");
type ReadDeps = import("./read.js").ShareVideoReadDeps;
type Analysis = import("./read.js").ShareVideoAnalysis;
const { answerShareVideoQuestion, askSystemPrompt, tidyAnswer } = await import("./ask.js");
const { addShareInterest } = await import("./interest.js");

const viewer = { language: "ru" as const, cityKey: "kyiv" };

describe("share links", () => {
  it("reads YouTube Shorts, watch and youtu.be into one canonical url", () => {
    expect(classifyShareVideoUrl("https://youtube.com/shorts/abcDEF12345?si=x")).toEqual({
      platform: "youtube",
      externalId: "abcDEF12345",
      url: "https://www.youtube.com/shorts/abcDEF12345",
    });
    expect(classifyShareVideoUrl("https://youtu.be/abcDEF12345?si=track")?.url).toBe(
      "https://www.youtube.com/watch?v=abcDEF12345",
    );
    expect(classifyShareVideoUrl("https://m.youtube.com/watch?v=abcDEF12345&t=3")?.url).toBe(
      "https://www.youtube.com/watch?v=abcDEF12345",
    );
    expect(classifyShareVideoUrl("https://www.youtube.com/@channel")).toBeNull();
    expect(classifyShareVideoUrl("https://youtube.com.evil.tld/shorts/abcDEF12345")).toBeNull();
  });

  it("keeps TikTok / Instagram from the Profiler's classifier", () => {
    expect(classifyShareVideoUrl("https://www.instagram.com/reel/C9xYzAbc/?igsh=1")?.platform).toBe("instagram");
    expect(classifyShareVideoUrl("https://vm.tiktok.com/ZMabc123/")?.externalId).toBeNull();
    expect(classifyShareVideoUrl("https://www.cos.com/en/scarf")).toBeNull();
  });

  it("leaves the Profiler's perimeter as it was", () => {
    expect(classifyShortVideoUrl("https://youtube.com/shorts/abcDEF12345")).toBeNull();
    expect(isShareVideoHost("www.youtube.com")).toBe(true);
    expect(isSharePosterHost("i.ytimg.com")).toBe(true);
    expect(isSharePosterHost("ytimg.com.evil.tld")).toBe(false);
  });
});

const analysis = (over: Partial<Analysis> = {}): Analysis => ({
  safe: true,
  title: "Лучший флэт уайт на Подоле",
  summary: "Маленькая кофейня: латте-арт и место у окна.",
  coverDescription: "Чашка флэт уайта с латте-артом на мраморном столе.",
  interest: "Спешелти-кофе",
  item: { title: "Mad Heads", kind: "place", category: "place", query: "Mad Heads coffee Kyiv" },
  questions: ["Где это?", "Сколько стоит?"],
  ...over,
});

function deps(over: Partial<ReadDeps> = {}): ReadDeps & { calls: { analyze: number; poster: number } } {
  const calls = { analyze: 0, poster: 0 };
  return {
    calls,
    metadata: async (ref) => ({
      ref,
      caption: "Лучший флэт уайт на Подоле ☕️ #kyiv #coffee",
      author: "kyiv.coffee",
      posterUrl: "https://p16-sign.tiktokcdn.com/poster.jpeg",
    }),
    poster: async () => {
      calls.poster += 1;
      return Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    },
    analyze: async (input) => {
      calls.analyze += 1;
      expect(input.poster).toBeDefined();
      expect(input.language).toBe("ru");
      return analysis();
    },
    ...over,
  };
}

const TIKTOK = "https://www.tiktok.com/@kyiv.coffee/video/7312345678901234567?_r=1";

describe("readSharedVideo", () => {
  beforeEach(() => clearShareVideoCache());

  it("coalesces simultaneous reads and a question's grounding read into one analysis", async () => {
    const d = deps({ analyze: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return analysis();
    }) });
    const results = await Promise.all(Array.from({ length: 4 }, () => readSharedVideo(TIKTOK, viewer, d)));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(d.analyze).toHaveBeenCalledTimes(1);
    expect(d.calls.poster).toBe(1);
  });

  it("does not reuse city-dependent suggestions for another city", async () => {
    const d = deps({ analyze: vi.fn(async () => analysis()) });
    await readSharedVideo(TIKTOK, viewer, d);
    await readSharedVideo(TIKTOK, { ...viewer, cityKey: "warsaw" }, d);
    expect(d.analyze).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight entry after an analysis failure so retry can succeed", async () => {
    const analyze = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce(analysis());
    const d = deps({ analyze });
    await readSharedVideo(TIKTOK, viewer, d);
    const retry = await readSharedVideo(TIKTOK, viewer, d);
    expect(retry.ok && retry.video.interest?.label).toBe("Спешелти-кофе");
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("reads a video into title, interest, item and questions; caches it", async () => {
    const d = deps();
    const result = await readSharedVideo(TIKTOK, viewer, d);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.video).toMatchObject({
      status: "read",
      platform: "tiktok",
      url: "https://www.tiktok.com/@kyiv.coffee/video/7312345678901234567",
      author: "kyiv.coffee",
      posterUrl: "https://p16-sign.tiktokcdn.com/poster.jpeg",
      interest: { label: "Спешелти-кофе" },
      item: { kind: "place", category: "place" },
      questions: ["Где это?", "Сколько стоит?"],
    });
    expect(result.grounding.coverDescription).toContain("латте-арт");

    await readSharedVideo(TIKTOK, viewer, d);
    expect(d.calls.analyze).toBe(1);
  });

  it("not a video link → not_video, nothing fetched", async () => {
    const d = deps({ metadata: async () => { throw new Error("must not fetch"); } });
    expect(await readSharedVideo("https://www.cos.com/x", viewer, d)).toEqual({ ok: false, error: "not_video" });
  });

  it("the platform gave nothing → closed", async () => {
    const result = await readSharedVideo(TIKTOK, viewer, deps({ metadata: async () => null }));
    expect(result.ok && result.video.status).toBe("closed");
  });

  it("unsafe content → closed, not repeated back", async () => {
    const result = await readSharedVideo(TIKTOK, viewer, deps({ analyze: async () => analysis({ safe: false }) }));
    expect(result.ok && result.video).toMatchObject({ status: "closed", questions: [] });
  });

  it("model failed → read from the caption, not cached", async () => {
    const d = deps({ analyze: async () => null });
    const result = await readSharedVideo(TIKTOK, viewer, d);
    expect(result.ok && result.video).toMatchObject({ status: "read", title: "Лучший флэт уайт на Подоле ☕️" });
    expect(result.ok && result.video.interest).toBeUndefined();
    let second = 0;
    await readSharedVideo(TIKTOK, viewer, { ...d, analyze: async () => { second += 1; return analysis(); } });
    expect(second).toBe(1);
  });

  it("a poster off the CDN allowlist is neither fetched nor returned", async () => {
    const d = deps({
      metadata: async (ref) => ({ ref, caption: "x", posterUrl: "https://evil.example/p.jpg" }),
      analyze: async (input) => {
        expect(input.poster).toBeUndefined();
        return analysis();
      },
    });
    const result = await readSharedVideo(TIKTOK, viewer, d);
    expect(result.ok && result.video.posterUrl).toBeUndefined();
    expect(d.calls.poster).toBe(0);
  });
});

describe("parseShareVideoAnalysis", () => {
  it("clips fields and drops an item without a known category", () => {
    const parsed = parseShareVideoAnalysis(
      JSON.stringify({
        safe: true,
        title: "x".repeat(100),
        summary: "s",
        coverDescription: "",
        interest: "",
        item: { title: "Thing", kind: "item", category: "spaceship", query: "q", brand: null },
        questions: ["a", "", "b", "c", "d"],
      }),
    );
    expect(parsed?.title.length).toBe(60);
    expect(parsed?.interest).toBeNull();
    expect(parsed?.item).toBeNull();
    expect(parsed?.questions).toEqual(["a", "b", "c"]);
    expect(parseShareVideoAnalysis("not json")).toBeNull();
  });
});

describe("answerShareVideoQuestion", () => {
  it("grounds the prompt on what the read saw and sends the history", async () => {
    const video = {
      status: "read" as const,
      platform: "tiktok" as const,
      url: TIKTOK,
      title: "Лучший флэт уайт на Подоле",
      questions: [],
    };
    let seen = { system: "", user: "" };
    const answer = await answerShareVideoQuestion(
      {
        video,
        grounding: { caption: "Mad Heads, Ярославов Вал 15" },
        question: "А это далеко?",
        history: [{ question: "Где это?", answer: "Ярославов Вал, 15." }],
        ...viewer,
      },
      {
        complete: async (system, user) => {
          seen = { system, user };
          return "**Около 15 минут** пешком от Подола.";
        },
      },
    );
    expect(answer).toBe("Около 15 минут пешком от Подола.");
    expect(seen.system).toContain("Mad Heads, Ярославов Вал 15");
    expect(seen.system).toContain("Russian");
    expect(seen.user).toContain("Q: Где это?\nA: Ярославов Вал, 15.");
    expect(seen.user.endsWith("Q: А это далеко?")).toBe(true);
  });

  it("an empty model answer is null; long answers are capped", async () => {
    const input = {
      video: { status: "read" as const, platform: "youtube" as const, url: "u", questions: [] },
      grounding: {},
      question: "?",
      history: [],
      ...viewer,
    };
    expect(await answerShareVideoQuestion(input, { complete: async () => "  " })).toBeNull();
    expect(tidyAnswer("a".repeat(700)).length).toBe(600);
    expect(askSystemPrompt(input)).toContain("NOT watched");
  });
});

describe("addShareInterest", () => {
  function store(hobbies: string[] | null) {
    const writes: Array<{ hobbies: string[]; embeddingDirty: boolean }> = [];
    return {
      writes,
      db: {
        profile: {
          findUnique: async () => (hobbies ? { hobbies } : null),
          update: async (args: { data: { hobbies: string[]; embeddingDirty: boolean } }) => {
            writes.push(args.data);
            return {};
          },
        },
      },
    };
  }

  it("appends, marks the embedding dirty", async () => {
    const s = store(["Бег"]);
    expect(await addShareInterest("u", "  Спешелти-кофе ", s.db)).toEqual({
      ok: true,
      hobbies: ["Бег", "Спешелти-кофе"],
      added: true,
    });
    expect(s.writes[0]).toMatchObject({ embeddingDirty: true });
  });

  it("already there (any case) → added false, no write", async () => {
    const s = store(["Спешелти-кофе"]);
    expect(await addShareInterest("u", "спешелти-КОФЕ", s.db)).toMatchObject({ ok: true, added: false });
    expect(s.writes).toHaveLength(0);
  });

  it("ten already → too-many; bad label → bad-request; no profile → not-found", async () => {
    const full = store(Array.from({ length: 10 }, (_, i) => `h${i}`));
    expect(await addShareInterest("u", "new", full.db)).toEqual({ ok: false, error: "too-many" });
    expect(await addShareInterest("u", "x".repeat(51), store([]).db)).toEqual({ ok: false, error: "bad-request" });
    expect(await addShareInterest("u", 5, store([]).db)).toEqual({ ok: false, error: "bad-request" });
    expect(await addShareInterest("u", "x", store(null).db)).toEqual({ ok: false, error: "not-found" });
  });
});
