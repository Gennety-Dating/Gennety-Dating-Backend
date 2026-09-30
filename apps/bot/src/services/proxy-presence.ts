/**
 * Who is here right now — the live half of the proxy chat (DECISIONS
 * 2026-09-30, «в сети» and «печатает…»).
 *
 * Three facts per person per date, each with its own expiry:
 *
 *  - **in the app** — the phone is in the foreground during the window. The app
 *    beats every ~20 s, so the fact outlives one missed beat (`APP_…_TTL`).
 *  - **in the chat** — the chat screen is on the phone. Reading the chat is the
 *    beat: a held long-poll keeps it alive for as long as it is held.
 *  - **typing** — the composer changed in the last few seconds. The app repeats
 *    it every ~3 s while the draft keeps changing and clears it on send.
 *
 * ── Nothing is stored, on purpose ────────────────────────────────────────
 *
 * Presence is worth something for seconds and is a claim about another person
 * the moment it is written down. So it lives in this process and nowhere else:
 * a restart forgets it (the next beat restores it), and no log, table or
 * backup ever holds "who was online when". Same stance as `bump-ceremony.ts`:
 * the bot runs as ONE process (pm2 `gennety-bot`), so an in-process map and an
 * in-process emitter are the whole transport. If the bot is ever scaled out,
 * this file is the one that needs a shared bus — and the one that says so.
 *
 * ── The change counter ───────────────────────────────────────────────────
 *
 * Every visible change to a date's chat — a message, a reaction, a read tick,
 * a presence flip — bumps one counter per match and wakes whoever is waiting on
 * it. `GET /v1/matches/{id}/chat?after=<version>` is a long-poll on exactly
 * that: it answers at once when the caller's version is stale, and otherwise
 * holds until the next bump or `PROXY_CHAT_HOLD_MS`. The version carries a boot
 * stamp, so a restart can never leave a phone holding a version that happens
 * to equal the new process's count and waiting on a change it already missed.
 *
 * Expiry is a change too: a phone that vanishes without saying goodbye stops
 * being "typing" six seconds later, and the partner's screen hears about it
 * then — one timer per person, re-armed on every beat, dropped with the entry.
 */

import { EventEmitter } from "node:events";

/** The app beats every ~20 s while in the foreground; one missed beat is fine. */
export const APP_PRESENCE_TTL_MS = 45_000;

/** A chat screen polling every 4 s (older builds) stays "in the chat". */
export const CHAT_PRESENCE_TTL_MS = 12_000;

/** The app repeats "typing" every ~3 s while the draft keeps changing. */
export const TYPING_TTL_MS = 6_000;

/** How long `GET …/chat?after=` holds before answering "nothing new". */
export const PROXY_CHAT_HOLD_MS = 20_000;

/** What a phone reports about itself. */
export type PresencePlace = "app" | "chat" | "away";

/** What the partner is shown. All false when nothing is known. */
export interface PartnerPresence {
  online: boolean;
  inChat: boolean;
  typing: boolean;
}

export const NOBODY: PartnerPresence = Object.freeze({
  online: false,
  inChat: false,
  typing: false,
});

