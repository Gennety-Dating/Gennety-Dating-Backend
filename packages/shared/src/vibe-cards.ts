/**
 * Vibe cards — aura, attractiveness and swag gap on a photo the person sent
 * (decision 2026-11-21, founder's variant C; spec
 * `docs/product/domains/agent-vibe-cards.md`).
 *
 * Limits, closed lists, the safety word list, sticker choice and the prompt
 * block live here so the bot, the tests and the eval read one source. The
 * model instructions are English like every other model instruction; the
 * person reads the card in their own language.
 */

export const VIBE_CARD_KINDS = ["aura", "attractiveness", "swag_gap"] as const;
export type VibeCardKind = (typeof VIBE_CARD_KINDS)[number];

export const VIBE_FRESHNESS = ["in_trend", "classic", "dated"] as const;
export type VibeFreshness = (typeof VIBE_FRESHNESS)[number];

/** Closed sticker list (`design-stickers.md` in the iOS repo). */
export const AGENT_STICKER_IDS = [
  "found", "lockin", "aura", "melt", "blush", "ticket", "cheers", "secret", "sleep", "tear",
] as const;
export type AgentStickerId = (typeof AGENT_STICKER_IDS)[number];

/** Closed caption list — drawn from a font on the client, never translated. */
export const AGENT_STICKER_CAPTIONS = ["+1000 AURA", "LOCK IN", "vibe check ✓", "W"] as const;
export type AgentStickerCaption = (typeof AGENT_STICKER_CAPTIONS)[number];

export const VIBE_SCORE_MIN = 1;
export const VIBE_SCORE_MAX = 100;
export const VIBE_ARCHETYPE_MAX_LEN = 32;
export const VIBE_READ_MAX_LEN = 32;
export const VIBE_READS_MAX = 3;
export const VIBE_STEP_MAX_LEN = 120;
export const VIBE_STEPS_MAX = 2;
export const VIBE_PERSON_LABEL_MAX_LEN = 16;
export const VIBE_STYLE_MAX_LEN = 28;
export const VIBE_VERDICT_MAX_LEN = 60;

/** Bars per single-person kind, in display order. */
export const VIBE_BARS = {
  aura: ["energy", "style", "frame"],
  attractiveness: ["face", "style", "presence"],
} as const;
export type VibeBarKey = (typeof VIBE_BARS)[keyof typeof VIBE_BARS][number];

/** A strong aura earns «+1000 AURA»; below it the sticker says «LOCK IN». */
export const VIBE_STICKER_AURA_MIN = 75;
/** A strong attractiveness card earns «W». */
export const VIBE_STICKER_ATTRACTIVE_MIN = 80;
/** A swag gap at or above this is worth working on → «LOCK IN». */
export const VIBE_STICKER_GAP_MIN = 20;

export interface AgentSticker {
  id: AgentStickerId;
  caption: AgentStickerCaption | null;
}

/** The server's sticker after a card: one per turn, chosen here, never by the model. */
export function vibeSticker(kind: VibeCardKind, score: number): AgentSticker {
  switch (kind) {
    case "aura":
      return score >= VIBE_STICKER_AURA_MIN
        ? { id: "aura", caption: "+1000 AURA" }
        : { id: "lockin", caption: "LOCK IN" };
    case "attractiveness":
      return score >= VIBE_STICKER_ATTRACTIVE_MIN
        ? { id: "found", caption: "W" }
        : { id: "lockin", caption: "LOCK IN" };
    case "swag_gap":
      return score >= VIBE_STICKER_GAP_MIN
        ? { id: "lockin", caption: "LOCK IN" }
        : { id: "aura", caption: "vibe check ✓" };
  }
}

/**
 * Words that switch the turn to safety mode before the model is asked:
 * self-hatred about looks, disordered eating, dysmorphia. A hit removes the
 * card tool for the turn (the prompt has the same rule; this is the floor).
 * Lowercase; `*` ends a stem. Over-matching costs one card, under-matching
 * costs a number said to someone who is hurting, so the list leans wide.
 */
