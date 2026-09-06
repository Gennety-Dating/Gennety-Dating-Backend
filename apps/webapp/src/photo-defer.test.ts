/**
 * The deferral policy behind every venue photo tile.
 *
 * What is actually being protected here is the Place Photo bill: a board builds
 * 21 tiles, each one a paid Google request the moment it starts loading, and
 * only ~5 are on screen. The two failure directions are opposite and both bad —
 * loading everything eagerly is the ~4× overspend this exists to remove, and
 * failing to load at all is a board of grey rectangles.
 */
import { describe, it, expect, vi } from "vitest";
import {
  loadWhenVisible,
  domObserverFactory,
  PHOTO_DEFER_ROOT_MARGIN,
  type DeferDeps,
  type DeferObserver,
} from "./photo-defer.js";

/** An observer the test fires by hand instead of a viewport. */
function fakeObserver(): {
  deps: DeferDeps;
  fire: () => void;
  observed: Element[];
  disconnects: number;
} {
  const observed: Element[] = [];
  let onVisible: (() => void) | null = null;
  let disconnects = 0;
  const observer: DeferObserver = {
    observe: (target) => observed.push(target),
    disconnect: () => {
      disconnects += 1;
    },
  };
  return {
    deps: {
      createObserver: (cb) => {
        onVisible = cb;
        return observer;
      },
    },
    fire: () => onVisible?.(),
    observed,
    get disconnects() {
      return disconnects;
    },
  };
}

const target = {} as Element;

describe("loadWhenVisible", () => {
  it("does NOT load before the tile is near the screen", () => {
    const start = vi.fn();
    const { deps } = fakeObserver();
    loadWhenVisible(target, start, deps);
    // The whole saving: a tile four screens down has bought nothing yet.
    expect(start).not.toHaveBeenCalled();
  });

  it("loads once the tile comes into range, and observes the right node", () => {
    const start = vi.fn();
    const fake = fakeObserver();
    loadWhenVisible(target, start, fake.deps);
    expect(fake.observed).toEqual([target]);
    fake.fire();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("loads at most once however often the observer fires", () => {
    // An observer fires on every crossing, and each extra `start` would be
    // another paid request for a photograph already on screen.
    const start = vi.fn();
    const fake = fakeObserver();
    loadWhenVisible(target, start, fake.deps);
    fake.fire();
    fake.fire();
    fake.fire();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("disconnects after firing so a board does not accumulate observers", () => {
    const fake = fakeObserver();
    loadWhenVisible(target, vi.fn(), fake.deps);
    expect(fake.disconnects).toBe(0);
    fake.fire();
    expect(fake.disconnects).toBe(1);
  });

  it("loads EAGERLY where there is no observer to build", () => {
    // An old webview must show photographs, not save money by never loading
    // them. Eager is the previous behaviour; blank is a bug.
    const start = vi.fn();
    loadWhenVisible(target, start, { createObserver: null });
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("domObserverFactory", () => {
  it("returns null when IntersectionObserver is unavailable", () => {
    // Which is what routes such an environment to the eager path above.
    expect(typeof IntersectionObserver).toBe("undefined");
    expect(domObserverFactory()).toBeNull();
  });

  it("looks a full viewport ahead", () => {
    // Short enough and the tile is still grey when it arrives; long enough and
    // the deferral stops saving anything.
    expect(PHOTO_DEFER_ROOT_MARGIN).toBe("100% 0px");
  });
});
