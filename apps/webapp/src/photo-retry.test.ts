import { describe, it, expect, vi } from "vitest";
import {
  loadPhotoWithRetry,
  retryUrl,
  PHOTO_RETRY_DELAY_MS,
  type PhotoLoadDeps,
} from "./photo-retry.js";

interface Attempt {
  src: string;
  done: (ok: boolean) => void;
}

/** A loader the test drives by hand instead of a network. */
function fakeLoader(): {
  deps: PhotoLoadDeps;
  attempts: Attempt[];
  runTimers: () => void;
  delays: number[];
} {
  const attempts: Attempt[] = [];
  const timers: (() => void)[] = [];
  const delays: number[] = [];
  const deps: PhotoLoadDeps = {
    load: (src, done) => attempts.push({ src, done }),
    schedule: (fn, ms) => {
      delays.push(ms);
      timers.push(fn);
    },
  };
  return { deps, attempts, delays, runTimers: () => timers.splice(0).forEach((f) => f()) };
}

const URL = "https://api.example/v1/venue-change/photo?ref=places%2Fa%2Fphotos%2Fb&w=240&tma=x";

describe("retryUrl", () => {
  it("marks the retry so it cannot be answered from whatever just failed", () => {
    expect(retryUrl(URL)).toBe(`${URL}&retry=1`);
  });

  it("still produces a valid query on a URL that has none", () => {
    expect(retryUrl("https://api.example/photo")).toBe("https://api.example/photo?retry=1");
  });
});

describe("loadPhotoWithRetry", () => {
  it("settles with the loaded URL on a first-attempt success, and never retries", () => {
    const { deps, attempts, runTimers } = fakeLoader();
    const settle = vi.fn();

    loadPhotoWithRetry(URL, settle, deps);
    attempts[0]!.done(true);
    runTimers();

    expect(settle).toHaveBeenCalledExactlyOnceWith(URL);
    expect(attempts).toHaveLength(1);
  });

  it("retries once after a failure and reports the URL that actually decoded", () => {
    // The regression this whole module exists for: before it, one dropped
    // connection left the tile permanently blank for the rest of the session.
    const { deps, attempts, delays, runTimers } = fakeLoader();
    const settle = vi.fn();

    loadPhotoWithRetry(URL, settle, deps);
    attempts[0]!.done(false);

    expect(settle).not.toHaveBeenCalled(); // still shimmering, not yet given up
    expect(delays).toEqual([PHOTO_RETRY_DELAY_MS]);

    runTimers();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.src).toBe(retryUrl(URL));

    attempts[1]!.done(true);
    // The retry's URL, not the original — painting the original would issue a
    // second request for the bytes that just failed.
    expect(settle).toHaveBeenCalledExactlyOnceWith(retryUrl(URL));
  });

  it("gives up after the second failure rather than looping", () => {
    const { deps, attempts, runTimers } = fakeLoader();
    const settle = vi.fn();

    loadPhotoWithRetry(URL, settle, deps);
    attempts[0]!.done(false);
    runTimers();
    attempts[1]!.done(false);
    runTimers();

    expect(settle).toHaveBeenCalledExactlyOnceWith(null);
    expect(attempts).toHaveLength(2);
  });

  it("settles once even if a loader reports twice", () => {
    const { deps, attempts, runTimers } = fakeLoader();
    const settle = vi.fn();

    loadPhotoWithRetry(URL, settle, deps);
    attempts[0]!.done(false);
    runTimers();
    attempts[1]!.done(true);
    attempts[1]!.done(false); // a stray second report must not re-settle
    attempts[0]!.done(true);

    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("a success reported synchronously (browser cache) cannot schedule a retry", () => {
    // `domImageLoader` reports from `img.complete` before any event fires; a
    // stray later `onerror` on that same element must not undo it.
    const { deps, attempts, delays } = fakeLoader();
    const settle = vi.fn();

    loadPhotoWithRetry(URL, settle, deps);
    attempts[0]!.done(true);
    attempts[0]!.done(false);

    expect(settle).toHaveBeenCalledExactlyOnceWith(URL);
    expect(delays).toEqual([]);
  });
});
