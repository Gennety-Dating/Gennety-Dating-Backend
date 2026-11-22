import { describe, expect, it, vi } from "vitest";

/**
 * Vibe cards (decision 2026-11-21): validation, clamping, the gap, refusals,
 * sticker choice, reading back — and the turn gating with the safety words.
 */

const env = { AGENT_VIBE_CARDS_ENABLED: true };
vi.mock("../config.js", () => ({ env }));

const { buildVibeCard, readVibeCard, vibeCardNote, vibeCardView, vibeCardsThisTurn, SHOW_VIBE_CARD_TOOL } = await import(
  "./chat-vibe-card.js"
);
const { vibeSafetyHit, vibeSticker } = await import("@gennety/shared");

const aura = {
  kind: "aura",
  personVisible: true,
  allAdults: true,
  score: 87,
  archetype: "Тихая уверенность",
  bars: { energy: 82, style: 91, frame: 74 },
  reads: ["взгляд мимо камеры", "пальто по фигуре", "свет из окна", "лишнее"],
  steps: [{ text: "На свидании телефон экраном вниз — это и есть +1000." }],
  sticker: true,
};

describe("buildVibeCard", () => {
  it("builds an aura card with labels in the account language", () => {
    const out = buildVibeCard(aura, "ru");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.card).toMatchObject({ kind: "vibe_card", cardKind: "aura", title: "Аура", score: 87, scoreLabel: "сила ауры" });
    expect(out.card.bars.map((b) => [b.key, b.label, b.value])).toEqual([
      ["energy", "Энергия", 82],
      ["style", "Стиль", 91],
      ["frame", "Кадр", 74],
    ]);
    expect(out.card.reads).toHaveLength(3);
    expect(out.card.sticker).toEqual({ id: "aura", caption: "+1000 AURA" });
    expect(JSON.parse(out.result)).toMatchObject({ success: true });
  });

  it("clamps numbers and fills a missing bar with the headline", () => {
    const out = buildVibeCard({ ...aura, score: 140, bars: { energy: -5 } }, "en");
    if (!out.ok) throw new Error("refused");
    expect(out.card.score).toBe(100);
    expect(out.card.bars.map((b) => b.value)).toEqual([1, 100, 100]);
  });

  it("attractiveness bars are face, style, presence — no body", () => {
    const out = buildVibeCard({ ...aura, kind: "attractiveness", score: 72, bars: { face: 70, style: 80, presence: 66 } }, "en");
    if (!out.ok) throw new Error("refused");
    expect(out.card.bars.map((b) => b.key)).toEqual(["face", "style", "presence"]);
    expect(out.card.title).toBe("Attractiveness");
    expect(out.card.sticker).toEqual({ id: "lockin", caption: "LOCK IN" });
  });

  it("swag gap: the server computes the gap and fills side labels", () => {
    const out = buildVibeCard(
      {
        kind: "swag_gap",
        personVisible: true,
        allAdults: true,
        people: [
          { label: "", style: "clean old money", freshness: "in_trend", score: 84 },
          { label: "он", style: "худи-кэжуал", freshness: "dated", score: 50 },
        ],
        verdict: "Она могнула, 84% против 50%",
        steps: [{ who: "он", text: "Худи → тёмный овершот." }, { text: "Ничего не менять." }, { text: "третий" }],
      },
      "ru",
    );
    if (!out.ok) throw new Error("refused");
    expect(out.card.score).toBe(34);
    expect(out.card.people.map((p) => p.label)).toEqual(["Слева", "он"]);
    expect(out.card.people[1]!.freshnessLabel).toBe("устарело");
    expect(out.card.verdict).toBe("Она могнула");
    expect(out.card.steps).toHaveLength(2);
    expect(out.card.sticker).toBeNull();
  });

  it.each([
    [{ ...aura, personVisible: false }, "no_person"],
    [{ ...aura, allAdults: false }, "minor_possible"],
    [{ ...aura, allAdults: undefined }, "minor_possible"],
    [{ ...aura, kind: "rate" }, "bad_kind"],
    [{ ...aura, steps: [] }, "no_step"],
    [{ ...aura, score: "много" }, "no_score"],
    [{ kind: "swag_gap", personVisible: true, allAdults: true, people: [{ style: "x", score: 5 }], steps: [{ text: "a" }] }, "two_people"],
  ])("refuses %#", (args, error) => {
    const out = buildVibeCard(args, "ru");
    expect(out.ok).toBe(false);
    expect(JSON.parse(out.result)).toMatchObject({ success: false, error });
  });

  it("cuts long texts at a word", () => {
    const out = buildVibeCard({ ...aura, archetype: "Очень длинный архетип который точно не влезет в карточку" }, "ru");
    if (!out.ok) throw new Error("refused");
    expect([...out.card.archetype!].length).toBeLessThanOrEqual(26);
    expect(out.card.archetype).toBe("Очень длинный архетип");
  });

  it("the tool requires the two checks", () => {
    expect(SHOW_VIBE_CARD_TOOL.function.parameters.required).toEqual(["kind", "personVisible", "allAdults"]);
  });
});

