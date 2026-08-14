/**
 * TEMPORARY — the success-mark comparison board.
 *
 * Three candidate marks rendered side by side so the founder can watch them
 * loop rather than read a description of them. Two rounds of "build one, look,
 * no" have already been spent on this mark, and both died on the same thing:
 * motion cannot be judged from prose.
 *
 * **This file has an end date.** Once a variant is picked it becomes the real
 * `butterfly-success`, and this module, its stylesheet and the `?preview=success`
 * branch in verification.ts are DELETED — not left behind a flag. Same rule the
 * preference screen's `?v=` switch followed (DECISIONS 2026-08-07): a decision
 * that is made stops being a configuration, and the alternative lives in git
 * history where a rejected design belongs.
 *
 * What is being compared, and why these three:
 *
 *  A `wings` — the butterfly is already at full size with its wings folded to
 *    the body axis, and they open. One property in motion (`scaleX` per wing),
 *    and the geometry already supports it: `WING_LEFT`/`WING_RIGHT` are authored
 *    around x=0 exactly so a bare `scaleX()` folds them about the body with no
 *    `transform-origin`. No new path work at all.
 *
 *  B `appear` — the butterfly springs in at full size. Strictly less motion
 *    than A; the control for "is the opening gesture buying anything".
 *
 *  C `bloom` — no mark. The heading that every one of these screens already
 *    carries gets a burgundy bloom behind it and settles up a few pixels.
 *
 * None of the three draws a tick, and that is the point of the round. Checked
 * before proposing it: all five success surfaces state the outcome in words
 * already (verification passes `label`; Type Radar, onboarding, venue-change and
 * the calendar each render their own heading directly under the mark), so the
 * tick was duplicating the sentence beside it rather than carrying meaning.
 */

import "./success-variants.css";
import { WING_LEFT, WING_RIGHT, escapeHtml, logoWingGradient } from "./brand-butterfly.js";

export type SuccessVariant = "wings" | "appear" | "bloom";

export const SUCCESS_VARIANTS: readonly SuccessVariant[] = ["wings", "appear", "bloom"];

/** One gradient per variant: three butterflies coexist on this page, and a
 *  shared document id would have them all painting from whichever `<defs>` the
 *  DOM happened to order last. */
const gradientId = (variant: SuccessVariant): string => `gnt-sv-${variant}`;

/**
 * The butterfly, centred on the origin.
 *
 * viewBox is the wings' own bbox (88.63 x 63.44 around x=0) plus margin for the
 * opening overshoot and the breath — both scale past 1, and an SVG crops
 * silently.
 */
function butterflyMarkup(variant: SuccessVariant): string {
  const id = gradientId(variant);
  return (
    `<svg class="sv-svg" viewBox="-54 -40 108 80" aria-hidden="true" focusable="false">` +
    `<defs>${logoWingGradient(id)}</defs>` +
    `<g class="sv-fly">` +
    `<g class="sv-wing"><path d="${WING_LEFT}" fill="url(#${id})"/></g>` +
    `<g class="sv-wing"><path d="${WING_RIGHT}" fill="url(#${id})"/></g>` +
    `</g>` +
    `</svg>`
  );
}

/**
 * One candidate, in the shape a real success screen has it: the mark, then the
 * heading the screen already carries.
 *
 * The heading is not decoration on this board. It is the reason the tick can go,
 * so judging a variant without it would be judging a picture the product never
 * shows on its own.
 */
export function variantMarkup(variant: SuccessVariant, heading: string): string {
  const mark =
    variant === "bloom"
      ? `<div class="sv-mark sv-mark-bare"></div>`
      : `<div class="sv-mark">${butterflyMarkup(variant)}</div>`;
  return (
    `<div class="sv-stage sv-${variant}">` +
    mark +
    `<h2 class="sv-heading">${escapeHtml(heading)}</h2>` +
    `</div>`
  );
}

const LABELS: Record<SuccessVariant, string> = {
  wings: "A · крылья раскрываются",
  appear: "B · просто появляется",
  bloom: "C · без марки",
};

/** The whole board. `heading` mirrors what a real screen says under the mark. */
export function variantsBoardMarkup(heading = "Готово"): string {
  const cards = SUCCESS_VARIANTS.map(
    (variant) =>
      `<figure class="sv-card">` +
      `<div class="sv-slot" data-variant="${variant}">${variantMarkup(variant, heading)}</div>` +
      `<figcaption class="sv-caption">${LABELS[variant]}</figcaption>` +
      `</figure>`,
  ).join("");
  return (
    `<div class="sv-board">` +
    `<div class="sv-bar">` +
    `<button type="button" class="sv-btn" data-act="replay">Проиграть заново</button>` +
    `<button type="button" class="sv-btn" data-act="theme">Сменить тему</button>` +
    `<span class="sv-hint">повтор каждые 3 с</span>` +
    `</div>` +
    `<div class="sv-row">${cards}</div>` +
    `</div>`
  );
}

/** How often the board replays every variant, in ms. Long enough to see each
 *  one come to rest and sit there, which is the frame that matters most. */
export const VARIANT_LOOP_MS = 3000;

/**
 * Mounts the board and keeps it playing.
 *
 * Replays by re-writing each slot's markup, which is the one reliable way to
 * restart a CSS animation from a script — toggling a class needs a forced
 * reflow between the removal and the re-add, and a batched one silently does
 * nothing.
 */
export function mountVariantsBoard(root: HTMLElement, heading = "Готово"): () => void {
  root.innerHTML = variantsBoardMarkup(heading);

  const play = (): void => {
    for (const slot of root.querySelectorAll<HTMLElement>(".sv-slot")) {
      const variant = slot.dataset.variant as SuccessVariant | undefined;
      if (variant) slot.innerHTML = variantMarkup(variant, heading);
    }
  };

  const timer = window.setInterval(play, VARIANT_LOOP_MS);

  const onClick = (event: Event): void => {
    const act = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-act]")?.dataset
      .act;
    if (act === "replay") play();
    if (act === "theme") {
      const el = document.documentElement;
      el.dataset.theme = el.dataset.theme === "light" ? "dark" : "light";
    }
  };
  root.addEventListener("click", onClick);

  return () => {
    window.clearInterval(timer);
    root.removeEventListener("click", onClick);
  };
}
