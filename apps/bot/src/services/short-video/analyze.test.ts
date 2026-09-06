import { describe, it, expect, vi } from "vitest";
import {
  analyzeShortVideo,
  type AnalyzeShortVideoDeps,
  type ShortVideoCacheEntry,
} from "./analyze.js";
import { extractQuotedCaption, readMetaTag } from "./metadata.js";
import type { ShortVideoRef } from "./links.js";

/** Minimal valid JPEG header — `sniffImageMime` reads the magic bytes. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]);
const NOT_AN_IMAGE = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");

const RESOLVED: ShortVideoRef = {
  platform: "tiktok",
  externalId: "7301234567890123456",
  url: "https://www.tiktok.com/@u/video/7301234567890123456",
};
const STUB: ShortVideoRef = {
  platform: "tiktok",
  externalId: null,
  url: "https://vm.tiktok.com/ZMabcdef1/",
};

function deps(over: Partial<AnalyzeShortVideoDeps> = {}): AnalyzeShortVideoDeps {
  return {
    resolveRef: vi.fn(async () => ({ ok: true, ref: RESOLVED }) as const),
    fetchMetadata: vi.fn(
      async () =>
        ({
          ok: true,
          ref: RESOLVED,
          metadata: {
            caption: "when you tell your mum you're fine",
            authorName: "someone",
            posterUrl: "https://p16-sign.tiktokcdn-us.com/cover.jpg",
          },
        }) as const,
    ),
    fetchPoster: vi.fn(async () => ({ ok: true, buffer: JPEG }) as const),
    read: vi.fn(
      async () => ({ ok: true, description: "a deadpan skit about lying to your mum", model: "m" }) as const,
    ),
    mintPointer: vi.fn(async () => "FILE_ID_1"),
    cacheGet: vi.fn(async () => null as ShortVideoCacheEntry | null),
    cacheSet: vi.fn(async () => {}),
    ...over,
  };
}

describe("analyzeShortVideo — the happy path", () => {
  it("describes the video and keeps a pointer to its cover frame", async () => {
    const d = deps();
    const result = await analyzeShortVideo(RESOLVED, { language: "ru" }, d);
    expect(result).toEqual({
      ok: true,
      ref: RESOLVED,
      description: "a deadpan skit about lying to your mum",
      poster: { fileId: "FILE_ID_1", kind: "photo" },
      cached: false,
    });
    expect(d.cacheSet).toHaveBeenCalledWith(
      RESOLVED,
      expect.objectContaining({ posterFileId: "FILE_ID_1", model: "m" }),
    );
  });

  it("passes the author's caption to the vision pass as context", async () => {
    const d = deps();
    await analyzeShortVideo(RESOLVED, { language: "ru" }, d);
    expect(d.read).toHaveBeenCalledWith(
      { buffer: JPEG, mime: "image/jpeg" },
      expect.objectContaining({
        metadata: expect.objectContaining({
          caption: "when you tell your mum you're fine",
        }),
      }),
    );
  });
});

describe("analyzeShortVideo — the cache is the cost design", () => {
  it("serves a known video without a single network call or token", async () => {
    const d = deps({
      cacheGet: vi.fn(async () => ({ description: "already known", posterFileId: "OLD_ID" })),
    });
    const result = await analyzeShortVideo(RESOLVED, { language: "ru" }, d);
    expect(result).toEqual({
      ok: true,
      ref: RESOLVED,
      description: "already known",
      poster: { fileId: "OLD_ID", kind: "photo" },
      cached: true,
    });
    expect(d.fetchMetadata).not.toHaveBeenCalled();
    expect(d.fetchPoster).not.toHaveBeenCalled();
    expect(d.read).not.toHaveBeenCalled();
    expect(d.mintPointer).not.toHaveBeenCalled();
  });

  it("resolves a share stub before looking it up, so one video is one entry", async () => {
    const d = deps({
      cacheGet: vi.fn(async () => ({ description: "already known", posterFileId: null })),
    });
    const result = await analyzeShortVideo(STUB, { language: "ru" }, d);
    expect(d.resolveRef).toHaveBeenCalledWith(STUB);
    // Looked up under the RESOLVED id, never under the stub's.
    expect(d.cacheGet).toHaveBeenCalledWith(RESOLVED);
    expect(result).toMatchObject({ ok: true, cached: true, poster: null });
  });

  it("re-checks the cache when metadata sharpens the id, before spending a call", async () => {
    const sharper: ShortVideoRef = {
      platform: "instagram",
      externalId: "Cx1_ab-cdEF",
      url: "https://www.instagram.com/reel/Cx1_ab-cdEF/",
    };
    const vague: ShortVideoRef = {
      platform: "instagram",
      externalId: "share-token",
      url: "https://www.instagram.com/share/reel/_abc/",
    };
    const cacheGet = vi
      .fn<(ref: ShortVideoRef) => Promise<ShortVideoCacheEntry | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ description: "known under the real code", posterFileId: null });
    const d = deps({
      resolveRef: vi.fn(async () => ({ ok: true, ref: vague }) as const),
      fetchMetadata: vi.fn(
        async () =>
          ({
            ok: true,
            ref: sharper,
            metadata: { caption: "x", authorName: undefined, posterUrl: "https://p16.tiktokcdn.com/c.jpg" },
          }) as const,
      ),
      cacheGet,
    });
    const result = await analyzeShortVideo(vague, { language: "en" }, d);
    expect(result).toMatchObject({ ok: true, cached: true, ref: sharper });
    expect(d.read).not.toHaveBeenCalled();
  });
});

describe("analyzeShortVideo — failures", () => {
  it("reports a dead share stub rather than analysing something else", async () => {
    const d = deps({
      resolveRef: vi.fn(async () => ({ ok: false, error: "not_found" }) as const),
    });
    await expect(analyzeShortVideo(STUB, { language: "ru" }, d)).resolves.toEqual({
      ok: false,
      error: "not_found",
    });
    expect(d.cacheGet).not.toHaveBeenCalled();
  });

  it("passes a private post straight through as private", async () => {
    const d = deps({
      fetchMetadata: vi.fn(async () => ({ ok: false, error: "private" }) as const),
    });
    await expect(analyzeShortVideo(RESOLVED, { language: "ru" }, d)).resolves.toEqual({
      ok: false,
      error: "private",
    });
  });

  it("refuses to guess when there is no cover frame to look at", async () => {
    const d = deps({
      fetchMetadata: vi.fn(
        async () =>
          ({
            ok: true,
            ref: RESOLVED,
            metadata: { caption: "a caption", authorName: undefined, posterUrl: undefined },
          }) as const,
      ),
    });
    await expect(analyzeShortVideo(RESOLVED, { language: "ru" }, d)).resolves.toEqual({
      ok: false,
      error: "no_metadata",
    });
    expect(d.read).not.toHaveBeenCalled();
  });

  it("treats bytes that are not an image as unreadable without calling vision", async () => {
    const d = deps({ fetchPoster: vi.fn(async () => ({ ok: true, buffer: NOT_AN_IMAGE }) as const) });
    await expect(analyzeShortVideo(RESOLVED, { language: "ru" }, d)).resolves.toEqual({
      ok: false,
      error: "unreadable",
    });
    expect(d.read).not.toHaveBeenCalled();
  });

  it("never caches a cover frame the vision pass refused", async () => {
    const d = deps({ read: vi.fn(async () => ({ ok: false, error: "unsafe" }) as const) });
    await expect(analyzeShortVideo(RESOLVED, { language: "ru" }, d)).resolves.toEqual({
      ok: false,
      error: "unsafe",
    });
    expect(d.cacheSet).not.toHaveBeenCalled();
    expect(d.mintPointer).not.toHaveBeenCalled();
  });

  it("still records the description when the pointer could not be minted", async () => {
    const d = deps({ mintPointer: vi.fn(async () => null) });
    const result = await analyzeShortVideo(RESOLVED, { language: "ru" }, d);
    expect(result).toMatchObject({ ok: true, poster: null });
    expect(d.cacheSet).toHaveBeenCalledWith(
      RESOLVED,
      expect.objectContaining({ posterFileId: null }),
    );
  });
});

describe("metadata parsing", () => {
  it("reads an og tag whichever order the attributes come in", () => {
    expect(
      readMetaTag('<meta property="og:image" content="https://cdn/x.jpg">', "og:image"),
    ).toBe("https://cdn/x.jpg");
    expect(
      readMetaTag('<meta content="https://cdn/y.jpg" property="og:image" />', "og:image"),
    ).toBe("https://cdn/y.jpg");
  });

  it("decodes the entities a real page escapes URLs with", () => {
    expect(
      readMetaTag('<meta property="og:image" content="https://cdn/x.jpg?a=1&amp;b=2">', "og:image"),
    ).toBe("https://cdn/x.jpg?a=1&b=2");
  });

  it("returns undefined rather than a wrong tag when the key is absent", () => {
    expect(readMetaTag('<meta property="og:title" content="t">', "og:image")).toBeUndefined();
  });

  it("pulls the caption out of Instagram's stats sentence", () => {
    expect(
      extractQuotedCaption(
        '1,234 likes, 56 comments - someone on May 1, 2026: "when you tell your mum you\'re fine".',
      ),
    ).toBe("when you tell your mum you're fine");
  });

  it("keeps a plain description that carries no stats wrapper", () => {
    expect(extractQuotedCaption("just a normal description")).toBe("just a normal description");
  });
});
