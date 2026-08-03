import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION, type SessionData } from "@gennety/shared";

/**
 * The date router's free-text gate.
 *
 * `awaiting_emergency_reason` is the one text state in the product that
 * DESTROYS something — it cancels a `scheduled` date and quotes the message
 * verbatim to the partner, irreversibly. It used to be claimed indefinitely, so
 * a user who confirmed "yes, cancel" and then simply left had their next
 * unrelated message cancel the date for them. These tests pin the bound.
 */

const handleEmergencyReason = vi.fn().mockResolvedValue(undefined);
const handleFeedbackVoiceText = vi.fn().mockResolvedValue(undefined);

vi.mock("./emergency.js", () => ({
  handleEmergencyStart: vi.fn(),
  handleEmergencyConfirm: vi.fn(),
  handleEmergencyAbort: vi.fn(),
  handleEmergencyReason: (...args: unknown[]) => handleEmergencyReason(...args),
}));

vi.mock("./feedback.js", () => ({
  handleFeedbackVoiceStart: vi.fn(),
  handleFeedbackVoiceText: (...args: unknown[]) => handleFeedbackVoiceText(...args),
}));

vi.mock("./coordination.js", () => ({
  handleCoordMethod: vi.fn(),
  handleCoordConsent: vi.fn(),
  handleCoordEnter: vi.fn(),
  handleCoordExit: vi.fn(),
  handleProxyRelay: vi.fn(),
}));

vi.mock("./date-card.js", () => ({ handleDateCardShare: vi.fn() }));

const { dateRouter } = await import("./router.js");

interface TestCtx {
  session: SessionData;
}

function ctxWith(session: Partial<SessionData>, text: string): TestCtx {
  return {
    session: { ...DEFAULT_SESSION, onboardingStep: "completed", ...session },
    from: { id: 1001 },
    chat: { id: 1001 },
    message: { text },
    callbackQuery: undefined,
  } as TestCtx;
}

async function run(ctx: TestCtx): Promise<{ fellThrough: boolean }> {
  let fellThrough = false;
  await dateRouter.middleware()(ctx as never, async () => {
    fellThrough = true;
  });
  return { fellThrough };
}

beforeEach(() => {
  handleEmergencyReason.mockClear();
  handleFeedbackVoiceText.mockClear();
});

describe("emergency reason claim", () => {
  it("consumes the reason while the claim is live", async () => {
    const ctx = ctxWith(
      {
        matchFlow: "awaiting_emergency_reason",
        matchFlowClaimUntil: Date.now() + 60_000,
        activeMatchId: "m1",
      },
      "sorry, I'm ill",
    );

    const { fellThrough } = await run(ctx);

    expect(handleEmergencyReason).toHaveBeenCalledOnce();
    expect(fellThrough).toBe(false);
  });

  it("does NOT cancel the date on a message sent after the window closed", async () => {
    const ctx = ctxWith(
      {
        matchFlow: "awaiting_emergency_reason",
        matchFlowClaimUntil: Date.now() - 1,
        activeMatchId: "m1",
      },
      "when is my date?",
    );

    const { fellThrough } = await run(ctx);

    expect(handleEmergencyReason).not.toHaveBeenCalled();
    // Released, and handed to the concierge agent — which can see the live match
    // and offer the real cancel card if that is genuinely what they meant.
    expect(ctx.session.matchFlow).toBe("idle");
    expect(ctx.session.activeMatchId).toBeNull();
    expect(fellThrough).toBe(true);
  });

  it("does NOT cancel the date for a session written before the deadline existed", async () => {
    // Old `bot_sessions` rows read `matchFlowClaimUntil: null` after the storage
    // adapter merges defaults. Failing closed is the whole point.
    const ctx = ctxWith(
      {
        matchFlow: "awaiting_emergency_reason",
        matchFlowClaimUntil: null,
        activeMatchId: "m1",
      },
      "hey",
    );

    const { fellThrough } = await run(ctx);

    expect(handleEmergencyReason).not.toHaveBeenCalled();
    expect(fellThrough).toBe(true);
  });
});

describe("feedback claim", () => {
  it("records feedback while the claim is live", async () => {
    const ctx = ctxWith(
      {
        matchFlow: "awaiting_feedback",
        matchFlowClaimUntil: Date.now() + 60_000,
        activeMatchId: "m1",
      },
      "it went well",
    );

    await run(ctx);
    expect(handleFeedbackVoiceText).toHaveBeenCalledOnce();
  });

  it("falls through once the window closed", async () => {
    const ctx = ctxWith(
      {
        matchFlow: "awaiting_feedback",
        matchFlowClaimUntil: Date.now() - 1,
        activeMatchId: "m1",
      },
      "how many tickets do I have?",
    );

    const { fellThrough } = await run(ctx);

    expect(handleFeedbackVoiceText).not.toHaveBeenCalled();
    expect(fellThrough).toBe(true);
  });
});
