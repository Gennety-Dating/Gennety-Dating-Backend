import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SESSION } from "@gennety/shared";
import type { BotContext } from "../../session.js";

type PendingPremiumCancel = {
  nonce: string;
  stage: "offer" | "final";
  expiresAtMs: number;
  messageId: number;
};

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("../../services/premium.js", () => ({
  getPremiumCancelContext: vi.fn(),
  recordInChatCancellation: vi.fn(),
  attachCancellationReason: vi.fn(),
  formatPremiumUntil: () => "19 August 2026",
}));

import { prisma } from "@gennety/db";
import { getPremiumCancelContext, recordInChatCancellation } from "../../services/premium.js";
import {
  PREM_CANCEL_YES_PREFIX,
  PREM_CANCEL_KEEP_PREFIX,
  PREM_CANCEL_FINAL_YES_PREFIX,
  sendPremiumCancelConfirm,
  handlePremiumCancelConfirm,
  handlePremiumCancelFinalConfirm,
  handlePremiumCancelKeep,
} from "./premium-cancel.js";

const findUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;
const cancelContext = getPremiumCancelContext as unknown as ReturnType<typeof vi.fn>;
const recordCancellation = recordInChatCancellation as unknown as ReturnType<typeof vi.fn>;

function context(
  overrides: {
    data?: string;
    messageId?: number;
    pendingPremiumCancel?: PendingPremiumCancel | null;
    replyMessageId?: number;
  } = {},
): BotContext {
  const {
    data = "",
    messageId = 42,
    pendingPremiumCancel = null,
    replyMessageId = 200,
  } = overrides;
  return {
    session: { ...DEFAULT_SESSION, pendingPremiumCancel },
    chat: { id: 100 },
    from: { id: 555 },
    callbackQuery: { data, message: { message_id: messageId } },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ message_id: replyMessageId }),
    api: {
      editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
      editUserStarSubscription: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as BotContext;
}

const future = Date.now() + 5 * 60 * 1000;
const activeStars = {
  active: true,
  provider: "telegram_stars",
  premiumUntil: new Date("2026-08-19"),
  recurringAnchor: "anchor-1",
  autoRenew: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({ id: "user-1" });
});

describe("handlePremiumCancelConfirm (stage 1 -> 2 transition)", () => {
  it("does not cancel anything — it burns the offer token and sends a fresh final-stage card", async () => {
    const ctx = context({
      data: `${PREM_CANCEL_YES_PREFIX}abc`,
      messageId: 42,
      pendingPremiumCancel: { nonce: "abc", stage: "offer", messageId: 42, expiresAtMs: future },
    });
    cancelContext.mockResolvedValue(activeStars);

    await handlePremiumCancelConfirm(ctx);

    expect(ctx.api.editUserStarSubscription).not.toHaveBeenCalled();
    expect(recordCancellation).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledOnce();

    const pending = ctx.session.pendingPremiumCancel;
    expect(pending).not.toBeNull();
    expect(pending?.stage).toBe("final");
    expect(pending?.nonce).not.toBe("abc");
    expect(pending?.messageId).toBe(200);
  });

  it("rejects a final-stage token submitted against the offer-stage prefix (wrong stage)", async () => {
    const ctx = context({
      data: `${PREM_CANCEL_YES_PREFIX}xyz`,
      messageId: 42,
      pendingPremiumCancel: { nonce: "xyz", stage: "final", messageId: 42, expiresAtMs: future },
    });

    await handlePremiumCancelConfirm(ctx);

    expect(ctx.session.pendingPremiumCancel).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe("handlePremiumCancelFinalConfirm (stage 2 — the only tap that actually cancels)", () => {
  it("cancels at Telegram, records the ledger row, and starts the reason-capture sub-flow", async () => {
    const ctx = context({
      data: `${PREM_CANCEL_FINAL_YES_PREFIX}xyz`,
      messageId: 42,
      pendingPremiumCancel: { nonce: "xyz", stage: "final", messageId: 42, expiresAtMs: future },
    });
    cancelContext.mockResolvedValue(activeStars);
    recordCancellation.mockResolvedValue({
      ledgerId: "ledger-1",
      premiumUntil: new Date("2026-08-19"),
    });

    await handlePremiumCancelFinalConfirm(ctx);

    expect(ctx.api.editUserStarSubscription).toHaveBeenCalledWith(555, "anchor-1", true);
    expect(recordCancellation).toHaveBeenCalledWith("user-1", "telegram_stars");
    expect(ctx.editMessageText).toHaveBeenCalled();
    expect(ctx.session.menuState).toBe("awaiting_premium_cancel_reason");
    expect(ctx.session.premiumCancelLedgerId).toBe("ledger-1");
    expect(ctx.reply).toHaveBeenCalled();
    expect(ctx.session.pendingPremiumCancel).toBeNull();
  });

  it("rejects an offer-stage token submitted against the final-stage prefix (wrong stage)", async () => {
    const ctx = context({
      data: `${PREM_CANCEL_FINAL_YES_PREFIX}abc`,
      messageId: 42,
      pendingPremiumCancel: { nonce: "abc", stage: "offer", messageId: 42, expiresAtMs: future },
    });

    await handlePremiumCancelFinalConfirm(ctx);

    expect(ctx.session.pendingPremiumCancel).toBeNull();
    expect(ctx.api.editUserStarSubscription).not.toHaveBeenCalled();
    expect(recordCancellation).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
  });

  it("rejects an expired final-stage token", async () => {
    const ctx = context({
      data: `${PREM_CANCEL_FINAL_YES_PREFIX}xyz`,
      messageId: 42,
      pendingPremiumCancel: {
        nonce: "xyz",
        stage: "final",
        messageId: 42,
        expiresAtMs: Date.now() - 1000,
      },
    });

    await handlePremiumCancelFinalConfirm(ctx);

    expect(ctx.session.pendingPremiumCancel).toBeNull();
    expect(ctx.api.editUserStarSubscription).not.toHaveBeenCalled();
    expect(recordCancellation).not.toHaveBeenCalled();
  });
});

describe("handlePremiumCancelKeep (unchanged, offer stage only)", () => {
  it("aborts without cancelling anything", async () => {
    const ctx = context({
      data: `${PREM_CANCEL_KEEP_PREFIX}abc`,
      messageId: 42,
      pendingPremiumCancel: { nonce: "abc", stage: "offer", messageId: 42, expiresAtMs: future },
    });
    cancelContext.mockResolvedValue(activeStars);

    await handlePremiumCancelKeep(ctx);

    expect(ctx.editMessageText).toHaveBeenCalled();
    expect(ctx.session.pendingPremiumCancel).toBeNull();
    expect(ctx.api.editUserStarSubscription).not.toHaveBeenCalled();
  });
});

describe("sendPremiumCancelConfirm (stage 1 entry)", () => {
  it("invalidates a stale pending token (either stage) before issuing a fresh offer token", async () => {
    const ctx = context({
      pendingPremiumCancel: { nonce: "stale", stage: "final", messageId: 42, expiresAtMs: future },
    });
    cancelContext.mockResolvedValue(activeStars);

    await sendPremiumCancelConfirm(ctx);

    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledWith(100, 42);

    const pending = ctx.session.pendingPremiumCancel;
    expect(pending).not.toBeNull();
    expect(pending?.stage).toBe("offer");
    expect(pending?.nonce).not.toBe("stale");
    expect(pending?.messageId).toBe(200);
  });
});
