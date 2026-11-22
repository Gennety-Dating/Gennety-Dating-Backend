import {
  AGENT_STICKER_CAPTIONS,
  AGENT_STICKER_IDS,
  VIBE_ARCHETYPE_MAX_LEN,
  VIBE_BARS,
  VIBE_CARD_KINDS,
  VIBE_CARD_RULES,
  VIBE_FRESHNESS,
  VIBE_PERSON_LABEL_MAX_LEN,
  VIBE_READ_MAX_LEN,
  VIBE_READS_MAX,
  VIBE_SAFETY_LOOKBACK,
  VIBE_SCORE_MAX,
  VIBE_SCORE_MIN,
  VIBE_STEP_MAX_LEN,
  VIBE_STEPS_MAX,
  VIBE_STYLE_MAX_LEN,
  VIBE_VERDICT_MAX_LEN,
  t,
  vibeSafetyHit,
  vibeSticker,
  type AgentSticker,
  type AgentStickerCaption,
  type AgentStickerId,
  type Language,
  type TranslationKey,
  type VibeBarKey,
  type VibeCardKind,
  type VibeFreshness,
} from "@gennety/shared";
import { env } from "../config.js";

/**
 * Vibe cards — aura, attractiveness and swag gap on a photo the person sent
 * (decision 2026-11-21, founder's variant C; spec
 * `docs/product/domains/agent-vibe-cards.md`).
 *
 * The model reads the photo and calls `show_vibe_card` with the numbers and
 * the words; this module refuses what the rules forbid (no person, a possible
 * minor), clamps every number, cuts every text, computes the swag gap, and
 * picks the sticker. Labels come from shared i18n in the account language and
 * are stored with the card, so history draws it as it was.
 *
 * Capability-gated by `X-Gennety-Chat-Cards: vibe`: a build that does not
 * draw the card never gets the tool, and Telegram never sees it.
 */

export const VIBE_CARD_KIND = "vibe_card";
/** Token an app build lists in `X-Gennety-Chat-Cards` when it draws this card. */
export const VIBE_CARD_CLIENT_TOKEN = "vibe";
export const SHOW_VIBE_CARD_TOOL_NAME = "show_vibe_card";

export interface VibeBar {
  key: VibeBarKey;
  label: string;
  value: number;
}

export interface VibePerson {
  label: string;
  style: string;
  freshness: VibeFreshness;
  freshnessLabel: string;
  score: number;
}

export interface VibeStep {
  who: string | null;
  text: string;
}

/** Stored on `messages.attachment`. Everything here is shown; nothing is secret. */
export interface VibeCard {
  kind: typeof VIBE_CARD_KIND;
  cardKind: VibeCardKind;
  title: string;
  /** Aura / attractiveness percent; for swag gap, the gap between the two scores. */
  score: number;
  scoreLabel: string;
  archetype: string | null;
  bars: VibeBar[];
  reads: string[];
  people: VibePerson[];
  verdict: string | null;
  stepsTitle: string;
  steps: VibeStep[];
  footnote: string;
  shareLabel: string;
  sticker: AgentSticker | null;
}

/** What the app gets — `ChatVibeCard` in the OpenAPI contract. */
export type VibeCardView = Omit<VibeCard, "kind" | "sticker" | "cardKind"> & { kind: VibeCardKind };

/* ── the tool ───────────────────────────────────────────────────────────── */

const SCORE = { type: "integer", minimum: VIBE_SCORE_MIN, maximum: VIBE_SCORE_MAX } as const;

