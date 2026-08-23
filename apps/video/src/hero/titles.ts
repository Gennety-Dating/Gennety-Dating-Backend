/**
 * The title act. **The only part of the film that is not footage.**
 *
 * `timeline.ts` owns the cut — which capture, which window, how long. This file
 * owns the five drawn cards that follow it: three slogan cards, the Telegram
 * card, and the mark. Same principle as the cut: it is data, read top to bottom,
 * and no component decides its own timing.
 *
 * ---
 *
 * ## Why this exists at all (founder, 2026-08-21)
 *
 * The film's standing rule is that **the interface carries the story** — "no
 * swiping" and "one real date" are already said on screen, in the product's own
 * words, better than a caption would. Until now the only typography that was
 * ours was the mark's one line, and that was deliberate.
 *
 * The slogan is the exception the rule was always going to need: it is the one
 * thing the product **cannot say about itself**, because it is an argument
 * against its own category.
 *
 *     Щоб бути щасливим, тобі не треба завантажувати застосунок для знайомств.
 *     Щоб бути щасливим, тобі треба їх видалити.
 *
 * No screen in the app says that, and no screen ever will.
 *
 * ## The reveal, which is the point rather than decoration
 *
 * The founder asked for the parts to land separately, with a beat between them
 * — «когда мы пишем одну часть текста, вторую, третью». So a card is `parts`,
 * not a string: each part reveals at its own frame, lines inside a part stagger
 * by `LINE_STAGGER`, and the gap between part 0 and part 1 is the pause. That
 * gap is what makes the two cards read as one sentence broken in half rather
 * than as two captions, and it is why the setup line is byte-identical on both
 * (`SETUP`) — the anaphora only works if the repeat is exact, to the pixel.
 *
 * ## Line breaks are measured, not eyeballed
 *
 * ## Two languages, one typography (2026-08-23)
 *
 * Every export below is keyed by language. What is NOT keyed is the design:
 * one type size, one tracking, one margin, one rise, one anaphora, and the same
 * five cards in the same order at the same lengths. A localisation that let the
 * English act find its own rhythm would be a second design, and the film has one.
 *
 * The English copy was measured the same way the Ukrainian was — by summing the
 * font's own advance widths, tracking included — and the numbers are on
 * `TELEGRAM`, which is the only line the box could not simply take.
 *
 * ## Line breaks are measured, not eyeballed
 *
 * Unbounded 700 is a wide face: «тобі не треба завантажувати» is **18.6 em**, so
 * as one line it caps at 49 px inside a 936 px box — not "big bold text" on a
 * 1080-wide frame by any reading. Every break below was chosen by summing the
 * font's own advance widths, and the widest surviving line is «завантажувати»
 * at 10.16 em, which is what sets `TYPE_SIZE`. **Re-measure before rewording**:
 * a line that overflows does not wrap gracefully here, it breaks the layout.
 */

import type {Lang} from "./timeline";

/** One revealed group. A part is one or more lines that arrive together. */
export type Part = {
  /** Local frame this part starts rising at. */
  at: number;
  /** Lines, top to bottom. They stagger by LINE_STAGGER. */
  lines: readonly string[];
  /** Burgundy instead of white. Exactly one part in the act uses it. */
  accent?: boolean;
};

export type SloganCard = {
  from: number;
  durationInFrames: number;
  parts: readonly Part[];
  /**
   * Pin the first line to `SLOGAN_TOP` instead of centring the block. Set on
   * the two cards that share `SETUP`; see that constant.
   */
  anchorTop?: boolean;
  /**
   * Crossfade the card's own black IN over this many frames.
   *
   * Only the first card needs it, and it needs it badly: a slogan card is an
   * opaque `INK` fill drawn over the world, so without a fade it replaces the
   * date card in a single frame. Measured on the render before this existed —
   * the frame's mean luminance fell **46.0 to 7.6 in one frame**, by a distance
   * of 38, which made it the largest brightness step in the entire film by a
   * factor of 1.6 over the Type Radar's own worst. The cards that follow a
   * black gap need nothing, because black over black is not a step.
   */
  fadeIn?: number;
  /** Editorial note — why this card is in the film. */
  note: string;
};

/**
 * Type size for every drawn line in the act, slogans and the Telegram card
 * alike. **One size on purpose**: four cards at four sizes reads as four
 * designs. 86 px puts the widest line at 874 px inside a 936 px box — 7 % of
 * slack, which is the margin for the renderer's own rounding.
 */
export const TYPE_SIZE = 82;

