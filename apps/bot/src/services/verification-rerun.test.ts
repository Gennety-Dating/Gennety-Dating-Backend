/**
 * Focused test for `triggerVerificationRerun` — the photo-edit reconciliation
 * entry point (called from the bot/mobile photo handlers and the chat agent's
 * `attach_profile_photo` tool). Verifies the three observable branches:
 *   - user missing            → `{ kind: "user_missing" }`, no DB write
 *   - never verified          → `{ kind: "no_inquiry" }`, no DB write
 *   - reference selfie gone   → `{ kind: "reference_expired" }`, no DB write.
 *                               Critically it must return BEFORE the `pending`
 *                               flip, or deleting a photo after the 90-day
 *                               scrub would knock a verified user out of the
 *                               match pool over a check we cannot run.
 *   - reference present       → resets the `(personaInquiryId, faceMatchedAt)`
 *                                idempotency marker + flips status to `pending`,
 *                                then kicks off the pipeline (fire-and-forget)
 *
 * The pipeline the `started` branch launches is left to run against the same
 * mocked Prisma; giving the user an empty photo array makes it short-circuit to
 * `pending_review` before any Rekognition/storage call, so the test needs no
 * network and no extra module mocks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn(async (_arg?: unknown): Promise<unknown> => null);
const userUpdateMany = vi.fn(async (_arg?: unknown) => ({ count: 1 }));
const userUpdate = vi.fn(async (_arg?: unknown) => ({}));
const profileUpdateMany = vi.fn(async (_arg?: unknown) => ({ count: 1 }));
const profileFindUnique = vi.fn(async (_arg?: unknown): Promise<unknown> => null);

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: (arg: unknown) => userFindUnique(arg),
      updateMany: (arg: unknown) => userUpdateMany(arg),
      update: (arg: unknown) => userUpdate(arg),
    },
    profile: {
      updateMany: (arg: unknown) => profileUpdateMany(arg),
      findUnique: (arg: unknown) => profileFindUnique(arg),
    },
  },
}));

const { triggerVerificationRerun } = await import("./verification-pipeline.js");

const fakeApi = { sendMessage: vi.fn(async () => ({})) } as never;

function fullUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    telegramId: 0n, // non-positive → the pipeline never tries to DM
    status: "onboarding",
    gender: null,
    verificationStatus: "pending",
    personaInquiryId: "inq_x",
    verifiedSelfiePath: "user-1/selfie.jpg",
    faceMatchedAt: null,
    // Empty photos → pipeline short-circuits to pending_review offline.
    profile: { photos: [], eloSeededAt: null },
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  userUpdateMany.mockResolvedValue({ count: 1 });
  userUpdate.mockResolvedValue({});
});

describe("triggerVerificationRerun", () => {
  it("returns user_missing and writes nothing when the user is absent", async () => {
    userFindUnique.mockResolvedValueOnce(null);

    const result = await triggerVerificationRerun("ghost", fakeApi);

    expect(result).toEqual({ kind: "user_missing" });
    expect(userUpdateMany).not.toHaveBeenCalled();
  });

  it("returns no_inquiry and writes nothing when the user never ran a check", async () => {
    userFindUnique.mockResolvedValueOnce({ personaInquiryId: null });

    const result = await triggerVerificationRerun("user-1", fakeApi);

    expect(result).toEqual({ kind: "no_inquiry" });
    expect(userUpdateMany).not.toHaveBeenCalled();
  });

  it("returns reference_expired WITHOUT touching status once the selfie is scrubbed", async () => {
    // The 90-day scrub cleared `verifiedSelfiePath` and AWS cannot re-issue it.
    // Flipping this user to `pending` here would silently drop a verified,
    // active user out of matching because they deleted a photo.
    userFindUnique.mockResolvedValueOnce({
      personaInquiryId: "inq_x",
      verificationStatus: "verified",
      verifiedSelfiePath: null,
    });

    const result = await triggerVerificationRerun("user-1", fakeApi);

    expect(result).toEqual({ kind: "reference_expired" });
    expect(userUpdateMany).not.toHaveBeenCalled();
  });

  it("resets the idempotency marker to `pending` and starts the pipeline", async () => {
    // First lookup = the rerun's own {personaInquiryId} select; subsequent
    // lookups = the fire-and-forget pipeline's findUser. Return the full row
    // for every call.
    userFindUnique.mockResolvedValue(fullUserRow());

    const result = await triggerVerificationRerun("user-1", fakeApi);

    expect(result).toEqual({ kind: "started", sessionId: "inq_x" });
    // The reset is pinned on the current session id so a concurrent liveness
    // check that moved the user to a newer session isn't clobbered.
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: { id: "user-1", personaInquiryId: "inq_x" },
      data: { faceMatchedAt: null, verificationStatus: "pending" },
    });

    // Let the fire-and-forget pipeline settle so it doesn't leak into the
    // next test; it runs offline (empty photos → pending_review).
    await new Promise((r) => setTimeout(r, 0));
  });
});
