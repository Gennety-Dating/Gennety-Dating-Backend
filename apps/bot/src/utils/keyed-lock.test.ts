import { describe, expect, it } from "vitest";
import { KeyedLock } from "./keyed-lock.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("KeyedLock", () => {
  it("runs calls with the same key one after another, in order", async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const task = (name: string) => async () => {
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
      return name;
    };
    const results = await Promise.all([lock.run("u", task("a")), lock.run("u", task("b"))]);
    expect(results).toEqual(["a", "b"]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("lets different keys run side by side", async () => {
    const lock = new KeyedLock();
    let inFlight = 0;
    let peak = 0;
    const task = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    };
    await Promise.all([lock.run("u1", task), lock.run("u2", task)]);
    expect(peak).toBe(2);
  });

  it("a failure reaches its own caller and does not block the next call", async () => {
    const lock = new KeyedLock();
    const failed = lock.run("u", async () => {
      throw new Error("boom");
    });
    const next = lock.run("u", async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("forgets a key once it is idle", async () => {
    const lock = new KeyedLock();
    await lock.run("u", async () => undefined);
    await tick(0);
    expect(lock.size).toBe(0);
  });
});
