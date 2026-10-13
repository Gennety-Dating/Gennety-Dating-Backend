import { describe, it, expect } from "vitest";
import { createSingleFlight } from "./single-flight.js";

describe("createSingleFlight", () => {
  it("hands a concurrent caller the load already in flight", async () => {
    const flights = createSingleFlight<string, number>();
    let calls = 0;
    let finish!: (n: number) => void;
    const load = () => {
      calls += 1;
      return new Promise<number>((resolve) => (finish = resolve));
    };

    const first = flights.join("k", load);
    const second = flights.join("k", load);
    expect(first.joined).toBe(false);
    expect(second.joined).toBe(true);
    expect(calls).toBe(1);

    finish(7);
    expect(await first.result).toBe(7);
    expect(await second.result).toBe(7);
  });

  it("forgets a load before anyone sees its result", async () => {
    const flights = createSingleFlight<string, number>();
    const first = flights.join("k", async () => 1);
    await first.result;
    expect(flights.size).toBe(0);

    const next = flights.join("k", async () => 2);
    expect(next.joined).toBe(false);
    expect(await next.result).toBe(2);
  });

  it("forgets a failed load too", async () => {
    const flights = createSingleFlight<string, number>();
    await expect(
      flights.join("k", async () => {
        throw new Error("boom");
      }).result,
    ).rejects.toThrow("boom");
    expect(flights.size).toBe(0);
  });

  it("never registers a load that throws before returning a promise", async () => {
    const flights = createSingleFlight<string, number>();
    const broken = flights.join("k", () => {
      throw new Error("sync");
    });
    await expect(broken.result).rejects.toThrow("sync");
    expect(flights.size).toBe(0);
    expect(flights.join("k", async () => 3).joined).toBe(false);
  });

  it("keeps keys apart", async () => {
    const flights = createSingleFlight<string, string>();
    const a = flights.join("a", async () => "a");
    const b = flights.join("b", async () => "b");
    expect(b.joined).toBe(false);
    expect([await a.result, await b.result]).toEqual(["a", "b"]);
  });
});
