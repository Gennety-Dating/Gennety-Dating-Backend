import { describe, it, expect, vi, beforeEach } from "vitest";

const openaiFetch = vi.hoisted(() => vi.fn());
vi.mock("../openai-fetch.js", () => ({ openaiFetch }));
vi.mock("../../config.js", () => ({ env: { OPENAI_API_KEY: "test-key" } }));

import { generateMatchCardTexts } from "./copy.js";

/**
 * The card speaks in the platform's voice, on a stranger's screen, and its only
 * substantive input is text the OTHER person wrote about themselves. That makes
 * it the highest-trust surface this product has and the most attractive place
 * to land a phishing line.
 */

function respondWith(payload: Record<string, unknown>) {
  openaiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    text: async () => "",
  });
}

const input = {
  language: "en" as const,
  partnerFirstName: "Bea",
  partnerAge: 26,
  partnerSummary: "Quiet, reads a lot, makes very good coffee.",
};

beforeEach(() => openaiFetch.mockReset());

describe("generateMatchCardTexts", () => {
  it("renders ordinary copy", async () => {
    respondWith({
      tagline: "Quiet, and good at it.",
      paragraph: "Reads more than she says. Being around her is unhurried.",
    });

    const card = await generateMatchCardTexts(input);

    expect(card?.tagline).toBe("Quiet, and good at it.");
    expect(card?.paragraphs[0]).toContain("unhurried");
  });

  it("falls back to the plain album rather than print a contact channel", async () => {
    // Both attempts return the steered copy, so the card is refused outright.
    // Cleaning the line would leave the framing that produced it — and the
    // Zero-Chat rule says contact details move through one moderated flow.
    respondWith({
      tagline: "Message her first at t.me/bea_real",
      paragraph: "She prefers talking there.",
    });

    await expect(generateMatchCardTexts(input)).resolves.toBeNull();
    // One retry, then the downgrade — the same path a malformed body takes.
    expect(openaiFetch).toHaveBeenCalledTimes(2);
  });

  it("catches the channel in the paragraph too", async () => {
    respondWith({
      tagline: "Quiet, and good at it.",
      paragraph: "Reach her on +7 999 123 45 67 before the date.",
    });

    await expect(generateMatchCardTexts(input)).resolves.toBeNull();
  });

  it("keeps a card whose second attempt comes back clean", async () => {
    openaiFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  tagline: "dm @bea_real",
                  paragraph: "She prefers talking there.",
                }),
              },
            },
          ],
        }),
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  tagline: "Quiet, and good at it.",
                  paragraph: "Reads more than she says.",
                }),
              },
            },
          ],
        }),
        text: async () => "",
      });

    const card = await generateMatchCardTexts(input);

    expect(card?.tagline).toBe("Quiet, and good at it.");
  });
});
