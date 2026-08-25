import { describe, expect, it } from "vitest";

import { CANVAS_TABLES, type Lang } from "./i18n.js";
import {
  CANVAS_STATES,
  formatCountdown,
  isCanvasState,
  sheetFor,
  type CanvasInput,
  type CanvasState,
  type RadarReading,
} from "./sheet.js";
import { stringsFor } from "./i18n.js";

const NOW = new Date("2026-09-03T16:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const LANGS: Lang[] = ["en", "ru", "uk", "de", "pl"];

function input(overrides: Partial<CanvasInput> = {}): CanvasInput {
  return { state: "IDLE_EXPLORING", lang: "en", serverNow: NOW, ...overrides };
}

describe("formatCountdown", () => {
  const s = stringsFor("en");

  it("collapses a passed deadline instead of showing a negative", () => {
    expect(formatCountdown(-1, s)).toBe(s.soon);
    expect(formatCountdown(0, s)).toBe(s.soon);
  });

  it("reads days and hours, then hours and minutes, then minutes", () => {
    expect(formatCountdown(2 * DAY + 3 * HOUR, s)).toBe("2d 3h");
    expect(formatCountdown(3 * HOUR + 10 * MINUTE, s)).toBe("3h 10m");
    expect(formatCountdown(9 * MINUTE, s)).toBe("9m");
  });

  // Rounding up is the same rule the radar's ETA follows: "in 2h" that turns
  // out to be 2h05 is a lie; "in 3h" that turns out to be 2h55 is not.
  it("rounds up rather than down", () => {
    expect(formatCountdown(90 * 1000, s)).toBe("2m");
  });

  it("never renders a 24-hour bucket", () => {
    expect(formatCountdown(DAY + 23 * HOUR + 59 * MINUTE, s)).toBe("2d");
    expect(formatCountdown(HOUR + 59 * MINUTE + 59_000, s)).toBe("2h");
  });

  it("counts in the reader's own units, not English letters", () => {
    expect(formatCountdown(3 * HOUR, stringsFor("ru"))).toContain("ч");
    expect(formatCountdown(3 * HOUR, stringsFor("uk"))).toContain("год");
    expect(formatCountdown(3 * HOUR, stringsFor("pl"))).toContain("godz");
  });
});

describe("sheetFor", () => {
  it("covers every state the server can send", () => {
    for (const state of CANVAS_STATES) {
      const view = sheetFor(input({ state, agreedTime: new Date(NOW.getTime() + HOUR) }));
      expect(view.title.length).toBeGreaterThan(0);
      expect(view.body.length).toBeGreaterThan(0);
    }
  });

  it("rejects a state it does not know rather than rendering it", () => {
    expect(isCanvasState("DATE_BUMP_PENDING")).toBe(true);
    expect(isCanvasState("SOMETHING_NEW")).toBe(false);
  });

  it("counts down to the next drop when idle, and says so plainly without one", () => {
    const withDrop = sheetFor(
      input({ nextDropAt: new Date(NOW.getTime() + 2 * DAY + HOUR) }),
    );
    expect(withDrop.body).toContain("2d");
    // No drop time is a deliberate product state (§2.1 mode 5), not an error.
    const without = sheetFor(input({ nextDropAt: null }));
    expect(without.body).toBe(stringsFor("en").idleNoDrop);
    expect(without.action).toBeNull();
  });

  it("names the venue on a scheduled date and counts down to it", () => {
    const view = sheetFor(
      input({
        state: "DATE_SCHEDULED",
        agreedTime: new Date(NOW.getTime() + 3 * HOUR),
        venueName: "Kavarnya",
      }),
    );
    expect(view.title).toContain("3h");
    expect(view.body).toBe("Kavarnya");
  });

  it("offers the shake once, then stops offering it", () => {
    const before = sheetFor(input({ state: "DATE_BUMP_PENDING" }));
    expect(before.action).toBe("shake");
    // A second shake from the same phone can never verify a pair — the server
    // reads the PEER's column — so re-arming would say otherwise.
    const after = sheetFor(input({ state: "DATE_BUMP_PENDING", bumpMine: true }));
    expect(after.action).toBeNull();
    expect(after.actionLabel).toBeUndefined();
  });

  it("shows the deck only once there is one", () => {
    expect(sheetFor(input({ state: "DATE_IN_PROGRESS" })).list).toBeUndefined();
    const view = sheetFor(input({ state: "DATE_IN_PROGRESS", deck: ["one", "two"] }));
    expect(view.list).toEqual(["one", "two"]);
    expect(view.tone).toBe("warm");
  });

  describe("the radar's one sentence", () => {
    const radarInput = (radar: RadarReading | null) =>
      sheetFor(input({ state: "DATE_RADAR_ACTIVE", venueName: "Kavarnya", radar }));

    it("says nothing about a partner who has not pinged", () => {
      expect(radarInput(null).note).toBe(stringsFor("en").radarPeerUnknown);
    });

    it("renders the ETA it was given", () => {
      expect(radarInput({ peer: "en_route", peerEtaLocal: "18:55", bothArrived: false }).note)
        .toContain("18:55");
    });

    // An en-route reading with no ETA is a partial answer, and "on the way,
    // arriving —" is worse than not claiming to know.
    it("falls back to silence rather than a blank arrival time", () => {
      expect(radarInput({ peer: "en_route", bothArrived: false }).note).toBe(
        stringsFor("en").radarPeerUnknown,
      );
    });

    it("celebrates only when both are there", () => {
      expect(radarInput({ peer: "arrived", bothArrived: false }).tone).toBe("quiet");
      const both = radarInput({ peer: "arrived", bothArrived: true });
      expect(both.tone).toBe("warm");
      expect(both.note).toBe(stringsFor("en").radarBothArrived);
    });
  });

  // The invariant this whole module exists to hold. The server already
  // enforces it; a client that invented a hint would reopen it on the one
  // screen a user stares at while deciding.
  describe("the blind decision", () => {
    // Asserted as an EXACT shape rather than by scanning for forbidden words.
    // A vocabulary list cannot be trusted here in both directions: it false-
    // positives on copy that legitimately says "tell me yes or no" (addressed
    // to the user, not about the partner), and it silently misses whatever
    // phrasing a future edit invents. Pinning the whole view can do neither.
    it("carries no field about the partner while a decision is owed", () => {
      for (const lang of LANGS) {
        const s = stringsFor(lang);
        const view = sheetFor(
          input({
            state: "DROP_PENDING_DECISION",
            lang,
            deadlineAt: new Date(NOW.getTime() + 5 * HOUR),
            // A `proposed` match HAS no agreed time — the countdown here is the
            // reply deadline, and handing it one must not change that.
            agreedTime: new Date(NOW.getTime() + 3 * 24 * HOUR),
            // Even handed a radar reading and a verified bump, the decision
            // sheet must use neither — both would describe the partner.
            radar: { peer: "arrived", bothArrived: true },
            bumpMine: true,
            deck: ["something the partner said"],
            venueName: "Kavarnya",
          }),
        );
        expect(view, lang).toEqual({
          title: s.decisionTitle,
          body: s.decisionBody.replace("{time}", formatCountdown(5 * HOUR, s)),
          action: "chat",
          actionLabel: s.openChat,
          tone: "urgent",
        });
      }
    });

    it("counts the reply deadline, never the agreed time", () => {
      // The trap this pins: `agreedTime` is null on every real `proposed`
      // match, so a sheet reading it would drop its clause on the ONE state
      // whose clock is running — and would count the wrong clock the moment a
      // stale value survived a transition.
      const view = sheetFor(
        input({
          state: "DROP_PENDING_DECISION",
          deadlineAt: new Date(NOW.getTime() + 2 * HOUR),
          agreedTime: new Date(NOW.getTime() + 3 * 24 * HOUR),
        }),
      );
      const s = stringsFor("en");
      expect(view.body).toBe(s.decisionBody.replace("{time}", formatCountdown(2 * HOUR, s)));
    });

    it("drops the deadline clause rather than rendering a placeholder", () => {
      // An older server sends no `deadlineAt` at all; saying nothing about the
      // clock beats printing a token.
      const view = sheetFor(input({ state: "DROP_PENDING_DECISION", deadlineAt: null }));
      expect(view.body).not.toContain("{time}");
      expect(view.action).toBe("chat");
    });
  });

  it("leaves no placeholder unreplaced in any state or language", () => {
    for (const lang of LANGS) {
      for (const state of CANVAS_STATES) {
        const view = sheetFor(
          input({
            state: state as CanvasState,
            lang,
            nextDropAt: new Date(NOW.getTime() + DAY),
            agreedTime: new Date(NOW.getTime() + HOUR),
            venueName: "Kavarnya",
            radar: { peer: "en_route", peerEtaLocal: "18:55", bothArrived: false },
          }),
        );
        const wire = `${view.title} ${view.body} ${view.note ?? ""}`;
        expect(wire, `${lang}/${state}`).not.toMatch(/\{(time|eta|n)\}/);
      }
    }
  });
});

describe("the copy's own rules", () => {
  it("is complete in all five languages", () => {
    const keys = Object.keys(CANVAS_TABLES.en).sort();
    for (const lang of LANGS) {
      expect(Object.keys(CANVAS_TABLES[lang]).sort(), lang).toEqual(keys);
      for (const [key, value] of Object.entries(CANVAS_TABLES[lang])) {
        expect(value.length, `${lang}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  // Two product-wide voice rules, each easy to break one string at a time.
  it("addresses the user informally in ru/uk", () => {
    for (const lang of ["ru", "uk"] as const) {
      for (const [key, value] of Object.entries(CANVAS_TABLES[lang])) {
        expect(value.toLowerCase(), `${lang}.${key}`).not.toMatch(/\bвам\b|\bваш(е|а|и)\b/);
      }
    }
  });

  it("keeps Ukrainian from being a copy of Russian", () => {
    // Identical strings here would read to a Ukrainian speaker as "they didn't
    // translate it" whatever the dictionary says (PRODUCT_SPEC 2026-08-19).
    // Identical is legitimate where the two languages genuinely spell a phrase
    // the same way; what the rule forbids is an untranslated string passing as
    // one, so each entry needs a stated reason (PRODUCT_SPEC 2026-08-19). These
    // two are the complete current set, measured rather than guessed:
    //   radarTitle — «Уже скоро» is spelled identically in both languages.
    //   days       — «д» abbreviates день in both. The other units differ
    //                (ч/год, мин/хв), which is what makes this one a genuine
    //                collision rather than a forgotten row.
    const allowed = new Set(["radarTitle", "days"]);
    for (const key of Object.keys(CANVAS_TABLES.ru) as (keyof typeof CANVAS_TABLES.ru)[]) {
      if (allowed.has(key as string)) continue;
      expect(CANVAS_TABLES.uk[key], key as string).not.toBe(CANVAS_TABLES.ru[key]);
    }
  });

  it("does not leak the other alphabet's letters", () => {
    for (const value of Object.values(CANVAS_TABLES.uk)) {
      expect(value).not.toMatch(/[ыэъё]/i);
    }
    for (const value of Object.values(CANVAS_TABLES.ru)) {
      expect(value).not.toMatch(/[іїєґ]/i);
    }
  });
});

describe("the Scratch Map's line", () => {
  // It appears on exactly one state: the one where the canvas IS a map. On the
  // others it would be a souvenir competing with a date for the same slot.
  it("is shown only while exploring", () => {
    const withLabel = sheetFor(input({ state: "IDLE_EXPLORING", exploredLabel: "12.5%" }));
    expect(withLabel.note).toContain("12.5%");

    for (const state of ["DATE_SCHEDULED", "DATE_RADAR_ACTIVE", "DATE_IN_PROGRESS"] as const) {
      const other = sheetFor(input({ state, exploredLabel: "12.5%" }));
      expect(other.note ?? "").not.toContain("12.5%");
    }
  });

  it("is absent when there is nothing to say", () => {
    expect(sheetFor(input({ state: "IDLE_EXPLORING" })).note).toBeUndefined();
  });
});
