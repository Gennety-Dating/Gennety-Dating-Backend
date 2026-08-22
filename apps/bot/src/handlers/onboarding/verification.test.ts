import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma before importing the handler.
vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));

import { prisma } from "@gennety/db";
import { MIN_PHOTOS, t } from "@gennety/shared";
import { VERIFY_PHOTOS_CALLBACK } from "../../services/verification-keyboard.js";
import { blockIfVerificationGated, sendVerificationGateNotice } from "./verification.js";

const findUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;

function makeApi(): { api: { sendMessage: ReturnType<typeof vi.fn> } } {
  return { api: { sendMessage: vi.fn().mockResolvedValue(undefined) } };
}

describe("sendVerificationGateNotice", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-offers the verification reminder for a pending user", async () => {
    findUnique.mockResolvedValue({ id: "u1", verificationStatus: "pending" });
    const { api } = makeApi();

    const handled = await sendVerificationGateNotice(
      api as never,
      123,
      111n,
      "ru",
    );

    expect(handled).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]![1]).toBe(t("ru", "verifyReminderNudge"));
  });

  it("re-offers the verification reminder for an unverified (never-started) user", async () => {
    findUnique.mockResolvedValue({ id: "u2", verificationStatus: "unverified" });
    const { api } = makeApi();

    const handled = await sendVerificationGateNotice(api as never, 123, 111n, "en");

    expect(handled).toBe(true);
    expect(api.sendMessage.mock.calls[0]![1]).toBe(t("en", "verifyReminderNudge"));
  });

  it("tells a pending_review user we're still checking (no re-verify nudge)", async () => {
    findUnique.mockResolvedValue({ id: "u3", verificationStatus: "pending_review" });
    const { api } = makeApi();

    const handled = await sendVerificationGateNotice(api as never, 123, 111n, "ru");

    expect(handled).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]![1]).toBe(
      t("ru", "verifyOutcomePendingReview"),
    );
  });

  it("gives a rejected user fix-and-retry guidance", async () => {
    findUnique.mockResolvedValue({ id: "u4", verificationStatus: "rejected" });
    const { api } = makeApi();

    const handled = await sendVerificationGateNotice(api as never, 123, 111n, "ru");

    expect(handled).toBe(true);
    expect(api.sendMessage.mock.calls[0]![1]).toBe(t("ru", "verifyOutcomeRejected"));
  });

  it("puts both recoveries on the rejected DM: verify again + upload other photos", async () => {
    findUnique.mockResolvedValue({ id: "u4", verificationStatus: "rejected" });
    const { api } = makeApi();

    await sendVerificationGateNotice(api as never, 123, 111n, "ru");

    const keyboard = api.sendMessage.mock.calls[0]![2]?.reply_markup;
    const buttons = keyboard.inline_keyboard.flat();
    expect(buttons.some((b: { web_app?: unknown }) => Boolean(b.web_app))).toBe(true);
    expect(
      buttons.some(
        (b: { callback_data?: string }) => b.callback_data === VERIFY_PHOTOS_CALLBACK,
      ),
    ).toBe(true);
  });

  it("prefixes the locked notice only when the card answers a blocked tap", async () => {
    findUnique.mockResolvedValue({ id: "u6", verificationStatus: "pending" });
    const { api } = makeApi();

    await sendVerificationGateNotice(api as never, 123, 111n, "ru", { locked: true });

    expect(api.sendMessage.mock.calls[0]![1]).toBe(
      `${t("ru", "verifyGateLocked")}\n\n${t("ru", "verifyReminderNudge")}`,
    );
  });
});

describe("blockIfVerificationGated", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeCtx(): {
    ctx: never;
    sendMessage: ReturnType<typeof vi.fn>;
  } {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    return {
      sendMessage,
      ctx: {
        from: { id: 111 },
        chat: { id: 123 },
        api: { sendMessage },
        session: { language: "ru" },
      } as never,
    };
  }

  it("blocks and shows the gate card while verification is outstanding", async () => {
    findUnique.mockResolvedValue({
      id: "u1",
      status: "onboarding",
      onboardingStep: "completed",
      verificationStatus: "pending",
    });
    const { ctx, sendMessage } = makeCtx();

    expect(await blockIfVerificationGated(ctx)).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toContain(t("ru", "verifyGateLocked"));
  });

  it("lets an activated user through untouched", async () => {
    findUnique.mockResolvedValue({
      id: "u2",
      status: "active",
      onboardingStep: "completed",
      verificationStatus: "verified",
    });
    const { ctx, sendMessage } = makeCtx();

    expect(await blockIfVerificationGated(ctx)).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not fire (falls back to the normal greeting) for a verified user", async () => {
    findUnique.mockResolvedValue({
      id: "u5",
      verificationStatus: "verified",
      // At the floor, so nothing is owed — sized off MIN_PHOTOS so the case
      // stays "verified and complete" when the floor moves.
      profile: { photos: Array.from({ length: MIN_PHOTOS }, (_, i) => `p${i}`) },
    });
    const { api } = makeApi();

    const handled = await sendVerificationGateNotice(api as never, 123, 111n, "ru");

    expect(handled).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("asks a verified user for more photos when the drop left them under the floor", async () => {
    // The one real way to be verified AND still gated: the pipeline removed
    // photos that didn't match the selfie and the profile fell under
    // MIN_PHOTOS, so activation was withheld. The success greeting would tell
    // them they are live when matching cannot see them.
    findUnique.mockResolvedValue({
      id: "u6",
      verificationStatus: "verified",
      profile: { photos: ["a"] },
    });
    const { api } = makeApi();

    const handled = await sendVerificationGateNotice(api as never, 123, 111n, "ru");

    expect(handled).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [, text, extra] = (api.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(String(text)).toContain(String(MIN_PHOTOS - 1));
    // The photo manager, not a pointless second liveness check.
    expect(JSON.stringify(extra)).toContain("verify:photos");
  });

  it("does nothing when the user row is missing", async () => {
    findUnique.mockResolvedValue(null);
    const { api } = makeApi();

    const handled = await sendVerificationGateNotice(api as never, 123, 111n, "ru");

    expect(handled).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