/**
 * Tracking, and it is **positive** — which is the opposite of the reflex for
 * display type and was arrived at by measuring the render twice (2026-08-21).
 *
 * It shipped at -0.02em. «Вже» came out with the В's bowl fused to the ж's left
 * arm and the ж's right arm fused to the е, reading as one blob rather than
 * three letters — on the one headline a viewer has to take in at a glance.
 * Going back to the font's own metrics (0) did not fix it: a column scan of the
 * rendered pixels put the В|ж junction at **2 rows of contact** and ж|е at 8,
 * i.e. the letters were still touching, just barely. Unbounded's ж is among the
 * widest glyphs in the face and its diagonals reach to the very edge of its
 * sidebearings, so at 700 weight it kisses whatever is next to it.
 *
 * 0.03em at 82px is 2.5px of air — enough to open both junctions, measured, not
 * assumed. The type drops 86 -> 82 to pay for it: at 86 the widest line would
 * sit 18px from the margin, and that is not the place to spend the last of the
 * slack.
 *
 * Worth knowing before rewording: letters touching is NORMAL in this face at
 * this size — «Кожного дня» has three such pairs and reads perfectly, because ж
 * between о and н resolves where ж between В and е does not. So the fix is
 * uniform tracking rather than a nudge on one line; a per-line override would
 * make the act four typographies instead of one.
 */
export const TYPE_TRACKING = "0.03em";
/** Side margin. The box the measurements above are against is 1080 - 2 × this. */
export const TYPE_MARGIN = 72;
/** Frames a single line takes to rise into place. */
export const RISE = 16;
/** Frames between lines inside one part. */
export const LINE_STAGGER = 6;
/** Frames a card takes to leave. */
export const CARD_OUT = 18;
/** Leading. Tight, because the block IS the image at this size. */
export const LINE_HEIGHT = 1.06;
/** The composition's own height, for the one place the act needs to know it. */
const FRAME_H = 1920;


/**
 * The repeated half. Identical on both cards by construction rather than by
 * two authors agreeing — see the anaphora note above.
 */
const SETUP_UK = ["Щоб бути", "щасливим,"] as const;

/**
 * The English half, and it carries the same weight for the same reason: it is
 * byte-identical on both cards, and the two cards' `anchorTop` puts it in
 * exactly the same place on screen. Measured at 291.6 px and 368.5 px in a
 * 936 px box — the shortest lines in the act, which is what a setup should be.
 */
const SETUP_EN = ["To be", "happy,"] as const;

/**
 * The world hands over here, across the same 14 frames the mark used to take.
 *
 * Derived rather than written down: it is `WORLD_END - OUTRO` in both languages,
 * and the two worlds end 43 frames apart.
 */
export const TITLE_FROM: Record<Lang, number> = {uk: 1309, en: 1252};

const SLOGANS_UK: readonly SloganCard[] = [
  {
    note:
      "The claim. Its first part waits 16 frames so it rises into a frame the " +
      "world has already left rather than over the top of the date card.",
    from: TITLE_FROM.uk,
    durationInFrames: 132,
    anchorTop: true,
    fadeIn: 14,
    parts: [
      {at: 16, lines: SETUP_UK},
      {at: 60, lines: ["тобі не треба", "завантажувати", "застосунок", "для знайомств"]},
    ],
  },
  {
    note:
      "The turn, and the only burgundy in the act. The card before it goes to " +
      "black completely first — the founder asked for the text to disappear and " +
      "be written again, and that blink is what makes the repeat land as a " +
      "second sentence rather than as a line being edited in place.",
    from: 1446,
    durationInFrames: 108,
    anchorTop: true,
    parts: [
      {at: 0, lines: SETUP_UK},
      {at: 44, lines: ["тобі треба", "їх видалити"], accent: true},
    ],
  },
  {
    note:
      "The promise, and the only card with no pause in it — one part, three " +
      "lines. It is a statement of fact rather than a construction, so building " +
      "it in halves would put a beat where the sentence has none.",
    from: 1562,
    durationInFrames: 90,
    parts: [{at: 0, lines: ["Кожного дня", "у тебе є шанс", "на побачення"]}],
  },
];

/**
 * The English act. Same three cards, same lengths, same reveal frames, same
 * single burgundy part — offset by the 57 frames the world ends earlier.
 *
 *     To be happy, you don't need to download a dating app.
 *     To be happy, you need to delete them.
 *
 * Line breaks, measured in Unbounded 700 at 82 px with 0.03em tracking inside
 * the 936 px box (the Ukrainian widest line, «завантажувати», is 886.7 px by
 * the same method, so anything under that is proven):
 *
 *     you don't need   790.0    to delete them   786.0
 *     to download      679.4    Every day        539.2
 *     a dating app     681.7    is a chance      604.3
 *     you need         485.4    for a date       536.9
 *
 * The claim card composes to FIVE lines where the Ukrainian one takes six —
 * «застосунок для знайомств» is two lines of Ukrainian and one of English. It
 * keeps its 132 frames anyway: the extra 6 frames land as hold on the punchline,
 * which is the one place in the act that can use them, and shortening the card
 * would have moved the turn away from the beat the founder approved.
 *
 * That five-vs-six also moves `SLOGAN_TOP`, which is derived from card 1 — see
 * that constant. Both English cards still open on the same two words in the same
 * place, which is the only thing the anchor exists to protect.
 */
