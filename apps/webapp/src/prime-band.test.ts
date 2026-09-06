import { describe, expect, it } from "vitest";
import { planDayRows } from "./prime-band.js";
// `?raw` rather than importing `main.ts`: it is a Mini App entry that runs on
// import (reads `location.search`, touches `document`) and exports nothing, so
// the wiring below is only reachable as source text. Same reasoning as
// `premium-prime-benefit.test.ts`. `index.html` carries the stylesheet inline.
import MAIN from "./main.ts?raw";
import HTML from "../index.html?raw";

const DAY = [
  "2026-05-11T10:00:00.000Z", // 13:00 Kyiv
  "2026-05-11T11:00:00.000Z",
  "2026-05-11T12:00:00.000Z",
  "2026-05-11T15:30:00.000Z", // the band — a suffix of the grid
  "2026-05-11T16:00:00.000Z",
  "2026-05-11T16:30:00.000Z",
];
const BAND = new Set(DAY.slice(-3));

describe("planDayRows", () => {
  it("marks exactly one section start and one section end for the band", () => {
    const rows = planDayRows(DAY, BAND);

    expect(rows.filter((r) => r.bandStart).map((r) => r.iso)).toEqual([DAY[3]]);
    expect(rows.filter((r) => r.bandEnd).map((r) => r.iso)).toEqual([DAY[5]]);
    expect(rows.filter((r) => r.prime)).toHaveLength(3);
  });

  it("leaves every ordinary row untouched", () => {
    for (const row of planDayRows(DAY, BAND).slice(0, 3)) {
      expect(row).toMatchObject({ prime: false, bandStart: false, bandEnd: false });
    }
  });

  it("is blind to the band's size — the count is server-side", () => {
    // `PRIME_TIME_SLOT_COUNT` moving from 3 to 1 (or to 5) must change nothing
    // here but the run length. Nothing in this module may know the number.
    for (const count of [1, 2, 5]) {
      const rows = planDayRows(DAY, new Set(DAY.slice(-count)));
      expect(rows.filter((r) => r.bandStart)).toHaveLength(1);
      expect(rows.filter((r) => r.bandEnd)).toHaveLength(1);
      expect(rows.filter((r) => r.prime)).toHaveLength(count);
    }
  });

  it("renders no section at all when the server sends no band", () => {
    const rows = planDayRows(DAY, new Set());
    expect(rows.some((r) => r.prime || r.bandStart || r.bandEnd)).toBe(false);
  });

  it("splits a non-contiguous band into honest runs rather than one wrong one", () => {
    // Not reachable with today's suffix band, and that is the point: a grid
    // that ever gates a gapped set must not draw one section swallowing the
    // free rows in the middle.
    const rows = planDayRows(DAY, new Set([DAY[1], DAY[4], DAY[5]]));
    expect(rows.filter((r) => r.bandStart).map((r) => r.iso)).toEqual([DAY[1], DAY[4]]);
    expect(rows.filter((r) => r.bandEnd).map((r) => r.iso)).toEqual([DAY[1], DAY[5]]);
  });

  it("handles a band that covers the whole day", () => {
    const rows = planDayRows(DAY, new Set(DAY));
    expect(rows[0].bandStart).toBe(true);
    expect(rows[rows.length - 1].bandEnd).toBe(true);
    expect(rows.filter((r) => r.bandStart)).toHaveLength(1);
  });

  it("handles an empty day", () => {
    expect(planDayRows([], BAND)).toEqual([]);
  });
});

/**
 * The redesign's invariants live in `buildSheetContent`. They are cheap to
 * regress by hand (one stray `appendChild` inside the loop puts a badge back on
 * every row) and there is no DOM in this test environment, so they are asserted
 * against the source.
 */
