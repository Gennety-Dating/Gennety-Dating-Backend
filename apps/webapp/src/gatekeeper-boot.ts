/**
 * What the door does with a saved key when the page starts (A13-M32).
 *
 * The door portal re-checks its saved key on every open. It used to forget the
 * key on ANY failure of that check — including no signal, which is the normal
 * condition in the basement bars these doors are at. Staff then stood at the
 * entrance with a token screen, no key to type back in (the organiser handed
 * it over once), and no guest list either.
 *
 * Only the server saying "this key is not valid" (401/403) is a reason to
 * forget it. Everything else — no answer, 429, 5xx, a 404 from a deploy blip —
 * says nothing about the key, so the door opens with what it has: the scanner,
 * which reports "offline" per scan, and the guest-list fallback behind that.
 */

export type DoorBoot =
  /** The key checked out — open the door normally. */
  | "door"
  /** The server rejected the key — forget it and ask for a new one. */
  | "forget-key"
  /** No verdict on the key — keep it and open the door in offline mode. */
  | "offline-door";

/** `status` is the `/auth` response's HTTP status, or null when none arrived. */
export function doorBootFor(status: number | null): DoorBoot {
  if (status !== null && status >= 200 && status < 300) return "door";
  if (status === 401 || status === 403) return "forget-key";
  return "offline-door";
}
