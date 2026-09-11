import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The tripwire for the Spotify Developer Policy (decision 2026-09-11).
 *
 * The Policy forbids analysing Spotify content "for ... building profiles of
 * users" and ingesting it into any ML/AI model. Gennety IS an AI matchmaker,
 * so the pinned tracks are display-only — and "music taste" is exactly the
 * signal someone will one day want to hand the matcher or a pitch prompt.
 *
 * So any new file that reads the pinned tracks fails here, on purpose. Before
 * adding it to READERS, make sure it only DISPLAYS them: it must not feed the
 * embedding, the matcher, a pitch, a wingman hint or any other prompt.
 */
const SRC = resolve(import.meta.dirname, "../..");
const READERS = ["public/matches-service.ts", "services/music/profile-music.ts"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "__fixtures__" ? [] : sourceFiles(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("pinned tracks stay out of matching and AI", () => {
  it("only the allow-listed files read ProfileMusicTrack", () => {
    const readers = sourceFiles(SRC)
      .filter((file) => /\bprofileMusicTrack\b|\bmusicTracks\s*:/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file))
      .sort();
    expect(readers, "a new reader of the pinned tracks — read the comment above READERS").toEqual(
      READERS,
    );
  });
});