interface Beat {
  appUntil: number;
  chatUntil: number;
  typingUntil: number;
  /** What the partner was last woken with — a change is measured against it. */
  published: PartnerPresence;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const beats = new Map<string, Beat>();
const versions = new Map<string, number>();
const changes = new EventEmitter();
// One listener per held long-poll, keyed by match id. The rate limiter bounds
// how many a person can open; the default warning at 10 would only be noise.
changes.setMaxListeners(0);

const BOOT = Date.now().toString(36);

function keyOf(matchId: string, userId: string): string {
  return `${matchId}:${userId}`;
}

function stateOf(beat: Beat | undefined, now: number): PartnerPresence {
  if (!beat) return NOBODY;
  const inChat = beat.chatUntil > now;
  return {
    online: inChat || beat.appUntil > now,
    inChat,
    // Typing outlives the chat only by accident (a dropped long-poll); a person
    // who is not on the chat screen is not typing into it.
    typing: inChat && beat.typingUntil > now,
  };
}

function same(a: PartnerPresence, b: PartnerPresence): boolean {
  return a.online === b.online && a.inChat === b.inChat && a.typing === b.typing;
}

/** The version a read of this match's chat is answered with. */
export function proxyChatVersion(matchId: string): string {
  return `${BOOT}.${versions.get(matchId) ?? 0}`;
}

/**
 * Something the chat shows has changed: advance the version and wake every
 * long-poll held on this match. Called by the relay, the reaction, the read
 * cursor and presence itself.
 */
export function bumpProxyChat(matchId: string): void {
  versions.set(matchId, (versions.get(matchId) ?? 0) + 1);
  changes.emit(matchId);
}

/** What `userId`'s partner would be shown about `userId` right now. */
export function presenceOf(matchId: string, userId: string, now: number = Date.now()): PartnerPresence {
  return stateOf(beats.get(keyOf(matchId, userId)), now);
}

/**
 * Publish if the visible state moved, then arm the timer for the next moment
 * it will move on its own (the soonest expiry still ahead). Drops the entry
 * once everything has expired.
 */
function settle(matchId: string, userId: string, beat: Beat, now: number): void {
  const key = keyOf(matchId, userId);
  const state = stateOf(beat, now);
  if (!same(state, beat.published)) {
    beat.published = state;
    bumpProxyChat(matchId);
  }

  clearTimeout(beat.timer);
  beat.timer = undefined;
  const ahead = [beat.appUntil, beat.chatUntil, beat.typingUntil].filter((t) => t > now);
  if (ahead.length === 0) {
    beats.delete(key);
    return;
  }
  const next = Math.min(...ahead);
  beat.timer = setTimeout(() => settle(matchId, userId, beat, Date.now()), next - now + 5);
  // A presence timer must never keep the process (or a test run) alive.
  beat.timer.unref?.();
}

/**
 * Record what a phone says about itself.
 *
 * `holdUntil` is a long-poll's own deadline: while a read is held open the
 * reader is on the chat screen for all of it, not just for `CHAT_…_TTL`.
 *
 * `typing` is only read with `"chat"` — the composer lives on the chat screen.
 * Absent leaves the typing fact as it was (a plain read must not cancel it).
 */
export function markPresence(input: {
  matchId: string;
  userId: string;
  place: PresencePlace;
  typing?: boolean;
  holdUntil?: number;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  const key = keyOf(input.matchId, input.userId);
  let beat = beats.get(key);
  if (!beat) {
    if (input.place === "away") return;
    beat = { appUntil: 0, chatUntil: 0, typingUntil: 0, published: NOBODY, timer: undefined };
    beats.set(key, beat);
  }

  switch (input.place) {
    case "away":
      beat.appUntil = 0;
      beat.chatUntil = 0;
      beat.typingUntil = 0;
      break;
    case "app":
      beat.appUntil = now + APP_PRESENCE_TTL_MS;
      break;
    case "chat":
      beat.appUntil = now + APP_PRESENCE_TTL_MS;
      beat.chatUntil = Math.max(
        beat.chatUntil,
        now + CHAT_PRESENCE_TTL_MS,
        (input.holdUntil ?? 0) + CHAT_PRESENCE_TTL_MS,
      );
      if (input.typing !== undefined) {
        beat.typingUntil = input.typing ? now + TYPING_TTL_MS : 0;
      }
      break;
  }
  settle(input.matchId, input.userId, beat, now);
}

/**
 * The chat screen went away (its long-poll was dropped). The person is still
 * in the app — that fact has its own beat — but no longer reading or typing.
 */
export function leaveChat(matchId: string, userId: string, now: number = Date.now()): void {
  const beat = beats.get(keyOf(matchId, userId));
  if (!beat) return;
  beat.chatUntil = 0;
  beat.typingUntil = 0;
  settle(matchId, userId, beat, now);
}

/** A line was sent: whoever wrote it has stopped typing it. */
export function stopTyping(matchId: string, userId: string, now: number = Date.now()): void {
  const beat = beats.get(keyOf(matchId, userId));
  if (!beat || beat.typingUntil === 0) return;
  beat.typingUntil = 0;
  settle(matchId, userId, beat, now);
}

/**
 * Wait until this match's chat changes past `after`, the deadline passes, or
 * the client goes away. Resolves true on a change (or a version that was
 * already stale), false otherwise.
 *
 * Holds nothing while it waits — no query, no transaction: one listener and
 * one timer, both removed on every way out. There is no fallback poll (unlike
 * the Bump's hold): every writer of this chat runs in this process, and a
 * missed wake-up costs one deadline, after which the client reads anyway.
 */
export function waitForProxyChatChange(
  matchId: string,
  options: { after: string; until: number; signal: AbortSignal; now?: () => number },
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const { signal } = options;
  if (proxyChatVersion(matchId) !== options.after) return Promise.resolve(true);
  if (signal.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (changed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      changes.off(matchId, onChange);
      signal.removeEventListener("abort", onAbort);
      resolve(changed);
    };
    const onChange = (): void => finish(true);
    const onAbort = (): void => finish(false);
    const deadline = setTimeout(() => finish(false), Math.max(0, options.until - now()));
    changes.on(matchId, onChange);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Test/diagnostic: how many long-polls are held on this match right now. */
export function heldReadCount(matchId: string): number {
  return changes.listenerCount(matchId);
}

/** Test hook — forget everything, cancel every timer. */
export function resetProxyPresenceForTest(): void {
  for (const beat of beats.values()) clearTimeout(beat.timer);
  beats.clear();
  versions.clear();
  changes.removeAllListeners();
}