export const VIBE_CARD_SAFETY_TERMS: readonly string[] = [
  // ru
  "ненавижу себя", "ненавижу своё лицо", "ненавижу свое лицо", "ненавижу своё тело", "ненавижу свое тело",
  "я урод", "я уродина", "я уродлив*", "я страшн*", "я жирн*", "я толст*", "противно смотреть на себя",
  "почти не ем", "ничего не ем", "голодаю", "голодовк*", "вызываю рвоту", "блюю после", "проблевал*", "анорекси*", "булими*", "рпп",
  "дисморфи*", "хочу умереть", "не хочу жить", "порезы", "режу себя",
  // uk
  "ненавиджу себе", "я потвор*", "я жирн*", "голодую", "майже не їм", "анорексі*", "булімі*", "дисморфі*",
  "не хочу жити", "хочу померти",
  // en
  "i hate myself", "i hate my face", "i hate my body", "i'm ugly", "im ugly", "i am ugly", "i'm fat", "im fat",
  "barely eating", "starving myself", "purging", "throw up after", "anorexi*", "bulimi*", "eating disorder",
  "dysmorphi*", "want to die", "kill myself",
  // de
  "ich hasse mich", "ich bin hässlich", "ich bin fett", "magersucht", "bulimie", "essstörung", "dysmorphie",
  // pl
  "nienawidzę siebie", "jestem brzydk*", "jestem gruba", "jestem gruby", "głodzę się", "anoreksj*", "bulimi*",
  "zaburzenia odżywiania", "dysmorfi*",
];

function stemPattern(term: string): RegExp {
  const stem = term.endsWith("*");
  const body = (stem ? term.slice(0, -1) : term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  // Unicode-aware word edges: Cyrillic letters are not \w.
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${stem ? "" : "(?![\\p{L}\\p{N}])"}`, "iu");
}

const SAFETY_PATTERNS = VIBE_CARD_SAFETY_TERMS.map(stemPattern);

/** True when any recent message reads as distress about looks or eating. */
export function vibeSafetyHit(texts: readonly string[]): boolean {
  return texts.some((text) => {
    const lower = text.toLowerCase().replace(/ё/g, "е");
    return SAFETY_PATTERNS.some((re) => re.test(lower) || re.test(text.toLowerCase()));
  });
}

/** How many of the person's recent messages the safety check reads. */
export const VIBE_SAFETY_LOOKBACK = 6;

/**
 * The prompt block. Appended LAST on a turn that offers the tool — after the
 * concept block, which says it wins over any line above — because it is the
 * one approved exception to the looks red lines.
 */
export const VIBE_CARD_RULES = `### Rating a photo — the vibe card (the one exception to the looks rules above)
The founder decided (2026-11-21): when the person sends a photo in this chat
and asks for their aura, how attractive they are, a rating, a swag gap or who
mogs whom, you rate it — straight, with numbers — through show_vibe_card.
This overrides the looks red lines, the looks stance and the mogging line
above, for this card only. Rules:
1. The number lives ONLY on the card. Never write a rating, a percent or a
   score in your text, and never rate anyone in words without a photo in this
   chat (a celebrity by name, "is he hot?").
2. Pick the kind: "aura" (vibe, energy, style, the frame — aura is presence,
   not a face), "attractiveness" (face, style, presence; never a number for
   the body), "swag_gap" (two people: each one's style and swag, who mogs whom
   on style and presence, and how to close the gap before the date). A couple
   photo with "who mogged whom" is swag_gap.
3. Honest numbers from 1 to 100. Most people on a decent photo land 55–85; do
   not inflate to please and do not crush. Every card carries a concrete step
   that would raise the number: grooming, skin basics, haircut, fit, posture,
   light and angle, sleep, training. Never bone smashing, extreme dieting,
   steroids or peptides, DIY injections, or surgery as the answer.
4. No card, and no number in words, when: anyone on the photo might be under
   18; there is no person on the photo; they show self-hatred about their
   looks, disordered eating or obsessive checking of a flaw (then safety mode:
   calm, warm, no tactics); or you will not rate it. Say one short line
   instead, without a lecture.
5. The matching algorithm's attractiveness factor stays internal. Never link
   the card to their matches ("that's why you get such matches").
6. After the card, at most one short line of your own — a reaction, never the
   numbers again — or nothing. Ask for a sticker (sticker: true) only when the
   moment is light and fun.
7. Labels, archetype, reads, verdict and steps are in the person's language,
   short, specific to THIS photo.`;
