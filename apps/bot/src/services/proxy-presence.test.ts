import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_PRESENCE_TTL_MS,
  CHAT_PRESENCE_TTL_MS,
  TYPING_TTL_MS,
  bumpProxyChat,
  heldReadCount,
  leaveChat,
  markPresence,
  presenceOf,
  proxyChatVersion,
  resetProxyPresenceForTest,
  stopTyping,
  waitForProxyChatChange,
} from "./proxy-presence.js";

const M = "m-1";
const A = "uid-A";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T18:00:00.000Z"));
  resetProxyPresenceForTest();
});

afterEach(() => {
  resetProxyPresenceForTest();
  vi.useRealTimers();
});

describe("presence facts", () => {
  it("knows nothing about a person who never beat", () => {
    expect(presenceOf(M, A)).toEqual({ online: false, inChat: false, typing: false });
  });

  it("is online in the app, and stops being so one TTL after the last beat", () => {
    markPresence({ matchId: M, userId: A, place: "app" });
    expect(presenceOf(M, A)).toEqual({ online: true, inChat: false, typing: false });
    vi.advanceTimersByTime(APP_PRESENCE_TTL_MS + 10);
    expect(presenceOf(M, A).online).toBe(false);
  });

  /** The chat screen is inside the app: being there is being online. */
  it("counts the chat screen as online too", () => {
    markPresence({ matchId: M, userId: A, place: "chat" });
    expect(presenceOf(M, A)).toEqual({ online: true, inChat: true, typing: false });
  });

  it("keeps the reader on the chat screen for the whole of a held read", () => {
    const holdUntil = Date.now() + 20_000;
    markPresence({ matchId: M, userId: A, place: "chat", holdUntil });
    vi.advanceTimersByTime(20_000 + CHAT_PRESENCE_TTL_MS - 100);
    expect(presenceOf(M, A).inChat).toBe(true);
    vi.advanceTimersByTime(200);
    expect(presenceOf(M, A).inChat).toBe(false);
  });

  it("types for TYPING_TTL after the last beat, and not after", () => {
    markPresence({ matchId: M, userId: A, place: "chat", typing: true });
    expect(presenceOf(M, A).typing).toBe(true);
    vi.advanceTimersByTime(TYPING_TTL_MS + 10);
    expect(presenceOf(M, A)).toEqual({ online: true, inChat: true, typing: false });
  });

  /** A plain read must not cancel a typing beat that arrived a second ago. */
  it("leaves typing alone on a beat that does not mention it", () => {
    markPresence({ matchId: M, userId: A, place: "chat", typing: true });
    markPresence({ matchId: M, userId: A, place: "chat" });
    expect(presenceOf(M, A).typing).toBe(true);
  });

  it("clears typing on send and on an explicit false", () => {
    markPresence({ matchId: M, userId: A, place: "chat", typing: true });
    stopTyping(M, A);
    expect(presenceOf(M, A).typing).toBe(false);
    markPresence({ matchId: M, userId: A, place: "chat", typing: true });
    markPresence({ matchId: M, userId: A, place: "chat", typing: false });
    expect(presenceOf(M, A).typing).toBe(false);
  });

  it("leaves the chat but stays online when the chat screen goes away", () => {
    markPresence({ matchId: M, userId: A, place: "chat", typing: true });
    leaveChat(M, A);
    expect(presenceOf(M, A)).toEqual({ online: true, inChat: false, typing: false });
  });

  it("goes away entirely on 'away'", () => {
    markPresence({ matchId: M, userId: A, place: "chat", typing: true });
    markPresence({ matchId: M, userId: A, place: "away" });
    expect(presenceOf(M, A)).toEqual({ online: false, inChat: false, typing: false });
  });

  /** Presence is per date: the same person on another match is somebody else's business. */
  it("is scoped to the match", () => {
    markPresence({ matchId: M, userId: A, place: "app" });
    expect(presenceOf("m-2", A).online).toBe(false);
  });
});

describe("the change counter", () => {
  it("moves when what the partner sees moves, and only then", () => {
    const v0 = proxyChatVersion(M);
    markPresence({ matchId: M, userId: A, place: "app" });
    const v1 = proxyChatVersion(M);
    expect(v1).not.toBe(v0);
    // Another app beat changes nothing visible.
    markPresence({ matchId: M, userId: A, place: "app" });
    expect(proxyChatVersion(M)).toBe(v1);
    markPresence({ matchId: M, userId: A, place: "chat", typing: true });
    expect(proxyChatVersion(M)).not.toBe(v1);
  });

  /** A phone that vanished must stop "typing" on the partner's screen by itself. */
  it("moves when a fact expires on its own", () => {
    markPresence({ matchId: M, userId: A, place: "chat", typing: true });
    const before = proxyChatVersion(M);
    vi.advanceTimersByTime(TYPING_TTL_MS + 10);
    expect(proxyChatVersion(M)).not.toBe(before);
  });

  it("carries a boot stamp, so a restart never matches an old version", () => {
    expect(proxyChatVersion(M)).toMatch(/^[0-9a-z]+\.\d+$/);
  });
});

describe("waitForProxyChatChange", () => {
  it("answers at once when the caller's version is already stale", async () => {
    const stale = proxyChatVersion(M);
    bumpProxyChat(M);
    const ac = new AbortController();
    await expect(
      waitForProxyChatChange(M, { after: stale, until: Date.now() + 20_000, signal: ac.signal }),
    ).resolves.toBe(true);
  });

  it("holds until the next change, then lets go of its listener", async () => {
    const ac = new AbortController();
    const wait = waitForProxyChatChange(M, {
      after: proxyChatVersion(M),
      until: Date.now() + 20_000,
      signal: ac.signal,
    });
    expect(heldReadCount(M)).toBe(1);
    bumpProxyChat(M);
    await expect(wait).resolves.toBe(true);
    expect(heldReadCount(M)).toBe(0);
  });

  it("gives up at the deadline", async () => {
    const ac = new AbortController();
    const wait = waitForProxyChatChange(M, {
      after: proxyChatVersion(M),
      until: Date.now() + 20_000,
      signal: ac.signal,
    });
    vi.advanceTimersByTime(20_001);
    await expect(wait).resolves.toBe(false);
    expect(heldReadCount(M)).toBe(0);
  });

  it("ends the moment the client goes away", async () => {
    const ac = new AbortController();
    const wait = waitForProxyChatChange(M, {
      after: proxyChatVersion(M),
      until: Date.now() + 20_000,
      signal: ac.signal,
    });
    ac.abort();
    await expect(wait).resolves.toBe(false);
    expect(heldReadCount(M)).toBe(0);
  });

  /** The partner starting to type is exactly what a held read waits for. */
  it("wakes on the partner's typing", async () => {
    const ac = new AbortController();
    const wait = waitForProxyChatChange(M, {
      after: proxyChatVersion(M),
      until: Date.now() + 20_000,
      signal: ac.signal,
    });
    markPresence({ matchId: M, userId: "uid-B", place: "chat", typing: true });
    await expect(wait).resolves.toBe(true);
  });
});