export const SHOW_VIBE_CARD_TOOL = {
  type: "function" as const,
  function: {
    name: SHOW_VIBE_CARD_TOOL_NAME,
    description:
      "Show a rating card for the photo they sent in THIS turn when they ask for their aura, how attractive they (or someone on the photo) are, a rating, a swag gap or who mogs whom. The card is the answer: numbers go only here, never in your text. Kinds: aura (one person: vibe, energy, style, frame), attractiveness (one person: face, style, presence), swag_gap (two people: each one's style and swag score, who mogs whom, steps to close the gap). Refused when no person is visible or anyone may be under 18 — then answer in words without a number.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "personVisible", "allAdults"],
      properties: {
        kind: { type: "string", enum: [...VIBE_CARD_KINDS] },
        personVisible: { type: "boolean", description: "A real person is clearly visible on the photo." },
        allAdults: { type: "boolean", description: "false when anyone visible plausibly looks under 18 — child or teen features, a school setting, a kid's context. Young-looking adults in adult settings (a bar, a restaurant, a gym, a date) count as adults; the person you talk to is a verified adult." },
        score: { ...SCORE, description: "aura or attractiveness, 1–100. Not for swag_gap." },
        archetype: { type: "string", description: `aura/attractiveness: 2–3 words, their language, ≤${VIBE_ARCHETYPE_MAX_LEN} chars («Тихая уверенность»).` },
        bars: {
          type: "object",
          additionalProperties: false,
          description: "aura: energy, style, frame. attractiveness: face, style, presence. Each 1–100.",
          properties: { energy: SCORE, style: SCORE, frame: SCORE, face: SCORE, presence: SCORE },
        },
        reads: {
          type: "array",
          maxItems: VIBE_READS_MAX,
          items: { type: "string" },
          description: `What on THIS photo drives the number, ≤${VIBE_READ_MAX_LEN} chars each («пальто по фигуре»).`,
        },
        people: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          description: "swag_gap only: the two people. Two photos: in the order the photos were sent. One photo: left to right.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["style", "freshness", "score"],
            properties: {
              label: { type: "string", description: `How they called this person («я», «он», a name) — empty for «left/right». ≤${VIBE_PERSON_LABEL_MAX_LEN} chars.` },
              style: { type: "string", description: `Their style in 2–3 words, ≤${VIBE_STYLE_MAX_LEN} chars («clean old money»).` },
              freshness: { type: "string", enum: [...VIBE_FRESHNESS] },
              score: { ...SCORE, description: "Swag: style, fit, how current, presence on this photo." },
            },
          },
        },
        verdict: { type: "string", description: `swag_gap: who mogs whom in two or three words and nothing else — who and the verb, ≤${VIBE_VERDICT_MAX_LEN} chars («Она могнула», «Он могнул», «Ничья»).` },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: VIBE_STEPS_MAX,
          description: `Concrete steps that raise the number (swag_gap: close the gap before the date), ≤${VIBE_STEP_MAX_LEN} chars each. Never harmful practices.`,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["text"],
            properties: {
              who: { type: "string", description: "swag_gap: whose step (their label or left/right). Omit otherwise." },
              text: { type: "string" },
            },
          },
        },
        sticker: { type: "boolean", description: "Send a sticker after your line — only when the moment is light and fun." },
      },
    },
  },
};

/* ── turn gating ────────────────────────────────────────────────────────── */

/**
 * Whether this turn offers the tool: the flag, a build that draws the card, a
 * photo on this turn, and no distress words in the recent messages.
 */
export function vibeCardsThisTurn(input: {
  chatCards?: ReadonlySet<string> | undefined;
  imageCount: number;
  recentUserTexts: readonly string[];
}): boolean {
  if (!env.AGENT_VIBE_CARDS_ENABLED) return false;
  if (!(input.chatCards?.has(VIBE_CARD_CLIENT_TOKEN) ?? false)) return false;
  if (input.imageCount === 0) return false;
  return !vibeSafetyHit(input.recentUserTexts.slice(0, VIBE_SAFETY_LOOKBACK));
}

/** The prompt block on a turn that offers the tool. */
export const VIBE_CARD_ADDENDUM = VIBE_CARD_RULES;

/* ── validation ─────────────────────────────────────────────────────────── */

function clampScore(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(VIBE_SCORE_MAX, Math.max(VIBE_SCORE_MIN, Math.round(n)));
}

