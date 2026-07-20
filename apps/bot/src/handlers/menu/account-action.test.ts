import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SESSION } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import {
  ACCOUNT_ACTION_TTL_MS,
  consumePendingAccountAction,
  invalidatePendingAccountAction,
  newAccountActionNonce,
  setPendingAccountAction,
} from "./account-action.js";

function context(data = "", messageId = 42): BotContext {
  return {
    session: { ...DEFAULT_SESSION },
    chat: { id: 100 },
    callbackQuery: { data, message: { message_id: messageId } },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    api: { editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined) },
  } as unknown as BotContext;
}

describe("one-time account action confirmations", () => {
  it("creates compact random nonces", () => {
    const a = newAccountActionNonce();
    const b = newAccountActionNonce();
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(20);
  });

  it("consumes a matching token exactly once", async () => {
    const ctx = context("menu:settings:freeze:token");
    setPendingAccountAction(ctx, "freeze_or_delete", "token", 42, 1_000);
    expect(ctx.session.pendingAccountAction?.expiresAtMs).toBe(1_000 + ACCOUNT_ACTION_TTL_MS);

    await expect(
      consumePendingAccountAction(
        ctx,
        "freeze_or_delete",
        "menu:settings:freeze:",
        2_000,
      ),
    ).resolves.toBe(true);
    expect(ctx.session.pendingAccountAction).toBeNull();

    await expect(
      consumePendingAccountAction(
        ctx,
        "freeze_or_delete",
        "menu:settings:freeze:",
        2_000,
      ),
    ).resolves.toBe(false);
  });

  it.each([
    ["wrong nonce", "menu:settings:freeze:wrong", 42, "freeze_or_delete"],
    ["wrong message", "menu:settings:freeze:token", 99, "freeze_or_delete"],
    ["wrong stage", "menu:settings:freeze:token", 42, "delete_final"],
  ] as const)("rejects %s", async (_label, data, messageId, stage) => {
    const ctx = context(data, messageId);
    setPendingAccountAction(ctx, stage, "token", 42, 1_000);
    await expect(
      consumePendingAccountAction(
        ctx,
        "freeze_or_delete",
        "menu:settings:freeze:",
        2_000,
      ),
    ).resolves.toBe(false);
  });

  it("rejects and clears an expired token", async () => {
    const ctx = context("menu:settings:freeze:token");
    setPendingAccountAction(ctx, "freeze_or_delete", "token", 42, 1_000);
    await expect(
      consumePendingAccountAction(
        ctx,
        "freeze_or_delete",
        "menu:settings:freeze:",
        1_000 + ACCOUNT_ACTION_TTL_MS,
      ),
    ).resolves.toBe(false);
    expect(ctx.session.pendingAccountAction).toBeNull();
  });

  it("invalidates the stored keyboard on navigation", async () => {
    const ctx = context();
    setPendingAccountAction(ctx, "delete_final", "token", 42);
    await invalidatePendingAccountAction(ctx);
    expect(ctx.session.pendingAccountAction).toBeNull();
    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledWith(100, 42);
  });
});
