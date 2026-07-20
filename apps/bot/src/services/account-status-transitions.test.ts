import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStatus } from "@gennety/db";

const userFindUnique = vi.fn();
const userUpdateMany = vi.fn();
const transaction = vi.fn();

vi.mock("@gennety/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gennety/db")>();
  return {
    ...actual,
    prisma: {
      user: {
        findUnique: userFindUnique,
        updateMany: userUpdateMany,
      },
      $transaction: transaction,
    },
  };
});

const claimInFlightMatchCancellations = vi.fn();
const deliverCancelledPartnerEffects = vi.fn();
vi.mock("./cancel-in-flight-matches.js", () => ({
  claimInFlightMatchCancellations,
  deliverCancelledPartnerEffects,
}));

const notifyFounderAccountClosed = vi.fn(async () => {});
vi.mock("./founder-notify.js", () => ({ notifyFounderAccountClosed }));

const unpinStatusBanner = vi.fn(async () => {});
vi.mock("./status-banner.js", () => ({ unpinStatusBanner }));

const { freezeAccount, transitionAccountStatus } = await import(
  "./account-status-transitions.js"
);

const ALL_STATUSES: UserStatus[] = [
  "onboarding",
  "active",
  "paused",
  "frozen",
  "suspended",
  "pending_investigation",
  "banned",
];

const BASE_USER = {
  id: "user-1",
  telegramId: 123n,
  status: "active" as UserStatus,
};

beforeEach(() => {
  vi.clearAllMocks();
  userUpdateMany.mockResolvedValue({ count: 1 });
  transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ user: { findUnique: userFindUnique, updateMany: userUpdateMany } }),
  );
  claimInFlightMatchCancellations.mockResolvedValue([]);
  deliverCancelledPartnerEffects.mockResolvedValue(undefined);
});

describe("transitionAccountStatus", () => {
  const cases = [
    { action: "pause" as const, from: "active", to: "paused" },
    { action: "resume" as const, from: "paused", to: "active" },
    { action: "return_from_freeze" as const, from: "frozen", to: "active" },
  ];

  for (const testCase of cases) {
    it(`${testCase.action} changes only ${testCase.from} to ${testCase.to}`, async () => {
      for (const status of ALL_STATUSES) {
        userFindUnique.mockReset().mockResolvedValue({ ...BASE_USER, status });
        userUpdateMany.mockClear().mockResolvedValue({ count: 1 });

        const result = await transitionAccountStatus(
          { telegramId: BASE_USER.telegramId },
          testCase.action,
        );

        if (status === testCase.from) {
          expect(result.kind, status).toBe("changed");
          expect(userUpdateMany, status).toHaveBeenCalledWith({
            where: { id: BASE_USER.id, status: testCase.from },
            data: { status: testCase.to },
          });
        } else if (status === testCase.to) {
          expect(result.kind, status).toBe("already");
          expect(userUpdateMany, status).not.toHaveBeenCalled();
        } else {
          expect(result.kind, status).toBe("forbidden");
          expect(userUpdateMany, status).not.toHaveBeenCalled();
        }
      }
    });
  }

  it("returns not_found without writing", async () => {
    userFindUnique.mockResolvedValue(null);

    await expect(
      transitionAccountStatus({ id: BASE_USER.id }, "pause"),
    ).resolves.toEqual({ kind: "not_found" });
    expect(userUpdateMany).not.toHaveBeenCalled();
  });

  it("does not overwrite a moderation status that wins the CAS race", async () => {
    userFindUnique
      .mockResolvedValueOnce({ ...BASE_USER, status: "active" })
      .mockResolvedValueOnce({ ...BASE_USER, status: "banned" });
    userUpdateMany.mockResolvedValue({ count: 0 });

    const result = await transitionAccountStatus({ id: BASE_USER.id }, "pause");

    expect(result).toMatchObject({ kind: "forbidden", status: "banned" });
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: { id: BASE_USER.id, status: "active" },
      data: { status: "paused" },
    });
  });
});

describe("freezeAccount", () => {
  it.each(["active", "paused"] as const)(
    "atomically freezes and cancels matches from %s, then runs effects",
    async (status) => {
      userFindUnique.mockResolvedValue({ ...BASE_USER, status });
      const cancelled = [{
        matchId: "match-1",
        partnerUserId: "partner-1",
        partnerTelegramId: 456n,
        partnerLanguage: "en",
        partnerPlatform: "telegram",
      }];
      claimInFlightMatchCancellations.mockResolvedValue(cancelled);
      const api = { sendMessage: vi.fn() } as never;

      const result = await freezeAccount({ id: BASE_USER.id }, api);

      expect(result).toMatchObject({ kind: "changed", previousStatus: status });
      expect(userUpdateMany).toHaveBeenCalledWith({
        where: { id: BASE_USER.id, status },
        data: { status: "frozen" },
      });
      expect(claimInFlightMatchCancellations).toHaveBeenCalledWith(
        BASE_USER.id,
        expect.anything(),
        { strict: true },
      );
      expect(deliverCancelledPartnerEffects).toHaveBeenCalledWith(cancelled, api);
      expect(notifyFounderAccountClosed).toHaveBeenCalledWith("frozen");
      expect(unpinStatusBanner).toHaveBeenCalledWith(api, BASE_USER.telegramId);
    },
  );

  it.each(
    ALL_STATUSES.filter((status) => status !== "active" && status !== "paused"),
  )("does not freeze or produce effects from %s", async (status) => {
    userFindUnique.mockResolvedValue({ ...BASE_USER, status });

    const result = await freezeAccount({ id: BASE_USER.id }, null);

    expect(result.kind).toBe(status === "frozen" ? "already" : "forbidden");
    expect(userUpdateMany).not.toHaveBeenCalled();
    expect(claimInFlightMatchCancellations).not.toHaveBeenCalled();
    expect(deliverCancelledPartnerEffects).not.toHaveBeenCalled();
    expect(notifyFounderAccountClosed).not.toHaveBeenCalled();
  });

  it("reports a concurrent moderation write and does not cancel matches", async () => {
    userFindUnique
      .mockResolvedValueOnce({ ...BASE_USER, status: "active" })
      .mockResolvedValueOnce({ ...BASE_USER, status: "pending_investigation" });
    userUpdateMany.mockResolvedValue({ count: 0 });

    const result = await freezeAccount({ id: BASE_USER.id }, null);

    expect(result).toMatchObject({
      kind: "forbidden",
      status: "pending_investigation",
    });
    expect(claimInFlightMatchCancellations).not.toHaveBeenCalled();
    expect(deliverCancelledPartnerEffects).not.toHaveBeenCalled();
  });

  it("does not run post-commit effects when transactional cancellation fails", async () => {
    userFindUnique.mockResolvedValue({ ...BASE_USER, status: "active" });
    claimInFlightMatchCancellations.mockRejectedValue(new Error("cancel failed"));

    await expect(freezeAccount({ id: BASE_USER.id }, null)).rejects.toThrow(
      "cancel failed",
    );
    expect(deliverCancelledPartnerEffects).not.toHaveBeenCalled();
    expect(notifyFounderAccountClosed).not.toHaveBeenCalled();
    expect(unpinStatusBanner).not.toHaveBeenCalled();
  });
});
