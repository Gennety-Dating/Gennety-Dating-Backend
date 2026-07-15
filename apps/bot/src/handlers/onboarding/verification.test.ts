import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma before importing the handler.
vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));

import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import { sendVerificationGateNotice } from "./verification.js";

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

  it("does not fire (falls back to the normal greeting) for a verified user", async () => {
    findUnique.mockResolvedValue({ id: "u5", verificationStatus: "verified" });
    const { api } = makeApi();

    const handled = await sendVerificationGateNotice(api as never, 123, 111n, "ru");

    expect(handled).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("does nothing when the user row is missing", async () => {
    findUnique.mockResolvedValue(null);
    const { api } = makeApi();

    const handled = await sendVerificationGateNotice(api as never, 123, 111n, "ru");

    expect(handled).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
