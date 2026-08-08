import { describe, expect, it } from "vitest";

import {
  buildProxyReplyPrompt,
  partnerTurnIndex,
  validateProxyReply,
  type ProxyReplyInput,
} from "./proxy-partner.js";

function input(overrides: Partial<ProxyReplyInput> = {}): ProxyReplyInput {
  return {
    partnerName: "Ева",
    partnerGender: "female",
    visitorName: "Максим",
    language: "ru",
    venueName: "Aroma Kava",
    venueAddress: "вул. Хрещатик 14, Київ",
    agreedTime: new Date("2026-08-20T16:00:00Z"),
    timeZone: "Europe/Kyiv",
    transcript: [],
    ...overrides,
  };
}

describe("the puppet's prompt", () => {
  it("hands the model the date it is actually turning up to", () => {
    const { system } = buildProxyReplyPrompt(input());
    expect(system).toContain("Ева");
    expect(system).toContain("Максим");
    expect(system).toContain("Aroma Kava");
    expect(system).toContain("вул. Хрещатик 14, Київ");
    // 16:00Z is 19:00 in Kyiv — the venue's own wall clock, not UTC, or the
    // puppet would name a time neither side means.
    expect(system).toContain("19:00");
  });

  it("names the language explicitly rather than leaving it to the transcript", () => {
    // An opener has no transcript to infer a language from, and that is exactly
    // the turn where getting it wrong is most visible.
    expect(buildProxyReplyPrompt(input({ transcript: [] })).system).toContain("Russian");
    expect(buildProxyReplyPrompt(input({ language: "uk" })).system).toContain("Ukrainian");
    expect(buildProxyReplyPrompt(input({ language: null })).system).toContain("English");
  });

  it("opens by asking something, so the visitor has a reason to enter the chat", () => {
    const { system, user } = buildProxyReplyPrompt(input({ transcript: [] }));
    expect(system).toContain("Write FIRST");
    expect(user).toContain("nothing has been said yet");
  });

  it("has arrived by its second message", () => {
    const { system } = buildProxyReplyPrompt(
      input({ transcript: [{ from: "partner", body: "подъезжаю" }] }),
    );
    expect(system).toContain("just arrived");
    expect(system).not.toContain("Write FIRST");
  });

  it("settles into finding each other from the third onwards", () => {
    const { system } = buildProxyReplyPrompt(
      input({
        transcript: [
          { from: "partner", body: "подъезжаю" },
          { from: "visitor", body: "я уже тут" },
          { from: "partner", body: "у окна сижу" },
        ],
      }),
    );
    expect(system).toContain("already at the venue");
    // The product forbids conversation before the meeting; a puppet that started
    // one would demo a feature we deliberately do not have.
    expect(system).toContain("do not start a");
  });

  it("attributes the transcript by person, not by role label", () => {
    const { user } = buildProxyReplyPrompt(
      input({
        transcript: [
          { from: "partner", body: "почти на месте" },
          { from: "visitor", body: "ок, жду" },
        ],
      }),
    );
    expect(user).toContain("You: почти на месте");
    expect(user).toContain("Максим: ок, жду");
  });

  it("forbids breaking character in the system prompt itself", () => {
    const { system } = buildProxyReplyPrompt(input());
    expect(system).toContain("never mention being an AI");
    expect(system).toContain("you are not an assistant");
  });

  it("counts only the puppet's own turns", () => {
    expect(
      partnerTurnIndex([
        { from: "visitor", body: "a" },
        { from: "partner", body: "b" },
        { from: "visitor", body: "c" },
      ]),
    ).toBe(1);
  });
});

describe("validating what the model wrote", () => {
  it("keeps an ordinary text message", () => {
    expect(validateProxyReply("Я почти на месте, буду через 10 минут", "Ева")).toBe(
      "Я почти на месте, буду через 10 минут",
    );
  });

  it("strips the speaker label the relay would otherwise print twice", () => {
    // The relay already prefixes "💬 Ева: ".
    expect(validateProxyReply("Ева: я у входа", "Ева")).toBe("я у входа");
  });

  it("strips wrapping quotes", () => {
    expect(validateProxyReply('"я уже тут"', "Ева")).toBe("я уже тут");
  });

  it("collapses a multi-line answer into one message", () => {
    expect(validateProxyReply("я тут\n\nу окна", "Ева")).toBe("я тут у окна");
  });

  it("rejects an essay", () => {
    expect(validateProxyReply("а".repeat(400), "Ева")).toBeNull();
  });

  it("rejects a link", () => {
    expect(validateProxyReply("вот карта https://maps.google.com/x", "Ева")).toBeNull();
  });

  it("rejects a broken character", () => {
    // In a demo this is the one message the visitor would remember.
    expect(validateProxyReply("As an AI language model I cannot meet you", "Ева")).toBeNull();
    expect(validateProxyReply("я нейросеть, у меня нет тела", "Ева")).toBeNull();
  });

  it("rejects nothing at all", () => {
    expect(validateProxyReply("   ", "Ева")).toBeNull();
    expect(validateProxyReply("", "Ева")).toBeNull();
  });

  it("treats a name with regex metacharacters as literal text", () => {
    // `partnerName` comes from the seeded profile, but building a RegExp out of a
    // name is the kind of thing that throws on the one input nobody tried.
    expect(() => validateProxyReply("привет", "A.(B)")).not.toThrow();
  });
});
