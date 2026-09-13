/**
 * Two small pieces every pay button in the Mini Apps needs, kept pure so they
 * are tested without Telegram, React or a DOM.
 *
 * THE GUARD. A pay button that mints a Stars invoice awaits the server before
 * the sheet opens, and a double tap inside that gap mints two invoices. Most of
 * the time the second one is refused or refunded server-side — but a second
 * ticket BUNDLE is a real second purchase. So the check and the set happen in
 * one synchronous step, before the first `await`: a React state flag cannot do
 * that (it only changes on the next render), and a plain `busy` that is set but
 * never checked — which is what the venue board had — does nothing at all.
 *
 * THE POLL. Telegram reports `paid` from the invoice sheet, but the bot learns
 * of it on its own `successful_payment` connection, often a second or two
 * later. A single re-read straight after `paid` therefore usually shows the
 * unpaid screen again, with its pay button — the exact moment someone pays
 * twice. `premium.ts` (`pollUntilActive`) and the calendar's Prime Time unlock
 * already wait for the server to agree; this is that loop, shared.
 */

export interface InFlightGuard {
  /** True, and now held, when nothing was in flight; false when one was. */
  tryEnter(): boolean;
  leave(): void;
  readonly active: boolean;
}

export function createInFlightGuard(): InFlightGuard {
  let held = false;
  return {
    tryEnter(): boolean {
      if (held) return false;
      held = true;
      return true;
    },
    leave(): void {
      held = false;
    },
    get active(): boolean {
      return held;
    },
  };
}

/** Same cadence as `premium.ts`: ~20 s of patience before handing back. */
export const SETTLE_POLL_ATTEMPTS = 15;
export const SETTLE_POLL_DELAY_MS = 1500;

export interface PollOptions {
  attempts?: number;
  delayMs?: number;
  /** Injected so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read until `done` holds. Resolves with the reading that satisfied it, or with
 * the last successful reading (null if every read failed) once the attempts run
 * out — the caller still has to draw SOMETHING, and the settle DM lands in the
 * chat either way. A failed read is retried, never thrown: this runs after a
 * payment that already went through.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options: PollOptions = {},
): Promise<{ value: T | null; settled: boolean }> {
  const attempts = options.attempts ?? SETTLE_POLL_ATTEMPTS;
  const delayMs = options.delayMs ?? SETTLE_POLL_DELAY_MS;
  const sleep = options.sleep ?? realSleep;
  let last: T | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await read();
      last = value;
      if (done(value)) return { value, settled: true };
    } catch {
      // Retry below.
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return { value: last, settled: false };
}
