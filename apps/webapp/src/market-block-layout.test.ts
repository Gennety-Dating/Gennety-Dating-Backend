import { describe, expect, it } from "vitest";
// `?raw` rather than `node:fs`: this package compiles with `types: []`, so a
// Node builtin would break `pnpm typecheck` even though vitest runs it happily.
// The stylesheet is non-empty only because vite.config.ts lists it in
// `test.css.include` — vitest stubs CSS imports otherwise.
import HTML from "../location.html?raw";
import CSS from "./location.css?raw";

/**
 * The departure-point gate's banner (PRODUCT_SPEC §3.7) is the only thing on
 * screen that explains why Confirm went dead, and in demo mode it carries a
 * second child — the "drop the pin in {city}" action (DEMO_MODE.md).
 *
 * That action has to sit UNDER the sentence, and the reason is a flexbox trap
 * rather than a matter of taste. `.market-block` is a flex row; a button that
 * is a direct child of it becomes a third COLUMN however it is styled, because
 * `display: block` on a flex item says nothing about wrapping. Flex then
 * distributes the shrink by base size, and the sentence — whose base size is
 * enormous next to a short button label — takes nearly all of it. Measured on
 * the real screen: the copy collapsed to a strip roughly one word wide, which
 * is exactly what the founder reported.
 *
 * So the invariant is structural, not cosmetic: the copy and the action share
 * ONE wrapper, and the wrapper can shrink.
 */

/** The `{ … }` body of a single rule, as authored. */
function rule(selector: string): string {
  const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!m) throw new Error(`no ${selector} rule in location.css`);
  return m[1]!;
}

describe("departure-point gate banner layout", () => {
  it("keeps the copy and the demo action inside one wrapper", () => {
    const wrapper = HTML.indexOf('class="market-block-body"');
    const text = HTML.indexOf('id="market-block-text"');
    const jump = HTML.indexOf('id="market-jump"');

    expect(wrapper).toBeGreaterThan(-1);
    expect(text).toBeGreaterThan(wrapper);
    expect(jump).toBeGreaterThan(text);

    // The load-bearing half. If the button is moved back out to sit beside the
    // sentence, the wrapper closes before it — and this is what catches it.
    expect(HTML.slice(wrapper, jump)).not.toContain("</div>");
  });

  it("lets that wrapper shrink below its longest word", () => {
    // A flex item defaults to `min-width: auto`, which refuses to shrink past
    // its longest word — enough for a long city name to push the banner wider
    // than the island it sits in.
    expect(rule(".market-block-body")).toMatch(/min-width:\s*0/);
  });

  it("does not let the copy compete for width as its own flex item", () => {
    // `.market-block-text` is inside the wrapper now, so a `flex:` on it would
    // mean someone had put it back in the row.
    expect(rule(".market-block-text")).not.toMatch(/flex:/);
  });

  it("stacks the demo action rather than seating it in the row", () => {
    const jump = rule(".market-block-jump");
    expect(jump).toMatch(/display:\s*block/);
    expect(jump).toMatch(/margin-top:/);
  });

  it("sets the banner at full-strength text, not the dimmed readout grey", () => {
    // It is the only explanation for a dead Confirm button; the founder read
    // the dimmed 13px version as too small to notice.
    const block = rule(".market-block");
    expect(block).toMatch(/color:\s*var\(--text\)/);
    expect(block).not.toMatch(/color:\s*var\(--text-dim\)/);
  });
});
