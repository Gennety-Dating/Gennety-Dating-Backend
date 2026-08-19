import { describe, expect, it } from "vitest";
// `?raw` rather than `node:fs`: this package compiles with `types: []`, so a
// Node builtin would break `pnpm typecheck` even though vitest runs it happily.
// The module itself exports NOTHING — it is a Mini App entry that runs on
// import for its DOM side effects — so its copy table is only reachable as
// source text, and adding an export purely for a test would be the first one
// this file has ever had.
import SRC from "./location.ts?raw";

/**
 * The vibe step of the Location Mini App narrates its own wait with a local
 * `thinkingSteps` ticker (`VIBE_UI[lang].thinkingSteps`) — a five-language copy
 * table that duplicates, word for word, the bot's `profilerBatchThinking` /
 * `profilerNextFormulating` beats without sharing a line of code with them
 * (`apps/webapp` deliberately does not depend on `@gennety/shared`).
 *
 * That duplication is why the Ukrainian entry sat at "Думаю…" — byte-identical
 * to Russian — for as long as the bot's did, and was fixed in the same pass
 * (2026-08-19). Nothing pinned it: `location.test.ts` drives the DOM and never
 * looks at this table.
 *
 * One property, and it is the one that regressed: the five tickers are five
 * DIFFERENT tickers. A language whose middle beat is copied from its neighbour
 * reads to that user as untranslated, whatever the dictionary says.
 */
describe("Location Mini App vibe ticker", () => {
  const tickers = [...SRC.matchAll(/thinkingSteps: (\[[^\]]*\]),/g)].map(
    (m) => m[1],
  );

  it("has one ticker per supported language", () => {
    // 5 locales + the `VibeUi` interface declaration this regex cannot match
    // (`thinkingSteps: string[];`), so exactly five array literals.
    expect(tickers).toHaveLength(5);
  });

  it("gives every language its own wording", () => {
    expect(new Set(tickers).size).toBe(tickers.length);
  });

  it("no longer narrates the Ukrainian wait with the Russian word", () => {
    // The ru ticker keeps "Думаю…" — it is correct there. The uk one must not.
    const uk = tickers.find((t) => t.includes("Зчитую вайб"));
    expect(uk, "the Ukrainian ticker moved or was reworded").toBeDefined();
    expect(uk).not.toContain("Думаю…");
    expect(uk).toContain("Обмірковую…");
  });
});