describe("reading back", () => {
  it("round-trips through JSON and drops a bad sticker", () => {
    const out = buildVibeCard(aura, "ru");
    if (!out.ok) throw new Error("refused");
    const back = readVibeCard(JSON.parse(JSON.stringify({ ...out.card, sticker: { id: "heart", caption: null } })));
    expect(back!.sticker).toBeNull();
    expect(vibeCardView(back!)).toMatchObject({ kind: "aura", score: 87, title: "Аура" });
    expect(vibeCardView(back!)).not.toHaveProperty("sticker");
    expect(readVibeCard({ kind: "app_guide" })).toBeNull();
    expect(vibeCardNote(back!)).toContain("Aura card above this reply: 87");
  });
});

describe("stickers", () => {
  it("are chosen by kind and score", () => {
    expect(vibeSticker("aura", 75)).toEqual({ id: "aura", caption: "+1000 AURA" });
    expect(vibeSticker("aura", 74)).toEqual({ id: "lockin", caption: "LOCK IN" });
    expect(vibeSticker("attractiveness", 80)).toEqual({ id: "found", caption: "W" });
    expect(vibeSticker("swag_gap", 20)).toEqual({ id: "lockin", caption: "LOCK IN" });
    expect(vibeSticker("swag_gap", 5)).toEqual({ id: "aura", caption: "vibe check ✓" });
  });
});

describe("turn gating", () => {
  const VIBE = new Set(["vibe"]);
  it("needs the token, a photo and no distress words", () => {
    expect(vibeCardsThisTurn({ chatCards: VIBE, imageCount: 1, recentUserTexts: ["какая у меня аура?"] })).toBe(true);
    expect(vibeCardsThisTurn({ chatCards: new Set(["guide"]), imageCount: 1, recentUserTexts: [] })).toBe(false);
    expect(vibeCardsThisTurn({ chatCards: VIBE, imageCount: 0, recentUserTexts: [] })).toBe(false);
    expect(vibeCardsThisTurn({ chatCards: VIBE, imageCount: 1, recentUserTexts: ["я урод, оцени честно"] })).toBe(false);
  });

  it("the flag turns it off", () => {
    env.AGENT_VIBE_CARDS_ENABLED = false;
    expect(vibeCardsThisTurn({ chatCards: VIBE, imageCount: 1, recentUserTexts: [] })).toBe(false);
    env.AGENT_VIBE_CARDS_ENABLED = true;
  });
});

describe("safety words", () => {
  it.each([
    "я урод",
    "Я УРОДИНА",
    "почти не ем уже неделю",
    "вызываю рвоту после еды",
    "у меня РПП",
    "ненавиджу себе",
    "I hate my face",
    "im ugly lol",
    "ich bin hässlich",
    "jestem brzydka",
    "ненавижу своё лицо",
  ])("hits «%s»", (text) => {
    expect(vibeSafetyHit([text])).toBe(true);
  });

  it.each(["какая у меня аура?", "кто кого могнул", "не ем мясо, где поужинать", "rate my fit", "уродливый свитер на мне, норм?", "оцени красоту"])(
    "misses «%s»",
    (text) => {
      expect(vibeSafetyHit([text])).toBe(false);
    },
  );

  it("the big words are whole: no ellipsis, the first clause only", () => {
    const build = (archetype: string) => {
      const out = buildVibeCard({ kind: "aura", personVisible: true, allAdults: true, score: 80, archetype, bars: {}, steps: [{ text: "Чуть больше света." }] }, "ru");
      return out.ok ? out.card.archetype : null;
    };
    expect(build("Тихая уверенность")).toBe("Тихая уверенность");
    expect(build("Тихая уверенность — и это заметно")).toBe("Тихая уверенность");
    expect(build("Он могнул на гончарном круге сегодня")).toBe("Он могнул на гончарном");
    expect(build("Очень спокойная сила в самом деле")).toBe("Очень спокойная сила");
    expect(build("Clean-cut intensity")).toBe("Clean-cut intensity");
  });
});
