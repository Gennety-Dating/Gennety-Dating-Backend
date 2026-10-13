import { describe, it, expect } from "vitest";
import { createConcurrencyGate } from "./db-gate.js";

/** A task whose completion the test controls, recording when it started. */
function deferredTask<T>(value: T, log: string[], name: string) {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    run: async (): Promise<T> => {
      log.push(`start ${name}`);
      await done;
      return value;
    },
    finish: (): void => resolve(),
    fail: (err: Error): void => reject(err),
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("createConcurrencyGate", () => {
  it("never has more than `capacity` tasks running, and starts the rest in arrival order", async () => {
    const gate = createConcurrencyGate(3);
    const log: string[] = [];
    const tasks = ["a", "b", "c", "d", "e"].map((name) => deferredTask(name, log, name));
    const results = Promise.all(tasks.map((t) => gate.run(t.run)));

    await flush();
    expect(log).toEqual(["start a", "start b", "start c"]);
    expect(gate.inUse).toBe(3);
    expect(gate.waiting).toBe(2);

    tasks[1]!.finish();
    await flush();
    expect(log).toEqual(["start a", "start b", "start c", "start d"]);

    for (const t of tasks) t.finish();
    expect(await results).toEqual(["a", "b", "c", "d", "e"]);
    expect(gate.inUse).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it("starts a task synchronously when a slot is free — no added delay for the first ones", () => {
    const gate = createConcurrencyGate(2);
    const log: string[] = [];
    void gate.run(async () => {
      log.push("ran");
    });
    expect(log).toEqual(["ran"]);
  });

  it("passes a rejection through and frees the slot", async () => {
    const gate = createConcurrencyGate(1);
    const log: string[] = [];
    const failing = deferredTask("x", log, "failing");
    const next = deferredTask("next", log, "next");

    const first = gate.run(failing.run);
    const second = gate.run(next.run);
    await flush();
    expect(log).toEqual(["start failing"]);

    failing.fail(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    await flush();
    expect(log).toEqual(["start failing", "start next"]);

    next.finish();
    expect(await second).toBe("next");
  });

  it("an exclusive task waits for every slot, runs alone, and is not overtaken", async () => {
    const gate = createConcurrencyGate(3);
    const log: string[] = [];
    const a = deferredTask("a", log, "a");
    const heavy = deferredTask("heavy", log, "heavy");
    const b = deferredTask("b", log, "b");

    const pa = gate.run(a.run);
    const pHeavy = gate.run(heavy.run, 3);
    const pb = gate.run(b.run);
    await flush();
    // Two slots are free, but the heavy task is first in line and needs three;
    // `b` must not jump the queue past it.
    expect(log).toEqual(["start a"]);

    a.finish();
    await flush();
    expect(log).toEqual(["start a", "start heavy"]);
    expect(gate.inUse).toBe(3);

    heavy.finish();
    await flush();
    expect(log).toEqual(["start a", "start heavy", "start b"]);

    b.finish();
    expect(await Promise.all([pa, pHeavy, pb])).toEqual(["a", "heavy", "b"]);
  });

  it("clamps a weight above capacity instead of waiting forever", async () => {
    const gate = createConcurrencyGate(2);
    expect(await gate.run(async () => "ok", 99)).toBe("ok");
  });

  it("runs a nested call inline instead of deadlocking on its own slots", async () => {
    const gate = createConcurrencyGate(1);
    const outer = gate.run(async () => {
      const inner = await gate.run(async () => "inner");
      return `outer+${inner}`;
    });
    expect(await outer).toBe("outer+inner");
    expect(gate.inUse).toBe(0);
  });

  it("does not treat a separate caller as nested", async () => {
    const gate = createConcurrencyGate(1);
    const log: string[] = [];
    const held = deferredTask("held", log, "held");
    const first = gate.run(held.run);
    // Started from the test, not from inside `held` — it must wait its turn.
    const second = gate.run(async () => {
      log.push("start second");
      return "second";
    });
    await flush();
    expect(log).toEqual(["start held"]);
    held.finish();
    expect(await Promise.all([first, second])).toEqual(["held", "second"]);
    expect(log).toEqual(["start held", "start second"]);
  });
});
