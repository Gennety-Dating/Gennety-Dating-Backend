import { describe, it, expect, afterEach, vi } from "vitest";
import { BotError } from "grammy";

import { createChatQueue, dispatchToChat } from "./chat-queue.js";
import type { BotContext } from "./session.js";

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

/**
 * A13-H9: the middleware used to AWAIT the chat's chain inside grammY's polling
 * loop, which itself awaits every update before fetching the next one. One slow
 * agent turn in one chat therefore held every other chat — and a
 * `pre_checkout_query` stuck behind it missed Telegram's 10-second window.
 *
 * These drive the middleware exactly the way grammY's loop does: call it, await
 * what it returns, move on to the next update.
 */

interface FakeUpdate {
  chatId?: number;
  payment?: boolean;
  updateId?: number;
}

function fakeCtx({ chatId, payment, updateId = 1 }: FakeUpdate): BotContext {
  return {
    chat: chatId === undefined ? undefined : { id: chatId, type: "private" },
    from: chatId === undefined ? undefined : { id: chatId },
    message: payment
      ? { successful_payment: { total_amount: 1, invoice_payload: "x" } }
      : { text: "hi" },
    update: { update_id: updateId },
  } as unknown as BotContext;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("sequentializeByChat (detached from the polling loop)", () => {
  it("does not make another chat wait for a slow one", async () => {
    const queue = createChatQueue({ maxConcurrent: 4 });
    const mw = queue.sequentializeByChat({ onDetachedError: vi.fn() });
    const slow = deferred();
    const fastRan = vi.fn();

    // The loop awaits each middleware call in turn. On the old code the first
    // await only returned once `slow` resolved, so this test hung.
    await mw(fakeCtx({ chatId: 1 }), () => slow.promise);
    await mw(fakeCtx({ chatId: 2 }), async () => {
      fastRan();
    });

    await vi.waitFor(() => expect(fastRan).toHaveBeenCalledTimes(1));
    expect(queue.pendingTasks()).toBe(1); // only the slow chat is still working
    slow.resolve();
    await expect(queue.waitForIdle(1000)).resolves.toBe(true);
  });

  it("keeps one chat's updates in arrival order even though nobody awaits them", async () => {
    const queue = createChatQueue({ maxConcurrent: 4 });
    const mw = queue.sequentializeByChat({ onDetachedError: vi.fn() });
    const order: string[] = [];

    await mw(fakeCtx({ chatId: 7 }), async () => {
      order.push("first:start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("first:end");
    });
    await mw(fakeCtx({ chatId: 7 }), async () => {
      order.push("second");
    });

    await queue.waitForIdle(1000);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("still awaits a successful_payment through its chat's queue", async () => {
    const queue = createChatQueue({ maxConcurrent: 4 });
    const mw = queue.sequentializeByChat({ onDetachedError: vi.fn() });
    const earlier = deferred();
    const settle = deferred();
    const events: string[] = [];

    // An ordinary update for the same chat is already running…
    await mw(fakeCtx({ chatId: 9 }), () => earlier.promise);
    // …so the payment waits behind it, and the loop waits for the payment.
    // `MiddlewareFn` is typed to return `unknown`; this one returns a promise.
    const paymentUpdate = Promise.resolve(
      mw(fakeCtx({ chatId: 9, payment: true }), async () => {
        events.push("settle:start");
        await settle.promise;
        events.push("settle:end");
      }),
    );
    void paymentUpdate.then(() => events.push("loop:resumed"));

    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([]);
    earlier.resolve();
    await vi.waitFor(() => expect(events).toEqual(["settle:start"]));
    settle.resolve();
    await paymentUpdate;
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(["settle:start", "settle:end", "loop:resumed"]);
  });

  it("runs a chat-less update inline, as before", async () => {
    const queue = createChatQueue({ maxConcurrent: 4 });
    const mw = queue.sequentializeByChat({ onDetachedError: vi.fn() });
    const answered = deferred();
    let done = false;

    const update = mw(fakeCtx({}), async () => {
      await answered.promise;
      done = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    answered.resolve();
    await update;
    expect(done).toBe(true);
    expect(queue.pendingTasks()).toBe(0);
  });

  it("never runs more chats at once than the ceiling, and queued work still starts", async () => {
    const queue = createChatQueue({ maxConcurrent: 2 });
    const mw = queue.sequentializeByChat({ onDetachedError: vi.fn() });
    let running = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];

    for (let i = 0; i < gates.length; i += 1) {
      await mw(fakeCtx({ chatId: 100 + i }), async () => {
        running += 1;
        peak = Math.max(peak, running);
        started.push(i);
        await gates[i]!.promise;
        running -= 1;
      });
    }

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    expect(queue.pendingTasks()).toBe(5);
    for (const gate of gates) gate.resolve();
    await expect(queue.waitForIdle(1000)).resolves.toBe(true);
    expect(peak).toBe(2);
    // FIFO hand-off: the chats that waited start in the order they arrived.
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it("hands a detached update's error to the bot error handler as a BotError", async () => {
    const queue = createChatQueue({ maxConcurrent: 4 });
    const onDetachedError = vi.fn();
    const mw = queue.sequentializeByChat({ onDetachedError });
    const probe = collectUnhandledRejections();
    const ctx = fakeCtx({ chatId: 11, updateId: 4242 });

    await mw(ctx, async () => {
      throw new Error("agent turn blew up");
    });
    await queue.waitForIdle(1000);
    await settle();
    probe.stop();

    expect(onDetachedError).toHaveBeenCalledTimes(1);
    const botError = onDetachedError.mock.calls[0]![0] as BotError<BotContext>;
    expect(botError).toBeInstanceOf(BotError);
    expect((botError.error as Error).message).toBe("agent turn blew up");
    expect(botError.ctx).toBe(ctx);
    expect(probe.seen).toEqual([]);
  });

  it("detachOnChat runs after the update holding the chat, and routes its error too", async () => {
    const queue = createChatQueue({ maxConcurrent: 4 });
    const onError = vi.fn();
    const order: string[] = [];
    const ctx = fakeCtx({ chatId: 12 });

    await queue.dispatchToChat(12, async () => {
      queue.detachOnChat(
        ctx,
        async () => {
          order.push("detached");
          throw new Error("late failure");
        },
        onError,
      );
      order.push("update:end");
    });
    await queue.waitForIdle(1000);
    await settle();

    expect(order).toEqual(["update:end", "detached"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as BotError<BotContext>).ctx).toBe(ctx);
  });

  it("stops starting updates once intake is closed, and reports drain timeouts", async () => {
    const queue = createChatQueue({ maxConcurrent: 4 });
    const mw = queue.sequentializeByChat({ onDetachedError: vi.fn() });
    const stuck = deferred();
    const late = vi.fn();

    await mw(fakeCtx({ chatId: 13 }), () => stuck.promise);
    queue.closeUpdateIntake();
    await mw(fakeCtx({ chatId: 14 }), async () => {
      late();
    });

    await expect(queue.waitForIdle(20)).resolves.toBe(false);
    stuck.resolve();
    await expect(queue.waitForIdle(1000)).resolves.toBe(true);
    expect(late).not.toHaveBeenCalled();
  });
});
