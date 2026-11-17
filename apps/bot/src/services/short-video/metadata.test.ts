import { describe, expect, it } from "vitest";
import { parseTikTokEmbed } from "./metadata.js";

function embedPage(state: unknown): string {
  return `<html><head><title>TikTok Embed</title></head><body>
<script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify(state)}</script>
</body></html>`;
}

const ITEM = {
  source: {
    data: {
      "/embed/6768504823336815877": {
        isReady: true,
        videoData: {
          itemInfos: {
            id: "6768504823336815877",
            text: "They rejected my  application\nto Hogwarts",
            covers: ["https://p16-common-sign.tiktokcdn.com/a.jpeg"],
            coversOrigin: ["https://p16-common-sign.tiktokcdn.com/origin.jpeg"],
          },
          authorInfos: { uniqueId: "zachking", nickName: "Zach King" },
        },
      },
    },
  },
};

describe("parseTikTokEmbed", () => {
  it("reads the caption, the original cover and the author from the embed state", () => {
    expect(parseTikTokEmbed(embedPage(ITEM))).toEqual({
      caption: "They rejected my application to Hogwarts",
      authorName: "Zach King",
      posterUrl: "https://p16-common-sign.tiktokcdn.com/origin.jpeg",
    });
  });

  it("falls back to covers and the handle when the richer fields are missing", () => {
    const state = structuredClone(ITEM);
    const entry = state.source.data["/embed/6768504823336815877"].videoData;
    (entry.itemInfos as Record<string, unknown>).coversOrigin = [];
    (entry.authorInfos as Record<string, unknown>).nickName = "";
    expect(parseTikTokEmbed(embedPage(state))).toMatchObject({
      authorName: "zachking",
      posterUrl: "https://p16-common-sign.tiktokcdn.com/a.jpeg",
    });
  });

  it("is null for a removed or private video (no videoData)", () => {
    const removed = { source: { data: { "/embed/1": { isReady: true, isError: true, videoData: null } } } };
    expect(parseTikTokEmbed(embedPage(removed))).toBeNull();
  });

  it("is null for a page without the state script or with broken JSON", () => {
    expect(parseTikTokEmbed("<html>login</html>")).toBeNull();
    expect(
      parseTikTokEmbed('<script id="__FRONTITY_CONNECT_STATE__">{not json</script>'),
    ).toBeNull();
  });
});
