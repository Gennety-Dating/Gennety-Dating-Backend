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
 * Unbounded 700 is a wide face: «тобі не треба завантажувати» is **18.6 em**, so
 * as one line it caps at 49 px inside a 936 px box — not "big bold text" on a
 * 1080-wide frame by any reading. Every break below was chosen by summing the
 * font's own advance widths, and the widest surviving line is «завантажувати»
 * at 10.16 em, which is what sets `TYPE_SIZE`. **Re-measure before rewording**:
 * a line that overflows does not wrap gracefully here, it breaks the layout.
 */

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
const SETUP = ["Щоб бути", "щасливим,"] as const;

/** The world hands over here, across the same 14 frames the mark used to take. */
export const TITLE_FROM = 1309;

export const SLOGANS: readonly SloganCard[] = [
  {
    note:
      "The claim. Its first part waits 16 frames so it rises into a frame the " +
      "world has already left rather than over the top of the date card.",
    from: TITLE_FROM,
    durationInFrames: 132,
    anchorTop: true,
    fadeIn: 14,
    parts: [
      {at: 16, lines: SETUP},
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
      {at: 0, lines: SETUP},
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
 */
const ANCHOR_LINES = SLOGANS[0].parts.reduce((n, part) => n + part.lines.length, 0);

export const SLOGAN_TOP = Math.round((FRAME_H - ANCHOR_LINES * TYPE_SIZE * LINE_HEIGHT) / 2);

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
 */
export const TELEGRAM = {
  from: 1638,
  durationInFrames: 146,
  line: "Вже в Telegram",
  /** Clip under public/footage/. IMG_2775 at 2.4×. */
  src: "tg-open",
  /** Local frame the handset rises at — and the clip starts with it. */
  phoneAt: 24,
  /** Screen width in px. Small enough to sit under the wordmark and the line. */
  screenWidth: 348,
  note:
    "The proof of the line above it: Telegram opens, Gennety is the chat at the " +
    "top, Start, and the app takes over. Sped 2.4× because it is evidence, not " +
    "a scene — the founder's own call.",
} as const;

/** The mark, unchanged, now the last card of the act rather than a lone outro. */
export const MARK: {from: number; durationInFrames: number} = {
  from: 1770,
  durationInFrames: 96,
};

export const HERO_DURATION_IN_FRAMES = MARK.from + MARK.durationInFrames; // 1866 = 62.2s
