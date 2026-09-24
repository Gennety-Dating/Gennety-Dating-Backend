import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";


const HANDLERS_DIR = fileURLToPath(new URL("../", import.meta.url));

/** Delivers a reply from a DIFFERENT agent — the post-onboarding concierge. */
const NOT_THE_ONBOARDING_AGENT = new Set(["menu/router.ts"]);

const AWARE_OF_THE_STEP = [
  "sendVoicePromptAskIfRequested",
  // The radar resume owns no session object, so it arms through the patch it
  // returns and sends the ask through the shared payload builder — the text AND
  // the bottom panel, so its send cannot drift from the ordinary one.
  "voicePromptAskPayload",
];

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) return walk(full, rel);
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) return [];
    return [rel];
  });
}

describe("every sender of an onboarding agent reply knows about the voice prompt", () => {
  it("has no file that delivers result.reply without the helper", () => {
    const offenders: string[] = [];

    for (const rel of walk(HANDLERS_DIR)) {
      if (NOT_THE_ONBOARDING_AGENT.has(rel)) continue;
      const source = readFileSync(join(HANDLERS_DIR, rel), "utf8");
      if (!source.includes("result.reply")) continue;
      if (AWARE_OF_THE_STEP.some((marker) => source.includes(marker))) continue;
      offenders.push(rel);
    }

    expect(
      offenders,
      "these files send an onboarding agent reply and cannot send the voice-prompt " +
        "ask correctly — route the reply through sendVoicePromptAskIfRequested()",
    ).toEqual([]);
  });

  it("still sees the senders it is meant to be guarding", () => {
    // A rename or a refactor that empties this list would leave the test above
    // green over nothing at all — the failure mode of every source-text guard.
    const senders = walk(HANDLERS_DIR).filter(
      (rel) =>
        !NOT_THE_ONBOARDING_AGENT.has(rel) &&
        readFileSync(join(HANDLERS_DIR, rel), "utf8").includes("result.reply"),
    );

    expect(senders).toContain("start.ts");
    expect(senders).toContain("onboarding/conversational.ts");
    expect(senders.length).toBeGreaterThanOrEqual(4);
  });
});