const SLOGANS_EN: readonly SloganCard[] = [
  {
    note:
      "The claim. Its first part waits 16 frames so it rises into a frame the " +
      "world has already left rather than over the top of the date card.",
    from: TITLE_FROM.en,
    durationInFrames: 132,
    anchorTop: true,
    fadeIn: 14,
    parts: [
      {at: 16, lines: SETUP_EN},
      {at: 60, lines: ["you don't need", "to download", "a dating app"]},
    ],
  },
  {
    note:
      "The turn, and the only burgundy in the act. The card before it goes to " +
      "black completely first — the founder asked for the text to disappear and " +
      "be written again, and that blink is what makes the repeat land as a " +
      "second sentence rather than as a line being edited in place.",
    from: 1389,
    durationInFrames: 108,
    anchorTop: true,
    parts: [
      {at: 0, lines: SETUP_EN},
      {at: 44, lines: ["you need", "to delete them"], accent: true},
    ],
  },
  {
    note:
      "The promise, and the only card with no pause in it — one part, three " +
      "lines. «Every day is a chance for a date» is tighter than a literal " +
      "rendering of «Кожного дня у тебе є шанс на побачення», and tighter is " +
      "what keeps it to three short lines: it is a statement of fact rather " +
      "than a construction, so building it in halves would put a beat where the " +
      "sentence has none.",
    from: 1505,
    durationInFrames: 90,
    parts: [{at: 0, lines: ["Every day", "is a chance", "for a date"]}],
  },
];

export const SLOGANS: Record<Lang, readonly SloganCard[]> = {
  uk: SLOGANS_UK,
  en: SLOGANS_EN,
};

/**
 * Where the first line sits on an ANCHORED card, in px from the top.
 *
 * The two slogan cards open on the same two words, and the repeat only works if
 * it is exact — same size, same place. Centring each card on its own block does
 * not give that: card 1 composes to six lines and card 2 to four, so a centred
 * block puts the shared setup **one whole line lower** on the second card,
 * which reads as the words having moved rather than returned.
 *
 * So both anchor their first line here instead, and the payoff grows downward.
 * The value is where card 1's block WOULD be centred, which means card 1 is
 * centred exactly and card 2 sits one line high. That is the trade and it is
 * the right way round: nothing on screen contradicts card 2's framing, while
 * card 1 four seconds earlier contradicts a moved setup.
 *
 * **Derived from card 1 rather than written down**, because it already drifted
 * once: it was a literal 686, correct for TYPE_SIZE 86, and stayed 686 when the
 * size dropped to 82 for the tracking fix — putting card 1 thirteen pixels
 * above centre for no reason anyone would have found later.
 *
 * The promise card is NOT anchored. It shares no line with anything, so there
 * is no repeat to protect, and anchoring it would leave it well above centre.
 *
 * **Per language, for the same reason it is derived at all.** Ukrainian card 1
 * composes to six lines and English card 1 to five, so one shared constant would
 * put one of the two acts off its own centre by half a line — reintroducing, in
 * the other direction, exactly the 13px drift this derivation was written to
 * kill.
 */
const anchorLines = (lang: Lang) =>
  SLOGANS[lang][0].parts.reduce((n, part) => n + part.lines.length, 0);

export const sloganTop = (lang: Lang): number =>
  Math.round((FRAME_H - anchorLines(lang) * TYPE_SIZE * LINE_HEIGHT) / 2);

/**
 * The Telegram card. Wordmark, one line, and the product being opened.
 *
 * It crossfades out of the promise above rather than following a black gap:
 * "every day you have a chance" and "already in Telegram" are one thought, and
 * the two slogan cards have already spent the film's budget for hard blinks.
 *
 * The recording is sped up in EXTRACTION, not with `playbackRate` — a clip that
 * is already 30 fps at its final speed decodes like every other clip in the
 * film, and the alternative asks the renderer to resample on the fly for the
 * one shot that has no reason to be special.
 *
 * **`durationInFrames` is derived from the clip, not chosen.** The card has to
 * hold `phoneAt` + the clip's own length + a tail, so re-cutting the clip moves
 * this number and, through `MARK`, the length of the film. Working it out by
 * hand is how a card ends up cutting its own footage off two frames early.
 */