describe("time sheet — the evening band's wiring", () => {
  const build = MAIN.slice(
    MAIN.indexOf("function buildSheetContent"),
    MAIN.indexOf("Open the evening section and return"),
  );

  it("builds the header and the caption once per run, not once per row", () => {
    // Both live behind a run boundary (`bandStart` / `bandEnd`), so N locked
    // rows can only ever produce one of each.
    expect(build).toContain("if (row.bandStart) band = openPrimeBand(body)");
    expect(build).toMatch(/if \(row\.bandEnd\) \{\s*\n\s*if \(primeLocked && band\)/);
    expect([...build.matchAll(/openPrimeBand\(/g)]).toHaveLength(1);
    expect([...build.matchAll(/primeBandCaption\(/g)]).toHaveLength(1);
  });

  it("carries no per-row Premium wording — the padlock is the whole marker", () => {
    expect(build).toContain('icon("lock", "icon prime-lock")');
    expect(MAIN).not.toContain("primeLockedTag");
    expect(MAIN).not.toContain("prime-plate");
  });

  it("gives the caption and the open-band tag to the states that own them", () => {
    // Caption: locked only. Tag + neutral header: open only.
    expect(build).toContain("if (primeLocked && band) band.appendChild(primeBandCaption())");
    expect(MAIN).toContain('tr(lang, primeLocked ? "primeBandLocked" : "primeBandOpen")');
    expect(MAIN).toMatch(/if \(!primeLocked\) \{[\s\S]*?primeBandOpenTag/);
  });

  it("routes a locked row to the sheet and an open row to the ordinary pick", () => {
    expect(build).toContain("if (row.prime && primeLocked)");
    expect(build).toContain('btn.addEventListener("click", () => onTapTime(row.iso))');
    // ...and the locked branch adds NO row-level listener: the band carries the
    // single one, so a tap cannot open the sheet twice (or buzz twice).
    const locked = build.slice(
      build.indexOf("if (row.prime && primeLocked)"),
      build.indexOf("} else {", build.indexOf("if (row.prime && primeLocked)")),
    );
    expect(locked).not.toContain("addEventListener");
    expect(MAIN).toContain('if (primeLocked) el.addEventListener("click", () => openPrimeSheet())');
  });

  it("prices the band with the authored star rather than the platform emoji", () => {
    expect(MAIN).toContain('icon("star", "icon prime-star")');
    expect(MAIN).toContain('cta.append(...priceLabel("primeBandCta"))');
    // The unlock sheet's own button quotes the same charge the same way.
    expect(MAIN).toContain('priceLabel("primeSheetCtaPay")');
  });

  it("keeps the header one lockup — the crest, then the word", () => {
    // The filler rule that used to run to the right edge is gone: it read as a
    // divider between the mark and its own label.
    expect(MAIN).not.toContain("prime-band-rule");
    expect(HTML).not.toContain("prime-band-rule");
  });

  it("lets a real slot state outrank the band's decor", () => {
    expect(build).toContain('if (cls === "empty") btn.appendChild');
  });

  it("keeps the band on screen once it is open", () => {
    // The server sends `slots` in both states; dropping them on unlock is what
    // used to make the section vanish the moment the pair paid for it.
    expect(MAIN).toContain("primeSlots = new Set(state.primeTime?.slots ?? [])");
    expect(MAIN).not.toContain("primeLocked ? (state.primeTime?.slots ?? []) : []");
  });

  it("redraws when the band's locked state changes under a poll", () => {
    expect(MAIN).toMatch(/return `\$\{agreedTime[^`]*\$\{primeLocked\}`/);
  });
});

describe("time sheet — the evening band's styling", () => {
  // The band's authored block only. The reduced-motion override for the same
  // selectors sits EARLIER in the file, so a naive "first rule with this
  // selector" over the whole document reads the frozen state and every
  // assertion below quietly inverts.
  const BAND = HTML.slice(
    HTML.indexOf("Prime Time: the paid evening band"),
    HTML.indexOf(".prime-backdrop"),
  );

  function rule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`\\n\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(BAND);
    if (!m) throw new Error(`no ${selector} rule in index.html`);
    return m[1];
  }

  it("never dims a locked row into a disabled one", () => {
    // The whole point of the redesign: a commercial offer that reads like an
    // invalid option is the failure mode, and `opacity` is how it happens.
    expect(rule(".slot.is-locked")).not.toMatch(/opacity|color/);
    expect(HTML).not.toContain(".slot.is-locked .slot-time-label");
  });

  it("lifts the band onto the silver premium layer, defined in both themes", () => {
    // Silver, not burgundy: burgundy in this sheet means "your partner marked
    // this", and it is the venue board's premium slab that this section has to
    // match. Every token it spends must exist in BOTH themes, or one theme
    // silently falls back to a transparent band.
    expect(rule(".prime-band")).toContain("var(--pt-slab)");
    for (const token of ["--pt-slab", "--pt-rim", "--pt-card", "--pt-lock"]) {
      expect([...HTML.matchAll(new RegExp(token + ":", "g"))]).toHaveLength(2);
    }
    // A rim, never a border: a border would add 1px to the box and push the
    // band's rows off the x-axis the margin/padding pair below keeps them on.
    expect(rule(".prime-band")).not.toMatch(/\bborder:/);
  });

  it("steps the band's rows off the tray without touching a pick state", () => {
    // Re-pointing `--slot-bg` re-tones only the EMPTY evening rows: every
    // selected state paints its own gradient and is untouched by this.
    expect(rule(".prime-band:not(.is-open)")).toContain("--slot-bg: var(--pt-card)");
  });

  it("drops the tier decoration once the band is open", () => {
    // Nothing is being sold any more. The tray, the rim and the shimmer all go;
    // the rows fall back to the ordinary `--slot-bg` because the scoped rule
    // above stops matching.
    expect(rule(".prime-band.is-open")).toContain("background: none");
    expect(rule(".prime-band.is-open")).toContain("box-shadow: none");
    expect(rule(".prime-band.is-open .prime-band-title")).toContain("animation: none");
    expect(MAIN).toContain("if (primeLocked) header.appendChild(primeCrest())");
  });

  it("names the tier with the brand crest and the shipped shimmer", () => {
    // The same treatment, timing and values as `.vc-premium-word` — two
    // surfaces selling one subscription must not shimmer at two speeds.
    const title = rule(".prime-band-title");
    expect(title).toContain("var(--pt-shimmer-base)");
    expect(title).toContain("var(--pt-shimmer-hi)");
    expect(title).toMatch(/animation: pt-shimmer 4\.6s linear infinite/);
    expect(title).toContain("background-clip: text");
    expect(HTML).toContain(".pt-bf-a { stop-color: var(--pt-bf-a); }");
  });

  it("freezes the shimmer to legible ink under reduced motion", () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n {6}\}/.exec(HTML);
    expect(reduced).not.toBeNull();
    expect(reduced![1]).toContain(".prime-band-title");
    expect(reduced![1]).toMatch(/animation: none/);
  });

  it("keeps the padlock out of the burgundy that means 'your partner'", () => {
    expect(rule(".prime-lock")).toContain("var(--pt-lock)");
    expect(rule(".prime-lock")).not.toContain("--brand");
  });

  it("keeps the band's rows on the same x-axis as every other row", () => {
    // The negative inline margin and the padding must cancel exactly, or the
    // three evening rows sit indented from the rest of the list.
    const band = rule(".prime-band");
    expect(band).toMatch(/margin:\s*2px\s+-8px\s+0/);
    expect(band).toMatch(/padding:\s*8px/);
  });

  it("gives the caption a real hit target", () => {
    // 11px + 11px + a 13px line at 1.35 ≈ 40px.
    expect(rule(".prime-band-cta")).toMatch(/padding:\s*11px/);
  });
});
