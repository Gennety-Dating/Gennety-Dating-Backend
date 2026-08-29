import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One question, nine senders.
 *
 * An onboarding agent turn is delivered to Telegram from `/start`'s resume, the
 * photo-batch flush, the photo editor, two context-dump paths, the radar
 * resume, the voice step's own resume and `handleConversational`. For a while
 * exactly ONE of them knew the reply might be the voice-prompt ask; the other
 * eight sent it as a plain message. That is not a cosmetic gap:
 *
 *  - no skip button, so the copy names an exit the chat does not have;
 *  - no claim, so `voiceHandler` — mounted ahead of every router — transcribes
 *    the recording and the fact collector mines it. `voice_prompt` is a
 *    synthetic field that text cannot satisfy, so `currentQuestion` never
 *    moves and the agent asks again. Forever, while the rest of the transcript
 *    is written into the profile.
 *
 * Both were live in production code and neither was visible to any test,
 * because every unit of the feature passed in isolation. So the rule is
 * structural rather than remembered: a file that delivers `result.reply` on the
 * bot surface must also know about this step.
 *
 * The check is deliberately coarse — presence of the helper, not a parse of
 * control flow. It cannot prove a given branch is routed; it can only fail the
 * case that actually happened, which is a whole file learning to send agent
 * replies while knowing nothing about the voice prompt.
 */
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