const TG_CLIP_FRAMES: Record<Lang, number> = {
  uk: 124, // public/footage/tg-open.mp4     — ffprobe nb_frames
  en: 100, // public/footage/en/tg-open.mp4  — ffprobe nb_frames
};
const TG_TAIL = 14; // beat after the app lands, before the mark takes over

export const TELEGRAM: Record<
  Lang,
  {
    from: number;
    durationInFrames: number;
    line: string;
    src: string;
    phoneAt: number;
    screenWidth: number;
    note: string;
  }
> = {
  uk: {
    from: 1638,
    durationInFrames: 24 + TG_CLIP_FRAMES.uk + TG_TAIL,
    line: "Вже в Telegram",
    /** Clip under public/footage/. IMG_2775, dead air cut, 1.35×. */
    src: "tg-open",
    /** Local frame the handset rises at — and the clip starts with it. */
    phoneAt: 24,
    /** Screen width in px. Small enough to sit under the wordmark and the line. */
    screenWidth: 348,
    note:
      "The proof of the line above it: Telegram opens, Gennety is the chat at the " +
      "top, Start, and the app takes over. It shipped at 2.4× and the founder read " +
      "it as far too fast; the cause was that 3.96s of the 8.93s source is a frozen " +
      "screen, so speed was dragging the six moments that carry the beat along with " +
      "it. The holds are cut and the rest runs at 1.35× — same screen time to within " +
      "half a second, twice the action.",
  },
  en: {
    from: 1581,
    durationInFrames: 24 + TG_CLIP_FRAMES.en + TG_TAIL,
    /**
     * **"Now on Telegram", not the literal "Already on Telegram", and the
     * reason is a measurement rather than a preference.**
     *
     * "Already on Telegram" is 13.64 em — **1118.6 px** at 82 px with this
     * act's tracking. That is not merely outside the 936 px box the slogan
     * cards use, it is wider than the 1080 px FRAME, and this card sets
     * `whiteSpace: nowrap`, so it would be clipped at both ends rather than
     * wrapping to give the mistake away. Fitting it would need ~68 px type,
     * i.e. this card alone at its own size — and the note on `TYPE_SIZE` says
     * why four cards at four sizes reads as four designs.
     *
     * "Now on Telegram" measures 937.6 px, which leaves 71.2 px each side: the
     * same margin as the slogan cards to within a pixel, by arithmetic rather
     * than by luck. It says the same thing in fifteen characters.
     *
     * If the founder wants the literal line back it costs this card its size,
     * and that is their call rather than this file's — raised, not decided.
     */
    line: "Now on Telegram",
    /** Clip under public/footage/en/. IMG_2802, chat list elided, 1.0×. */
    src: "en/tg-open",
    phoneAt: 24,
    screenWidth: 348,
    note:
      "The proof of the line above it: Telegram opens, the Gennety chat, Start, " +
      "and the app takes over. **Not sped up**, which is the one place this card " +
      "departs from the Ukrainian one: 4.46s of the 8.23s source is a frozen " +
      "screen — 54%, against 44% there — so cutting the holds already does the " +
      "whole job and leaves 3.1s of pure action. The Ukrainian version still had " +
      "5s to compress after its holds went, and the founder's note on the first " +
      "cut of it was that it read too fast.\n\n" +
      "The chat LIST is elided rather than shown, and that is not a style " +
      "choice: three of its rows carry Russian text and one is the founder's own " +
      "alerts bot printing a live signup with a real person's name, age, gender " +
      "and city. See scripts/extract-hero-footage-en.sh for the full note and " +
      "for what a re-record would have to fix.",
  },
};

/**
 * The mark, unchanged, now the last card of the act rather than a lone outro.
 *
 * It overlaps the Telegram card by `MARK_OVERLAP` and that overlap is what the
 * crossfade plays over, so `from` is derived rather than written down — the
 * Telegram card's length moves whenever its clip is re-cut, and a hand-kept
 * number here would silently become a gap or a hard cut.
 */
const MARK_OVERLAP = 14;

const mark = (lang: Lang) => ({
  from: TELEGRAM[lang].from + TELEGRAM[lang].durationInFrames - MARK_OVERLAP,
  durationInFrames: 96,
  /** Roboto 34 at 0.14em — 452.7 px for the English line, 438.3 for the Ukrainian. */
  line: lang === "uk" ? "Твій AI-метчмейкер" : "Your AI matchmaker",
});

export const MARK: Record<Lang, {from: number; durationInFrames: number; line: string}> = {
  uk: mark("uk"),
  en: mark("en"),
};

export const HERO_DURATION_IN_FRAMES: Record<Lang, number> = {
  uk: MARK.uk.from + MARK.uk.durationInFrames, // 1882 = 62.7s
  en: MARK.en.from + MARK.en.durationInFrames, // 1801 = 60.0s
};
