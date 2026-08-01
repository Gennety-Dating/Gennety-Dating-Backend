import { describe, it, expect, afterEach } from "vitest";

import { dispatchToChat } from "./chat-queue.js";

/**
 * The queue hands the caller a promise (`run`) AND attaches its own cleanup
 * hook to it. Those are two different promises: `run.finally(...)` derives a
 * new one that rejects whenever `run` does. The caller only ever awaits `run`,
 * so before this was fixed the derived promise had no handler and every task
 * that threw raised a spurious `unhandledRejection` — on top of the real error
 * the caller had already caught and handled.
 *
 * That mattered for two reasons. `index.ts` installs a deliberately non-fatal
 * `unhandledRejection` listener, so nothing crashed and the bug stayed
 * invisible; but "zero unhandled rejections" is a documented post-deploy health
 * signal (deploy.md), and it cannot mean anything while ordinary handler errors
 * manufacture them. And the day that listener is removed — or Node's default
 * `--unhandled-rejections=throw` is relied on — every handler error becomes a
 * process exit.
 *
 * These tests assert the queue's real contract: the task's rejection reaches
 * the caller, and reaches nobody else.
 */

function collectUnhandledRejections(): {
  seen: unknown[];
  stop: () => void;
} {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    seen,
    stop: () => process.off("unhandledRejection", onUnhandled),
  };
}

/** Let the microtask queue drain and the unhandled-rejection check fire. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

describe("chat-queue", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("raises no unhandled rejection when a queued task throws", async () => {
    const probe = collectUnhandledRejections();
    cleanups.push(probe.stop);

    await expect(
      dispatchToChat("chat-throws", async () => {
        throw new Error("handler blew up");
      }),
    ).rejects.toThrow("handler blew up");

    await settle();
    expect(probe.seen).toEqual([]);
  });

  it("raises no unhandled rejection for several consecutive failures on one chat", async () => {
    const probe = collectUnhandledRejections();
    cleanups.push(probe.stop);

    for (let i = 0; i < 3; i++) {
      await expect(
        dispatchToChat("chat-throws-repeatedly", async () => {
          throw new Error(`boom ${i}`);
        }),
      ).rejects.toThrow(`boom ${i}`);
    }

    await settle();
    expect(probe.seen).toEqual([]);
  });

  it("a failed task does not poison the next task on the same chat", async () => {
    await expect(
      dispatchToChat("chat-recovers", async () => {
        throw new Error("first fails");
      }),
    ).rejects.toThrow("first fails");

    await expect(
      dispatchToChat("chat-recovers", async () => "second succeeds"),
    ).resolves.toBe("second succeeds");
  });

  it("serializes tasks for the same chat", async () => {
    const order: string[] = [];
    const first = dispatchToChat("chat-serial", async () => {
      order.push("first:start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("first:end");
    });
    const second = dispatchToChat("chat-serial", async () => {
      order.push("second:start");
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("runs different chats independently", async () => {
    const [a, b] = await Promise.all([
      dispatchToChat("chat-a", async () => "a"),
      dispatchToChat("chat-b", async () => "b"),
    ]);
    expect([a, b]).toEqual(["a", "b"]);
  });
});
