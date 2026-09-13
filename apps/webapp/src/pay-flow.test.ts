import { describe, expect, it } from "vitest";
import { createInFlightGuard, pollUntil } from "./pay-flow";

/** A13-M28 — a double tap on a pay button must not mint a second invoice. */
describe("createInFlightGuard", () => {
  it("lets exactly one of two back-to-back taps through", () => {
    const guard = createInFlightGuard();
    expect(guard.tryEnter()).toBe(true);
    // The second tap arrives before the first request's await has settled.
    expect(guard.tryEnter()).toBe(false);
    expect(guard.active).toBe(true);
  });

  it("opens again once the flight has landed", () => {
    const guard = createInFlightGuard();
    guard.tryEnter();
    guard.leave();
    expect(guard.active).toBe(false);
    expect(guard.tryEnter()).toBe(true);
  });
});

describe("pollUntil", () => {
  const noWait = (): Promise<void> => Promise.resolve();

  it("keeps reading until the server shows the payment settled", async () => {
    const readings = [{ paid: false }, { paid: false }, { paid: true }];
    let calls = 0;
    const result = await pollUntil(
      async () => readings[calls++]!,
      (s) => s.paid,
      { sleep: noWait },
    );
    expect(result).toEqual({ value: { paid: true }, settled: true });
    expect(calls).toBe(3);
  });

  it("retries a failed read instead of giving up after a payment", async () => {
    let calls = 0;
    const result = await pollUntil(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("network");
        return { paid: true };
      },
      (s) => s.paid,
      { sleep: noWait },
    );
    expect(result.settled).toBe(true);
    expect(calls).toBe(2);
  });

  it("hands back the last reading when the attempts run out", async () => {
    const sleeps: number[] = [];
    const result = await pollUntil(
      async () => ({ paid: false }),
      (s) => s.paid,
      { attempts: 3, delayMs: 10, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toEqual({ value: { paid: false }, settled: false });
    // No pointless wait after the final attempt.
    expect(sleeps).toEqual([10, 10]);
  });

  it("answers null when no read ever succeeded", async () => {
    const result = await pollUntil(
      async (): Promise<{ paid: boolean }> => {
        throw new Error("offline");
      },
      (s) => s.paid,
      { attempts: 2, sleep: noWait },
    );
    expect(result).toEqual({ value: null, settled: false });
  });
});
