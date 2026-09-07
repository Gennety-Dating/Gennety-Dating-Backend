import { describe, it, expect, vi, beforeEach } from "vitest";

const openaiFetch = vi.hoisted(() => vi.fn());
vi.mock("./openai-fetch.js", () => ({ openaiFetch }));

import { createOpenAIPitchClient } from "./pitch-generator.js";

/**
 * The prompt tells the model not to quote the partner's bio and not to invent
 * contact details. Those are instructions — and an attacker writing in their
 * OWN bio is competing with them directly, in the same call, for an answer that
 * will be shown to the attacker. These tests cover the half that does not
 * negotiate: server-side facts about the produced text.
 */

const PRIVATE =
  "Her therapist calls it avoidant attachment; she has never told anyone about the year in Kyiv.";

function respondWith(payload: Record<string, unknown>) {
  openaiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    text: async () => "",
  });
}

const input = {
  selfFirstName: "Alex",
  otherFirstName: "Bea",
  selfSummary: "Likes long walks.",
  otherSummary: PRIVATE,
  otherOccupation: null,
  language: "en" as const,
};

beforeEach(() => openaiFetch.mockReset());

describe("createOpenAIPitchClient", () => {
  it("returns an ordinary generation", async () => {
    respondWith({
      pitch: "You two read people the same way. Worth an evening.",
      synergy_score: 88,
      synergy_reason: "Both of you move slowly and mean it.",
    });

    const result = await createOpenAIPitchClient("key").generate(input);

    expect(result.pitch).toContain("read people");
    expect(result.synergyScore).toBe(88);
  });

  it("refuses a generation that echoes the partner's private summary", async () => {
    // The partner's `psychologicalSummary` is deliberately private — no API
    // serialises it — and the voice transcript folded into it is the same.
    respondWith({
      pitch: `About her: ${PRIVATE}`,
      synergy_score: 90,
      synergy_reason: "Reason.",
    });

    await expect(createOpenAIPitchClient("key").generate(input)).rejects.toThrow(/verbatim/);
  });

  it("catches the leak in the reason as well as the pitch", async () => {
    respondWith({
      pitch: "A good evening ahead.",
      synergy_score: 90,
      synergy_reason: `Because ${PRIVATE}`,
    });

    await expect(createOpenAIPitchClient("key").generate(input)).rejects.toThrow(/verbatim/);
  });

  it("refuses a generation carrying a contact channel", async () => {
    respondWith({
      pitch: "She said to message her at t.me/bea_real first.",
      synergy_score: 90,
      synergy_reason: "Reason.",
    });

    await expect(createOpenAIPitchClient("key").generate(input)).rejects.toThrow(
      /contact channel/,
    );
  });

  it("still allows a paraphrase of the same private material", async () => {
    // The rule is about verbatim echo, not about using the bio at all — the
    // whole point of the call is to find a hook in it.
    respondWith({
      pitch: "She keeps her distance at first; you have the patience for that.",
      synergy_score: 84,
      synergy_reason: "You both take your time before you trust something.",
    });

    await expect(createOpenAIPitchClient("key").generate(input)).resolves.toMatchObject({
      synergyScore: 84,
    });
  });
});