/** Trim, collapse spaces, cut at a word where possible, never mid-surrogate. */
function cut(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const clean = raw.replace(/\s+/g, " ").trim();
  const chars = [...clean];
  if (chars.length <= max) return clean;
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** Huge type cannot end in «…»: whole words only, never a dangling preposition. */
function headline(raw: unknown, max: number): string {
  const clean = cut(raw, 400).split(/\s+[—–-]\s+|[,.;:!]/)[0]!.trim();
  if ([...clean].length <= max) return clean;
  const words = clean.split(" ");
  while (words.length > 1 && [...words.join(" ")].length > max) words.pop();
  while (words.length > 2 && [...words.at(-1)!].length <= 2) words.pop();
  return [...words.join(" ")].slice(0, max).join("");
}

/** Numbers in words have no place on a card's text: the card carries them. */
function noScores(text: string): string {
  return text.replace(/\b\d{1,3}\s?(%|\/\s?10|\/\s?100)/g, "").replace(/\s{2,}/g, " ").trim();
}

const BAR_LABEL: Record<VibeBarKey, TranslationKey> = {
  energy: "vibeBarEnergy",
  style: "vibeBarStyle",
  frame: "vibeBarFrame",
  face: "vibeBarFace",
  presence: "vibeBarPresence",
};

const FRESH_LABEL: Record<VibeFreshness, TranslationKey> = {
  in_trend: "vibeFreshInTrend",
  classic: "vibeFreshClassic",
  dated: "vibeFreshDated",
};

export type VibeCardOutcome =
  | { ok: true; card: VibeCard; result: string }
  | { ok: false; result: string };

function refused(error: string, instruction: string): VibeCardOutcome {
  return { ok: false, result: JSON.stringify({ success: false, error, instruction }) };
}

/**
 * The tool call as a card, or the reason it is refused. Pure: the caller
 * stores it with the reply.
 */
export function buildVibeCard(args: unknown, language: Language): VibeCardOutcome {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const kind = VIBE_CARD_KINDS.find((k) => k === a.kind);
  if (!kind) return refused("bad_kind", "kind must be aura, attractiveness or swag_gap.");
  if (a.personVisible !== true) {
    return refused("no_person", "No card: there is no person to rate. Say so in one light line and ask for a photo with them on it. No number.");
  }
  if (a.allAdults !== true) {
    return refused("minor_possible", "No card and no rating: someone on the photo may be under 18. Say in one short line that you do not rate this photo, without explaining age, and move on. No number in words.");
  }

  const steps: VibeStep[] = (Array.isArray(a.steps) ? a.steps : [])
    .map((s) => {
      const step = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
      const text = cut(noScores(cut(step.text, VIBE_STEP_MAX_LEN * 2)), VIBE_STEP_MAX_LEN);
      const who = kind === "swag_gap" ? cut(step.who, VIBE_PERSON_LABEL_MAX_LEN) : "";
      return { who: who || null, text };
    })
    .filter((s) => s.text.length > 0)
    .slice(0, VIBE_STEPS_MAX);
  if (steps.length === 0) {
    return refused("no_step", "Every card needs at least one concrete step that would raise the number. Call again with steps.");
  }

  const base = {
    kind: VIBE_CARD_KIND,
    cardKind: kind,
    footnote: t(language, "vibeFootnote"),
    shareLabel: t(language, "vibeShare"),
    steps,
  } as const;

  let card: VibeCard;
  if (kind === "swag_gap") {
    const raw = Array.isArray(a.people) ? a.people : [];
    if (raw.length < 2) return refused("two_people", "swag_gap needs exactly two people, left to right.");
    const sides: TranslationKey[] = ["vibeSideLeft", "vibeSideRight"];
    const people: VibePerson[] = [];
    for (let i = 0; i < 2; i++) {
      const p = (raw[i] && typeof raw[i] === "object" ? raw[i] : {}) as Record<string, unknown>;
      const score = clampScore(p.score);
      const style = cut(p.style, VIBE_STYLE_MAX_LEN);
      if (score === null || !style) return refused("bad_person", "Each person needs a style and a score 1–100.");
      const freshness = VIBE_FRESHNESS.find((f) => f === p.freshness) ?? "classic";
      people.push({
        label: cut(p.label, VIBE_PERSON_LABEL_MAX_LEN) || t(language, sides[i]!),
        style,
        freshness,
        freshnessLabel: t(language, FRESH_LABEL[freshness]),
        score,
      });
    }
    const gap = Math.abs(people[0]!.score - people[1]!.score);
    card = {
      ...base,
      title: t(language, "vibeSwagTitle"),
      score: gap,
      scoreLabel: t(language, "vibeSwagScore"),
      archetype: null,
      bars: [],
      reads: [],
      people,
      verdict: headline(noScores(cut(a.verdict, 400)), VIBE_VERDICT_MAX_LEN) || null,
      stepsTitle: t(language, "vibeGapStepsTitle"),
      sticker: null,
    };
  } else {
    const score = clampScore(a.score);
    if (score === null) return refused("no_score", "aura and attractiveness need a score 1–100.");
    const rawBars = (a.bars && typeof a.bars === "object" ? a.bars : {}) as Record<string, unknown>;
    const bars: VibeBar[] = VIBE_BARS[kind].map((key) => ({
      key,
      label: t(language, BAR_LABEL[key]),
      // A missing bar takes the headline number: the card never shows a hole.
      value: clampScore(rawBars[key]) ?? score,
    }));
    const reads = (Array.isArray(a.reads) ? a.reads : [])
      .map((r) => cut(noScores(cut(r, VIBE_READ_MAX_LEN * 2)), VIBE_READ_MAX_LEN))
      .filter((r) => r.length > 0)
      .slice(0, VIBE_READS_MAX);
    card = {
      ...base,
      title: t(language, kind === "aura" ? "vibeAuraTitle" : "vibeAttractTitle"),
      score,
      scoreLabel: t(language, kind === "aura" ? "vibeAuraScore" : "vibeAttractScore"),
      archetype: headline(noScores(cut(a.archetype, 400)), VIBE_ARCHETYPE_MAX_LEN) || null,
      bars,
      reads,
      people: [],
      verdict: null,
      stepsTitle: t(language, "vibeStepsTitle"),
      sticker: null,
    };
  }
  if (a.sticker === true) card.sticker = vibeSticker(kind, card.score);

  return {
    ok: true,
    card,
    result: JSON.stringify({
      success: true,
      shown: "The drawing is in the chat ABOVE your reply: the number and two or three words. The steps are NOT on it.",
      stepToSay: vibeStepLine(card),
      instruction:
        "Now write exactly one short sentence in your voice, in their language, up to 90 characters: stepToSay, as concrete advice. Never repeat a number, a percent or the verdict; no praise instead of the step; do not describe the drawing.",
    }),
  };
}

/* ── reading back ───────────────────────────────────────────────────────── */

function isSticker(raw: unknown): raw is AgentSticker {
  if (!raw || typeof raw !== "object") return false;
  const s = raw as { id?: unknown; caption?: unknown };
  return (
    AGENT_STICKER_IDS.includes(s.id as AgentStickerId) &&
    (s.caption === null || AGENT_STICKER_CAPTIONS.includes(s.caption as AgentStickerCaption))
  );
}

/** The stored JSON as a card, or null for anything that is not one. */
export function readVibeCard(raw: unknown): VibeCard | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<VibeCard>;
  if (c.kind !== VIBE_CARD_KIND || !VIBE_CARD_KINDS.includes(c.cardKind as VibeCardKind)) return null;
  if (typeof c.score !== "number" || typeof c.title !== "string") return null;
  return {
    kind: VIBE_CARD_KIND,
    cardKind: c.cardKind as VibeCardKind,
    title: c.title,
    score: c.score,
    scoreLabel: typeof c.scoreLabel === "string" ? c.scoreLabel : "",
    archetype: typeof c.archetype === "string" ? c.archetype : null,
    bars: Array.isArray(c.bars) ? c.bars : [],
    reads: Array.isArray(c.reads) ? c.reads.filter((r): r is string => typeof r === "string") : [],
    people: Array.isArray(c.people) ? c.people : [],
    verdict: typeof c.verdict === "string" ? c.verdict : null,
    stepsTitle: typeof c.stepsTitle === "string" ? c.stepsTitle : "",
    steps: Array.isArray(c.steps) ? c.steps : [],
    footnote: typeof c.footnote === "string" ? c.footnote : "",
    shareLabel: typeof c.shareLabel === "string" ? c.shareLabel : "",
    sticker: isSticker(c.sticker) ? c.sticker : null,
  };
}

