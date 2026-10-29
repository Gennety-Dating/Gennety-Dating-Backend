import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({ env: { SHORT_VIDEO_FETCH_TIMEOUT_MS: 8000 } }));
vi.mock("@gennety/db", () => ({ prisma: {} }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));

import { clearShareVideoCache, readSharedVideo } from "./read.js";

afterEach(() => vi.unstubAllGlobals());

it("benchmarks a cold Instagram share redirect without fetching the final page twice", async () => {
  for (let sample = 1; sample <= 3; sample += 1) {
    clearShareVideoCache();
    let pageReads = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/share/")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return new Response(null, { status: 302, headers: { location: "https://www.instagram.com/reel/C9xYzAbc/" } });
      }
      pageReads += 1;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return new Response('<meta property="og:description" content="A coffee shop in Kyiv"><meta property="og:title" content="kyiv.coffee">');
    });
    vi.stubGlobal("fetch", fetchFn);
    const start = performance.now();
    const result = await readSharedVideo("https://www.instagram.com/share/ABC123/", { language: "ru", cityKey: "kyiv" }, { analyze: async () => null });
    expect(result.ok && result.video.status).toBe("read");
    expect(result.ok && result.video.url).toBe("https://www.instagram.com/reel/C9xYzAbc/");
    expect(pageReads).toBe(1);
    process.stdout.write(`SHARE_VIDEO_METADATA_BENCH sample=${sample} duration_ms=${Math.round(performance.now() - start)} final_page_reads=${pageReads}\n`);
  }
});
