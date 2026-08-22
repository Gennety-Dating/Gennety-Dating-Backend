import { describe, expect, it } from "vitest";
import { KB_HEIGHT_STEP_PX, isWorthWriting, keyboardInset } from "./keyboard-viewport.js";

/**
 * The screen these numbers come from: a 393x852 CSS-px iPhone with a 298px
 * Ukrainian keyboard, which is what the reported "the name screen slides up to
 * the top" screenshot was measured on.
 */
const SCREEN = 852;
const KEYBOARD = 298;
const VISIBLE = SCREEN - KEYBOARD; // 554

describe("keyboardInset", () => {
  it("reserves the keyboard when it FLOATS over an untouched layout viewport", () => {
    // iOS Safari's own behaviour: the shell is still full height.
    expect(
      keyboardInset({ shellHeight: SCREEN, viewportHeight: VISIBLE, viewportOffsetTop: 0 }),
    ).toBe(KEYBOARD);
  });

  it("reserves NOTHING once the client has resized the layout viewport for it", () => {
    // The regression. `100dvh` — and the shell with it — has already made room,
    // so a second reservation is what pushed the screen into the top third.
    expect(
      keyboardInset({ shellHeight: VISIBLE, viewportHeight: VISIBLE, viewportOffsetTop: 0 }),
    ).toBe(0);
  });

  it("leaves the visible height intact in BOTH cases, which is the point", () => {
    const floating = keyboardInset({
      shellHeight: SCREEN,
      viewportHeight: VISIBLE,
      viewportOffsetTop: 0,
    });
    const resized = keyboardInset({
      shellHeight: VISIBLE,
      viewportHeight: VISIBLE,
      viewportOffsetTop: 0,
    });
    // `calc(100% - kb)` where 100% is the shell's own height.
    expect(SCREEN - floating).toBe(VISIBLE);
    expect(VISIBLE - resized).toBe(VISIBLE);
  });

  it("reproduces the double reservation when a STALE full-screen height is used", () => {
    // What the old code effectively did: the shell had shrunk to 554 while the
    // reference was still the 852 read a frame earlier. Guards the diagnosis,
    // not the fix — if this ever stops being a double, the story changed.
    const stale = keyboardInset({
      shellHeight: SCREEN,
      viewportHeight: VISIBLE,
      viewportOffsetTop: 0,
    });
    expect(VISIBLE - stale).toBeLessThan(VISIBLE / 2);
    expect(VISIBLE - stale).toBe(VISIBLE - KEYBOARD);
  });

  it("counts a scrolled visual viewport against the bottom inset, not for it", () => {
    // WebKit scrolls a focused field into view: less of the page is hidden
    // below, so less is reserved.
    expect(
      keyboardInset({ shellHeight: SCREEN, viewportHeight: VISIBLE, viewportOffsetTop: 40 }),
    ).toBe(KEYBOARD - 40);
  });

  it("never returns a negative inset", () => {
    expect(
      keyboardInset({ shellHeight: VISIBLE, viewportHeight: SCREEN, viewportOffsetTop: 0 }),
    ).toBe(0);
  });

  it("reserves nothing before the shell has been laid out", () => {
    // A 0-height shell is "not measured yet", never "entirely covered".
    expect(
      keyboardInset({ shellHeight: 0, viewportHeight: VISIBLE, viewportOffsetTop: 0 }),
    ).toBe(0);
  });
});

describe("isWorthWriting", () => {
  it("always writes the first value", () => {
    expect(isWorthWriting(null, 0)).toBe(true);
  });

  it("ignores the sub-pixel ramp WebKit produces while scrolling a field in", () => {
    expect(isWorthWriting(298, 299)).toBe(false);
  });

  it("writes a change at the step and above", () => {
    expect(isWorthWriting(298, 298 + KB_HEIGHT_STEP_PX)).toBe(true);
    expect(isWorthWriting(298, 0)).toBe(true);
  });
});

/**
 * The arithmetic above is only correct if it is handed the right reference, and
 * the reference lives in `onboarding.tsx`. That file is a React entry with no
 * export worth importing, and the effect is a `visualViewport` listener a DOM
 * test cannot exercise without a soft keyboard — which headless has none of
 * (the reason the 2026-08-18 pass measured this on a real render instead). So
 * the wiring is pinned as source text, the same way `location-thinking.test.ts`
 * pins a copy table it cannot import.
 *
 * Two properties, and they are the two halves of the reported bug.
 */
describe("the onboarding shell is what the inset is measured against", () => {
  async function viewportEffect(): Promise<string> {
    const src: string = (await import("./onboarding.tsx?raw")).default;
    const from = src.indexOf("const vv = window.visualViewport;");
    expect(from, "the keyboard-aware viewport effect moved or was removed").toBeGreaterThan(0);
    const rest = src.slice(from);
    return rest.slice(0, rest.indexOf("}, []);"));
  }

  it("passes the shell's live height, never window.innerHeight", async () => {
    // The shell is what `calc(100% - var(--kb-height))` resolves against, so it
    // shrinks with the layout viewport on a client that resizes the WebView for
    // the keyboard, and the reservation falls to zero on its own.
    // `window.innerHeight` carries no such guarantee: a different quantity,
    // sampled at a different moment, and using it made the name screen reserve
    // room for one keyboard inside a viewport that had already reserved room
    // for the same keyboard.
    const body = await viewportEffect();
    expect(body).toContain("shellHeight: shell.clientHeight");
    expect(body, "the inset must not be measured against window.innerHeight").not.toContain(
      "window.innerHeight",
    );
  });

  it("re-measures when the shell's own box changes, not only on a viewport event", async () => {
    // A layout-viewport resize can leave `visualViewport` alone entirely, so
    // the vv listeners by themselves can miss it — which is how a full
    // keyboard's worth of reservation stayed stranded on an already-shrunk
    // screen. Observing the element covers every route to that without having
    // to guess which event a given client fires.
    const body = await viewportEffect();
    expect(body).toContain("new ResizeObserver(schedule)");
    expect(body).toContain('observer?.observe(shellRef.current)');
  });
});
