import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  env: { CUSTOM_EMOJI_THINKING_ID: "" },
}));

import { createOutcomeGate } from "./outcome-gate.js";
import { runStatusSequence, NEVER_CUT_SHORT } from "./ai-stream.js";

/**
 * The gate exists for ONE user-visible guarantee: a result message never lands
 * on screen underneath a status shimmer still claiming the work is running.
 * The tests below pin that ordering, plus the two ways either side is allowed
 * to give up without stranding the other.
 */

function settledSync(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    // A macrotask is enough: everything here resolves through the microtask
    // queue or a fake timer, never through real I/O.
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
  ]);
}

describe("createOutcomeGate", () => {
  it("holds the work until the narration releases", async () => {
    const gate = createOutcomeGate();
    const held = gate.hold();

    expect(await settledSync(held)).toBe(false);

    gate.release();
    await expect(held).resolves.toBeUndefined();
  });

  it("signals `settled` as soon as the work is ready to speak", async () => {
    const gate = createOutcomeGate();

    expect(await settledSync(gate.settled)).toBe(false);

    void gate.hold();
    // The narration can now stop holding its last beat and tear itself down —
    // which is what eventually calls release() and lets the message through.
    await expect(gate.settled).resolves.toBeUndefined();
  });

  it("signals `settled` when the work finishes with nothing to say", async () => {
    const gate = createOutcomeGate();

    // A rerun that merely re-confirms an already-verified user sends no DM.
    // Without finish() the shimmer would hold until the safety cap.
    gate.finish();

    await expect(gate.settled).resolves.toBeUndefined();
  });

  it("lets everything through once the safety cap elapses", async () => {
    vi.useFakeTimers();
    try {
      const gate = createOutcomeGate(1000);
      const held = gate.hold();

      vi.advanceTimersByTime(1000);

      // Both directions open: a narration that died before its teardown can
      // never swallow the verdict, and a hung run can never keep a shimmer
      // re-issuing itself forever.
      await expect(held).resolves.toBeUndefined();
      await expect(gate.settled).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent — a second release or finish changes nothing", async () => {
    const gate = createOutcomeGate();
    gate.release();
    gate.release();
    gate.finish();
    gate.finish();

    await expect(gate.hold()).resolves.toBeUndefined();
  });
});

describe("outcome gate + status sequence", () => {
  it("plays the whole script and only then lets the verdict through", async () => {
    const events: string[] = [];
    const api = {
      sendMessage: vi.fn(async (_chat: number, text: string) => {
        events.push(`status:${text}`);
        return { message_id: 7 };
      }),
      editMessageText: vi.fn(async (_c: number, _m: number, text: string) => {
        events.push(`status:${text}`);
        return {};
      }),
      deleteMessage: vi.fn(async () => {
        events.push("status:gone");
        return true;
      }),
    } as never;

    const gate = createOutcomeGate();
    const steps = [
      { text: "Checking your selfie", holdMs: 10 },
      { text: "Comparing faces", holdMs: 10 },
      { text: "Finishing up", holdMs: 10 },
    ];

    // The work: instant, the way a fast face-match run is. Before the gate this
    // is exactly the case that dropped the verdict on top of the shimmer.
    const work = (async () => {
      await gate.hold();
      events.push("verdict");
    })();

    const status = runStatusSequence(api, 5, steps, {
      wait: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      until: gate.settled,
      untilFromStepIndex: NEVER_CUT_SHORT,
    })
      .catch(() => undefined)
      .finally(() => gate.release());

    await Promise.all([status, work]);

    expect(events).toEqual([
      "status:Checking your selfie",
      "status:Comparing faces",
      "status:Finishing up",
      "status:gone",
      "verdict",
    ]);
  });

  it("holds the last beat when the work outlasts the script", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 7 }),
      editMessageText: vi.fn().mockResolvedValue({}),
      deleteMessage: vi.fn().mockResolvedValue(true),
    } as never;

    const gate = createOutcomeGate();
    const steps = [
      { text: "Step 1", holdMs: 0 },
      { text: "Step 2", holdMs: 0 },
    ];

    const status = runStatusSequence(api, 5, steps, {
      wait: async () => {},
      until: gate.settled,
      untilFromStepIndex: NEVER_CUT_SHORT,
    }).finally(() => gate.release());

    await new Promise((r) => setTimeout(r, 0));
    // Script exhausted, work still running: the status stays on screen instead
    // of leaving the user in silence.
    expect((api as unknown as { deleteMessage: ReturnType<typeof vi.fn> }).deleteMessage)
      .not.toHaveBeenCalled();

    void gate.hold();
    await status;
    expect(
      (api as unknown as { deleteMessage: ReturnType<typeof vi.fn> }).deleteMessage,
    ).toHaveBeenCalled();
  });
});
