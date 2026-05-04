import { describe, it, expect, vi, beforeEach } from "vitest";

import { sendExpiryNotifications } from "./expiry-notify.js";
import type { MatchExpiry, SideClassification } from "./match-expiry.js";

interface FakeApi {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
}

function makeApi(): FakeApi {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue({ message_id: 1 }),
  };
}

function side(overrides: Partial<SideClassification>): SideClassification {
  return {
    side: "A",
    userId: "user-a",
    telegramId: 100n,
    language: "en",
    pitchMessageId: 11,
    role: "silent",
    offenseCount: 1,
    penalised: false,
    peerAccepted: null,
    ...overrides,
  };
}

function matchWith(...sides: SideClassification[]): MatchExpiry {
  return { matchId: "m-1", sides };
}

describe("sendExpiryNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("first-offense silent → warning text + clears keyboard", async () => {
    const api = makeApi();
    const m = matchWith(
      side({ side: "A", role: "silent", offenseCount: 1, penalised: false }),
      side({
        side: "B",
        userId: "user-b",
        telegramId: 200n,
        language: "ru",
        pitchMessageId: 22,
        role: "responder",
      }),
    );

    const r = await sendExpiryNotifications(api as never, [m], 0);

    expect(r.notified).toBe(2);
    expect(r.failed).toBe(0);

    // Keyboard cleared on both sides.
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    const editCalls = api.editMessageText.mock.calls.map((c) => c[3]);
    for (const opts of editCalls) {
      expect(opts.reply_markup).toEqual({ inline_keyboard: [] });
    }

    // Silent (A) gets the WARNING, not the penalty text.
    const sentToA = api.sendMessage.mock.calls.find((c) => c[0] === 100)![1];
    expect(sentToA).toMatch(/Next time we'll lower your rating/i);

    // Responder (B) gets the peer-ignored text.
    const sentToB = api.sendMessage.mock.calls.find((c) => c[0] === 200)![1];
    expect(sentToB).toMatch(/не ответил в течение суток/i);
  });

  it("repeat-offense silent → penalty text", async () => {
    const api = makeApi();
    const m = matchWith(
      side({ role: "silent", offenseCount: 3, penalised: true }),
    );

    await sendExpiryNotifications(api as never, [m], 0);

    const sent = api.sendMessage.mock.calls[0]![1];
    expect(sent).toMatch(/Your rating has been lowered/i);
  });

  it("silent + peer ACCEPTED → prepends 'you missed a date' on top of warning", async () => {
    // Product rule: when the silent user ghosted a partner who'd actually
    // agreed to meet, surface that explicitly. Other silent cases stay
    // neutral so the blind-decision rule isn't broken.
    const api = makeApi();
    const m = matchWith(
      side({ role: "silent", offenseCount: 1, penalised: false, peerAccepted: true }),
    );

    await sendExpiryNotifications(api as never, [m], 0);

    const sent = api.sendMessage.mock.calls[0]![1];
    expect(sent).toMatch(/you missed a real date/i);
    // Rating warning still rides along — the prefix is additive.
    expect(sent).toMatch(/Next time we'll lower your rating/i);
  });

  it("silent + peer DECLINED → no 'missed a date' prefix (blind-decision)", async () => {
    // If the peer also bailed, we don't reveal that fact via the
    // "missed a date" framing — just ship the neutral warning.
    const api = makeApi();
    const m = matchWith(
      side({ role: "silent", offenseCount: 1, penalised: false, peerAccepted: false }),
    );

    await sendExpiryNotifications(api as never, [m], 0);

    const sent = api.sendMessage.mock.calls[0]![1];
    expect(sent).not.toMatch(/missed a real date/i);
    expect(sent).toMatch(/Next time we'll lower your rating/i);
  });

  it("falls back to warning text if penalised flag is false even at high offenseCount", async () => {
    // Defensive: a flaky Elo write should never make us claim "rating
    // lowered" when we didn't actually deduct anything.
    const api = makeApi();
    const m = matchWith(
      side({ role: "silent", offenseCount: 5, penalised: false }),
    );

    await sendExpiryNotifications(api as never, [m], 0);

    const sent = api.sendMessage.mock.calls[0]![1];
    expect(sent).toMatch(/Next time we'll lower your rating/i);
    expect(sent).not.toMatch(/has been lowered/i);
  });

  it("skips mobile-only sides (negative telegramId) and continues", async () => {
    const api = makeApi();
    const m = matchWith(
      side({ side: "A", telegramId: -42n, role: "silent" }),
      side({
        side: "B",
        userId: "user-b",
        telegramId: 200n,
        language: "en",
        pitchMessageId: 22,
        role: "responder",
      }),
    );

    const r = await sendExpiryNotifications(api as never, [m], 0);

    expect(r.notified).toBe(1);
    expect(r.skipped).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(200, expect.any(String));
  });

  it("does not edit pitch when pitchMessageId is null", async () => {
    const api = makeApi();
    const m = matchWith(side({ pitchMessageId: null }));

    await sendExpiryNotifications(api as never, [m], 0);

    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("counts a sendMessage failure without breaking the loop", async () => {
    const api = makeApi();
    api.sendMessage
      .mockRejectedValueOnce(new Error("403 blocked"))
      .mockResolvedValueOnce({ message_id: 1 });

    const m = matchWith(
      side({ side: "A" }),
      side({ side: "B", userId: "user-b", telegramId: 200n, role: "responder" }),
    );

    const r = await sendExpiryNotifications(api as never, [m], 0);

    expect(r.notified).toBe(1);
    expect(r.failed).toBe(1);
  });
});