export function vibeCardView(card: VibeCard): VibeCardView {
  const { kind: _stored, sticker: _sticker, cardKind, ...rest } = card;
  return { ...rest, kind: cardKind };
}

/** The sticker after the reply — `ChatSticker` in the contract — or null. */
export function vibeStickerView(card: VibeCard): AgentSticker | null {
  return card.sticker;
}

/**
 * The line under the drawing when the model wrote none: the app does not draw
 * the steps, and every rating carries one (decision 2026-11-22).
 */
export function vibeStepLine(card: VibeCard): string {
  const step = card.steps[0];
  if (!step) return "";
  return step.who ? `${step.who}: ${step.text}` : step.text;
}

/** What the model reads under its own earlier reply. */
export function vibeCardNote(card: VibeCard): string {
  if (card.cardKind === "swag_gap") {
    const [l, r] = card.people;
    return `[Swag-gap card above this reply: ${l?.label} ${l?.score}, ${r?.label} ${r?.score}, gap ${card.score}${card.verdict ? `, verdict «${card.verdict}»` : ""}. Don't repeat the numbers; a new photo gets a new card.]`;
  }
  return `[${card.cardKind === "aura" ? "Aura" : "Attractiveness"} card above this reply: ${card.score}${card.archetype ? `, «${card.archetype}»` : ""}. Don't repeat the number; a new photo gets a new card.]`;
}
