import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_ATTEMPTS,
  POLL_INTERVAL_MS,
  isPolling,
  startPoll,
  stopPoll,
  type PollerDeps,
} from "./verification-poller.js";
import type { PullVerificationOutcome } from "./verification-pipeline.js";

const USER_ID = "user-1";
const TG_ID = 100n;

interface FakeApi {
  sendMessage: ReturnType<typeof vi.fn>;
}

function makeApi(): FakeApi {
  return { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };
}

function depsWith(pull: PollerDeps["pull"]): PollerDeps {
  // Resolve setInterval/clearInterval lazily so vi.useFakeTimers (set up in
  // beforeEach, before this is evaluated) is the version that gets called.
  return {
    pull,
    setIntervalFn: (fn, ms) => setInterval(fn, ms),
    clearIntervalFn: (id) => clearInterval(id),
  };
}

function pullSequence(
  ...outcomes: PullVerificationOutcome[]
): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => outcomes[Math.min(i++, outcomes.length - 1)]!);
}

const PIPELINE_RAN_VERIFIED: PullVerificationOutcome = {
  kind: "pipeline_ran",
  pipelineOutcome: {
    kind: "verified",
    userId: USER_ID,
    score: 0.92,
    scores: [0.92],
  },
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Clean up Map state across tests; the poller stores polls module-globally.
  stopPoll(USER_ID);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("verification-poller", () => {
  it("stops on pipeline_ran without sending a poller DM", async () => {
    const api = makeApi();
    const pull = pullSequence(PIPELINE_RAN_VERIFIED);

    startPoll(USER_ID, TG_ID, "en", api as never, depsWith(pull));
    expect(isPolling(USER_ID)).toBe(true);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(pull).toHaveBeenCalledTimes(1);
    // Pipeline already DM'd the user; poller stays silent.
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(isPolling(USER_ID)).toBe(false);
  });

  it("continues on still_pending until pipeline_ran lands", async () => {
    const api = makeApi();
    const pull = pullSequence(
      { kind: "still_pending", personaStatus: "completed" },
      { kind: "still_pending", personaStatus: "completed" },
      PIPELINE_RAN_VERIFIED,
    );

    startPoll(USER_ID, TG_ID, "en", api as never, depsWith(pull));

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(pull).toHaveBeenCalledTimes(3);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(isPolling(USER_ID)).toBe(false);
  });

  it("times out after MAX_ATTEMPTS still_pending and DMs with a safety-net button", async () => {
    const api = makeApi();
    const pull = pullSequence({ kind: "still_pending", personaStatus: "pending" });

    startPoll(USER_ID, TG_ID, "en", api as never, depsWith(pull));

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * MAX_ATTEMPTS);

    expect(pull).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, options] = api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(Number(TG_ID));
    expect(text).toMatch(/longer than usual/i);
    // Safety-net keyboard exposing the existing manual "I'm done" callback.
    const keyboard = options.reply_markup.inline_keyboard;
    expect(Array.isArray(keyboard)).toBe(true);
    expect(keyboard[0]?.[0]?.callback_data).toBe("verify:check");
    expect(isPolling(USER_ID)).toBe(false);
  });

  it("DMs persona_failed and stops on Persona-side failure", async () => {
    const api = makeApi();
    const pull = pullSequence({ kind: "persona_failed", personaStatus: "declined" });

    startPoll(USER_ID, TG_ID, "en", api as never, depsWith(pull));

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [, text, options] = api.sendMessage.mock.calls[0]!;
    expect(text).toMatch(/didn't pass/i);
    // No safety-net button on persona_failed — user must restart Persona.
    expect(options).toBeUndefined();
    expect(isPolling(USER_ID)).toBe(false);
  });

  it("DMs infra_error and stops on transient backend failure", async () => {
    const api = makeApi();
    const pull = pullSequence({ kind: "infra_error", reason: "api" });

    startPoll(USER_ID, TG_ID, "en", api as never, depsWith(pull));

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]![1]).toMatch(/verification service/i);
    expect(isPolling(USER_ID)).toBe(false);
  });

  it("double registration replaces the existing interval (single in-flight poll)", async () => {
    const api = makeApi();
    const pullA = pullSequence({ kind: "still_pending", personaStatus: "pending" });
    const pullB = pullSequence(PIPELINE_RAN_VERIFIED);

    startPoll(USER_ID, TG_ID, "en", api as never, depsWith(pullA));
    expect(isPolling(USER_ID)).toBe(true);

    // Re-register before any tick fires — first interval must be cancelled.
    startPoll(USER_ID, TG_ID, "en", api as never, depsWith(pullB));
    expect(isPolling(USER_ID)).toBe(true);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(pullA).not.toHaveBeenCalled();
    expect(pullB).toHaveBeenCalledTimes(1);
    expect(isPolling(USER_ID)).toBe(false);
  });

  it("stopPoll cancels an in-flight interval", async () => {
    const api = makeApi();
    const pull = pullSequence({ kind: "still_pending", personaStatus: "pending" });

    startPoll(USER_ID, TG_ID, "en", api as never, depsWith(pull));
    stopPoll(USER_ID);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);

    expect(pull).not.toHaveBeenCalled();
    expect(isPolling(USER_ID)).toBe(false);
  });
});
