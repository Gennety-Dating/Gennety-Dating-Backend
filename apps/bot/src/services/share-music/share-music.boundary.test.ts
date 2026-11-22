import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A shared playlist is "music taste" in its purest form, and the profile's
 * music is display-only by the Spotify Developer Policy (decision 2026-09-11,
 * the `ProfileMusicTrack` model comment). So the share-music read must never
 * reach a model, a prompt or the matcher — not even "just to tidy titles".
 */
const DIR = import.meta.dirname;
const FORBIDDEN =
  /openai|models\.js|ai\/prompts|embedding|matcher|matching|chat-agent|agent-memory|profileMusicTrack|musicTracks\s*:/iu;

describe("share-music stays out of AI", () => {
  it("no source in services/share-music imports a model, a prompt or the pinned-track table", () => {
    const files = readdirSync(DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const name of files) {
      const imports = readFileSync(join(DIR, name), "utf8")
        .split("\n")
        .filter((line) => /^\s*(?:import|export)\b.*from\s+["']/u.test(line) || /\bimport\(/u.test(line))
        .join("\n");
      expect(FORBIDDEN.test(imports), name).toBe(false);
      expect(/profileMusicTrack/u.test(readFileSync(join(DIR, name), "utf8")), name).toBe(false);
    }
  });
});
