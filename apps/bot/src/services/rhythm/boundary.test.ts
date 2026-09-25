import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The fence around Apple Health data (Tempo Sync, decision journal 2026-09-24).
 *
 * Life rhythm is derived from HealthKit, so three sets of rules hold at once:
 * App Store 5.1.2(vi)/5.1.3(i) and the Developer Program License Agreement
 * (never disclosed to third parties, never used beyond what the person agreed
 * to), and GDPR Art. 9 (special-category data, explicit consent). In Gennety
 * the "third parties" that are one import away are: the OpenAI prompts (pitch,
 * summaries, concierge, Wingman), the Hermes agent behind `/admin/*`, the
 * Telegram bot's messages, the founder DM feed — and the PARTNER, via the
 * match payload or "explain my match".
 *
 * So every file that can touch rhythm is named below with its reason, and a
 * new one fails this test on purpose. Before adding it to READERS, make sure
 * it cannot carry a person's tags — or anything derived from them — into a
 * prompt, a bot message, an admin per-user read, a founder DM or the partner.
 * Aggregates over pairs (`admin/routes/rhythm-outcomes.ts`) are the one
 * analytics exception, with small cells suppressed.
 */
const SRC = resolve(import.meta.dirname, "../..");

const READERS: Record<string, string> = {
  "services/rhythm/store.ts": "the only module that touches the table",
  "public/routes/rhythm.ts": "the owner's own GET/PUT/DELETE",
  "services/match-engine.ts": "V_rhythm in candidate scoring + MatchScoreLog columns",
  "services/event-rounds.ts": "the same scorer, for party rounds",
  "services/venue-intent-v2.ts": "venue Tier 2 inside the sampling band + post-date pick",
  "workers/retention.ts": "deletes profiles stale for 35 days",
  "admin/routes/rhythm-outcomes.ts": "pair aggregates, cells < 20 suppressed",
  "demo/driver.ts": "writes a neutral breakdown (rhythmSimilarity: null), reads nothing",
};

/** Anything that reads the table, the store, or the logged pair similarity. */
const RHYTHM_ACCESS =
  /\buserRhythmProfile\b|\brhythmProfile\b|user_rhythm_profiles|rhythm\/store(\.js)?["']|\brhythmSimilarity\b|\bscoreRhythm\b|rhythm_similarity|score_rhythm/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "__fixtures__" ? [] : sourceFiles(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("life rhythm stays inside its fence", () => {
  const files = sourceFiles(SRC).map((file) => ({
    path: relative(SRC, file),
    text: readFileSync(file, "utf8"),
  }));

  it("only the allow-listed files touch rhythm", () => {
    const readers = files
      .filter((file) => RHYTHM_ACCESS.test(file.text))
      .map((file) => file.path)
      .sort();
    expect(readers, "a new reader of life rhythm — read the comment above READERS").toEqual(
      Object.keys(READERS).sort(),
    );
  });

  it("nothing reads a whole MatchScoreLog row (it carries the pair similarity)", () => {
    const wholeRow = files
      .filter((file) => /\bscoreLog:\s*true\b|SELECT\s+\*\s+FROM\s+"?match_score_logs/i.test(file.text))
      .map((file) => file.path);
    expect(wholeRow, "select MatchScoreLog columns explicitly, never the whole row").toEqual([]);
  });

  it("no prompt-building or messaging module is among the readers", () => {
    // Belt and braces for the list above: these directories are where a
    // person's data turns into text someone else reads.
    const forbidden = /^(services\/(ai|openai|prompt|pitch|wingman|concierge|founder-notify|agent)|handlers\/)/;
    expect(Object.keys(READERS).filter((path) => forbidden.test(path))).toEqual([]);
  });
});
