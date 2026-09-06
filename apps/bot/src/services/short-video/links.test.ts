import { describe, it, expect } from "vitest";
import {
  classifyShortVideoUrl,
  commentaryAroundLink,
  findShortVideoLink,
  isPosterHost,
  isShortVideoHost,
} from "./links.js";

describe("classifyShortVideoUrl — TikTok", () => {
  it("reads the numeric id out of a canonical video URL", () => {
    expect(
      classifyShortVideoUrl("https://www.tiktok.com/@someone/video/7301234567890123456"),
    ).toEqual({
      platform: "tiktok",
      externalId: "7301234567890123456",
      url: "https://www.tiktok.com/@someone/video/7301234567890123456",
    });
  });

  it("collapses share tracking so one video is one cache key", () => {
    const withTracking = classifyShortVideoUrl(
      "https://www.tiktok.com/@u/video/7301234567890123456?is_from_webapp=1&sender_device=pc&_r=1",
    );
    const without = classifyShortVideoUrl(
      "https://www.tiktok.com/@u/video/7301234567890123456",
    );
    expect(withTracking?.url).toBe(without?.url);
    expect(withTracking?.url).not.toContain("?");
  });

  it("treats vm/vt/t stubs as needing a redirect rather than guessing an id", () => {
    for (const stub of [
      "https://vm.tiktok.com/ZMabcdef1/",
      "https://vt.tiktok.com/ZSabcdef1/",
      "https://www.tiktok.com/t/ZTabcdef1/",
    ]) {
      const ref = classifyShortVideoUrl(stub);
      expect(ref?.platform).toBe("tiktok");
      expect(ref?.externalId).toBeNull();
    }
  });

  it("handles photo-mode posts and the legacy /v/<id>.html shape", () => {
    expect(
      classifyShortVideoUrl("https://www.tiktok.com/@u/photo/7301234567890123456")?.externalId,
    ).toBe("7301234567890123456");
    expect(
      classifyShortVideoUrl("https://m.tiktok.com/v/7301234567890123456.html")?.externalId,
    ).toBe("7301234567890123456");
  });

  it("ignores links that are not a single piece of content", () => {
    expect(classifyShortVideoUrl("https://www.tiktok.com/@someone")).toBeNull();
    expect(classifyShortVideoUrl("https://www.tiktok.com/tag/cats")).toBeNull();
    expect(classifyShortVideoUrl("https://www.tiktok.com/foryou")).toBeNull();
  });
});

describe("classifyShortVideoUrl — Instagram", () => {
  it("reads the shortcode from every content path", () => {
    for (const path of ["reel", "reels", "p", "tv"]) {
      expect(
        classifyShortVideoUrl(`https://www.instagram.com/${path}/Cx1_ab-cdEF/`)?.externalId,
      ).toBe("Cx1_ab-cdEF");
    }
  });

  it("reads the shortcode from the app's own /<user>/reel/<code> shape", () => {
    expect(
      classifyShortVideoUrl("https://www.instagram.com/someone/reel/Cx1_ab-cdEF/")?.externalId,
    ).toBe("Cx1_ab-cdEF");
  });

  it("strips igsh, which identifies the sharer rather than the post", () => {
    const ref = classifyShortVideoUrl(
      "https://instagram.com/reel/Cx1_ab-cdEF/?igsh=MzRlODBiNWFlZA==",
    );
    expect(ref?.url).toBe("https://instagram.com/reel/Cx1_ab-cdEF/");
  });

  it("treats /share/ links as needing a redirect", () => {
    const ref = classifyShortVideoUrl("https://www.instagram.com/share/reel/_abcDEF123/");
    expect(ref?.platform).toBe("instagram");
    expect(ref?.externalId).toBeNull();
  });
});

describe("classifyShortVideoUrl — the allowlist is the SSRF wall", () => {
  it("refuses a lookalike host that merely ends in the brand", () => {
    expect(classifyShortVideoUrl("https://tiktok.com.evil.tld/@u/video/7301234567890")).toBeNull();
    expect(classifyShortVideoUrl("https://eviltiktok.com/@u/video/7301234567890")).toBeNull();
    expect(classifyShortVideoUrl("https://notinstagram.com/reel/Cx1_ab-cdEF/")).toBeNull();
  });

  it("refuses non-http(s) schemes outright", () => {
    expect(classifyShortVideoUrl("file:///etc/passwd")).toBeNull();
    expect(classifyShortVideoUrl("gopher://tiktok.com/@u/video/7301234567890")).toBeNull();
  });

  it("keeps page hosts and poster hosts as separate walls", () => {
    expect(isShortVideoHost("www.tiktok.com")).toBe(true);
    expect(isShortVideoHost("p16-sign.tiktokcdn-us.com")).toBe(false);
    expect(isPosterHost("p16-sign.tiktokcdn-us.com")).toBe(true);
    expect(isPosterHost("scontent-fra3-1.cdninstagram.com")).toBe(true);
    expect(isPosterHost("www.tiktok.com")).toBe(false);
  });
});

describe("findShortVideoLink", () => {
  it("finds a link inside a sentence and keeps the sentence separately", () => {
    const text = "вот это меня убивает https://vm.tiktok.com/ZMabcdef1/ каждый раз";
    expect(findShortVideoLink(text)?.platform).toBe("tiktok");
    expect(commentaryAroundLink(text)).toBe("вот это меня убивает каждый раз");
  });

  it("does not swallow trailing punctuation into the URL", () => {
    const ref = findShortVideoLink("посмотри (https://www.instagram.com/reel/Cx1_ab-cdEF/).");
    expect(ref?.externalId).toBe("Cx1_ab-cdEF");
  });

  it("returns null for ordinary text and for off-platform links", () => {
    expect(findShortVideoLink("мне нравится сухой юмор")).toBeNull();
    expect(findShortVideoLink("https://youtube.com/shorts/abc123")).toBeNull();
  });

  it("reports no commentary when the message is only the link", () => {
    expect(commentaryAroundLink("https://vm.tiktok.com/ZMabcdef1/")).toBeUndefined();
  });
});
