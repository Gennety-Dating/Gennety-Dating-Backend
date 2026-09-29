/**
 * The server's clock, as seen from this phone — so two phones start ONE scene.
 *
 * The server names the start (`ceremony.startAt`) on its own clock. A phone's
 * clock can be seconds off, so each `GET /v1/date/state` answer (`serverNow`)
 * becomes a sample the NTP way: the server stamped its time somewhere inside
 * the round trip, most likely in the middle, so
 *
 *     offset = serverNow − (sentAt + receivedAt) / 2
 *
 * and the error is at most half the round trip. Of the last few samples the
 * one with the SHORTEST round trip wins — a slow answer says less about when
 * the server stamped it. The air pause in the scene (`FLIGHT.air`, 140 ms)
 * hides what is left.
 *
 * Local time is `performance.timeOrigin + performance.now()`, not `Date.now()`:
 * it does not jump when the phone's clock is corrected mid-evening, and every
 * sample and every frame read the same base.
 */

export const CLOCK_SAMPLES_KEPT = 8;

export interface ClockSample {
  /** Local wall ms when the request left. */
  sentAt: number;
  /** Local wall ms when the answer arrived. */
  receivedAt: number;
  /** The server's clock in the answer, epoch ms. */
  serverNow: number;
}

export function wallNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function" && performance.timeOrigin) {
    return performance.timeOrigin + performance.now();
  }
  return Date.now();
}

export interface ServerClock {
  /** A request/answer pair with the server's time in it. Ignores nonsense. */
  record(sample: ClockSample): void;
  /**
   * A one-way hint — the server's time in an answer whose round trip is
   * meaningless (the hold long-poll waits up to 10 s). Used only while there
   * is no real sample.
   */
  hint(receivedAt: number, serverNow: number): void;
  /** Server ms minus local ms, or null with nothing to go on. */
  offset(): number | null;
  /** The server's clock now, best estimate; the local clock without samples. */
  now(): number;
  /** Round trip of the sample in use, ms (null without one). */
  uncertainty(): number | null;
}

export function createServerClock(options: { keep?: number; local?: () => number } = {}): ServerClock {
  const keep = options.keep ?? CLOCK_SAMPLES_KEPT;
  const local = options.local ?? wallNow;
  const samples: { rtt: number; offset: number }[] = [];
  let oneWay: number | null = null;

  const best = (): { rtt: number; offset: number } | null => {
    let pick: { rtt: number; offset: number } | null = null;
    for (const s of samples) if (!pick || s.rtt < pick.rtt) pick = s;
    return pick;
  };

  return {
    record(sample) {
      const rtt = sample.receivedAt - sample.sentAt;
      if (!Number.isFinite(rtt) || rtt < 0 || !Number.isFinite(sample.serverNow)) return;
      samples.push({ rtt, offset: sample.serverNow - (sample.sentAt + sample.receivedAt) / 2 });
      while (samples.length > keep) samples.shift();
    },
    hint(receivedAt, serverNow) {
      if (Number.isFinite(serverNow) && Number.isFinite(receivedAt)) oneWay = serverNow - receivedAt;
    },
    offset() {
      return best()?.offset ?? oneWay;
    },
    now() {
      return local() + (best()?.offset ?? oneWay ?? 0);
    },
    uncertainty() {
      return best()?.rtt ?? null;
    },
  };
}

/** `serverNow` as the API sends it (ISO), or NaN. */
export function parseServerTime(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : Number.NaN;
}
