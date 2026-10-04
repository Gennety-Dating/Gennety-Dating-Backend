import { describe, it, expect } from "vitest";
import { profilerContextMarkdown, type ProfilerContextCard } from "./profiler-context.js";

describe("profilerContextMarkdown", () => {
  it("quotes an upcoming date with its local time and venue", () => {
    const card: ProfilerContextCard = {
      kind: "upcoming_date",
      dates: [{ venueName: "Kofein", at: new Date("2026-06-11T16:00:00Z") }],
      answer: null,
    };
    expect(profilerContextMarkdown(card, "ru", "Europe/Kyiv")).toBe(
      "> 🗓 11 июня, 19:00 · 📍 Kofein",
    );
  });

  it("quotes past dates by day only, one per line, and copes without a venue", () => {
    const card: ProfilerContextCard = {
      kind: "past_dates",
      dates: [
        { venueName: "Bar [Mono]", at: new Date("2026-06-01T17:00:00Z") },
        { venueName: null, at: new Date("2026-05-20T17:00:00Z") },
      ],
      answer: null,
    };
    expect(profilerContextMarkdown(card, "en", null)).toBe(
      "> 🗓 1 June · 📍 Bar Mono\n> 🗓 20 May",
    );
  });

  it("quotes the person's own answer without letting it break out of the quote", () => {
    const card: ProfilerContextCard = {
      kind: "own_answer",
      dates: [],
      answer: {
        question: "Is there something you'd love to learn?",
        text: "guitar\n> *and* `drums`",
        answeredAt: new Date("2026-05-03T09:00:00Z"),
      },
    };
    expect(profilerContextMarkdown(card, "en", "Europe/Kyiv")).toBe(
      "> Is there something you'd love to learn?\n> 💬 «guitar and drums» · 3 May",
    );
  });
});
