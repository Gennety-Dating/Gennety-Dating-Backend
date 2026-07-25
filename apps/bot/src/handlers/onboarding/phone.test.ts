import { describe, it, expect, vi, beforeEach } from "vitest";

const { classifyPhoneConflict, adoptAccountByPhone, sendCompletedUserEntry } =
  vi.hoisted(() => ({
    classifyPhoneConflict: vi.fn(),
    adoptAccountByPhone: vi.fn(),
    sendCompletedUserEntry: vi.fn(),
  }));

// Mock prisma before importing the handler.
vi.mock("@gennety/db", () => ({
  prisma: { user: { update: vi.fn(), findUnique: vi.fn() } },
}));
// Avoid pulling the re-engagement scheduler's side effects into the unit test.
vi.mock("../../workers/re-engagement-schedule.js", () => ({
  onboardingActivityPatch: () => ({}),
}));
// The linking policy has its own suite (services/account-linking.test.ts); here
// we only assert how the handler reacts to each decision.
vi.mock("../../services/account-linking.js", () => ({
  ACCOUNT_LINK_SELECT: {},
  classifyPhoneConflict,
  adoptAccountByPhone,
}));
vi.mock("../start.js", () => ({ sendCompletedUserEntry }));

import { prisma } from "@gennety/db";
import { handlePhoneContact } from "./phone.js";

type Ctx = Parameters<typeof handlePhoneContact>[0];

function makeCtx(opts: { contact?: unknown; fromId?: number } = {}): {
  ctx: Ctx;
  reply: ReturnType<typeof vi.fn>;
  session: { language: string; onboardingStep?: string };
} {
  const reply = vi.fn().mockResolvedValue(undefined);
  const session = { language: "en" } as { language: string; onboardingStep?: string };
  const ctx = {
    message: { contact: opts.contact },
    from: { id: opts.fromId ?? 111, username: "ggen1e" },
    session,
    reply,
  } as unknown as Ctx;
  return { ctx, reply, session };
}

const update = prisma.user.update as unknown as ReturnType<typeof vi.fn>;

describe("handlePhoneContact", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a contact that is not the user's own number", async () => {
    const { ctx, reply } = makeCtx({
      contact: { phone_number: "+15551234567", user_id: 999 },
      fromId: 111,
    });
    await handlePhoneContact(ctx);
    expect(update).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("your own"));
  });

  it("saves a normalized phone + phoneVerifiedAt for the user's own number", async () => {
    update.mockResolvedValue({});
    const { ctx, reply } = makeCtx({
      contact: { phone_number: "15551234567", user_id: 111 },
      fromId: 111,
    });
    await handlePhoneContact(ctx);
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0]![0] as {
      where: { telegramId: bigint };
      data: { phone: string; phoneVerifiedAt: Date; registrationTrack?: string };
    };
    expect(arg.where).toEqual({ telegramId: 111n });
    expect(arg.data.phone).toBe("+15551234567");
    expect(arg.data.phoneVerifiedAt).toBeInstanceOf(Date);
    // No track chosen yet (findUnique mock → undefined) → general is stamped.
    expect(arg.data.registrationTrack).toBe("general");
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("confirmed"));
  });

  it("does not overwrite an already-chosen track when the contact arrives", async () => {
    const { prisma: mocked } = await import("@gennety/db");
    (mocked.user.findUnique as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      registrationTrack: "student",
    });
    update.mockResolvedValue({});
    const { ctx } = makeCtx({
      contact: { phone_number: "15551234567", user_id: 111 },
      fromId: 111,
    });
    await handlePhoneContact(ctx);
    const arg = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect("registrationTrack" in arg.data).toBe(false);
  });

  it("rejects an unparseable phone number without writing", async () => {
    const { ctx, reply } = makeCtx({
      contact: { phone_number: "abc", user_id: 111 },
      fromId: 111,
    });
    await handlePhoneContact(ctx);
    expect(update).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });
});

/**
 * The number is already on file (P2002). Telegram vouched it belongs to THIS
 * account, so the collision is a login — see services/account-linking.ts.
 */
describe("handlePhoneContact — phone-based login", () => {
  const findUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    update.mockRejectedValue({ code: "P2002" });
    findUnique.mockResolvedValue({ id: "row", registrationTrack: "general" });
  });

  it("logs the user into the account that owns the number", async () => {
    classifyPhoneConflict.mockReturnValue({
      kind: "adopt",
      ownerId: "owner-id",
      stubId: "stub-id",
    });
    adoptAccountByPhone.mockResolvedValue({
      kind: "adopted",
      user: {
        telegramId: 111n,
        status: "onboarding",
        onboardingStep: "conversational",
        language: "ru",
      },
    });
    const { ctx, reply, session } = makeCtx({
      contact: { phone_number: "+380972455081", user_id: 111 },
      fromId: 111,
    });

    await handlePhoneContact(ctx);

    expect(adoptAccountByPhone).toHaveBeenCalledWith({
      ownerId: "owner-id",
      stubId: "stub-id",
      telegramId: 111n,
      phone: "+380972455081",
      telegramUsername: "ggen1e",
    });
    // The session still held the deleted row's position; without this sync the
    // router would keep walking a returning user through registration.
    expect(session.onboardingStep).toBe("conversational");
    expect(session.language).toBe("ru");
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("с возвращением"));
    // Not onboarded yet → the Mini App/bot flow continues, no menu entry.
    expect(sendCompletedUserEntry).not.toHaveBeenCalled();
  });

  it("hands a fully onboarded account to the shared returning-user entry", async () => {
    classifyPhoneConflict.mockReturnValue({
      kind: "adopt",
      ownerId: "owner-id",
      stubId: "stub-id",
    });
    adoptAccountByPhone.mockResolvedValue({
      kind: "adopted",
      user: {
        telegramId: 111n,
        status: "active",
        onboardingStep: "completed",
        language: "en",
      },
    });
    const { ctx } = makeCtx({
      contact: { phone_number: "+380972455081", user_id: 111 },
      fromId: 111,
    });

    await handlePhoneContact(ctx);

    expect(sendCompletedUserEntry).toHaveBeenCalledWith(ctx, {
      telegramId: 111n,
      status: "active",
    });
  });

  it("sends people to support when both accounts carry real data", async () => {
    classifyPhoneConflict.mockReturnValue({ kind: "manual-merge" });
    const { ctx, reply } = makeCtx({
      contact: { phone_number: "+380972455081", user_id: 111 },
      fromId: 111,
    });

    await handlePhoneContact(ctx);

    expect(adoptAccountByPhone).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("@gennetysupport"));
  });

  it("falls back to the conservative notice when the adoption goes stale", async () => {
    classifyPhoneConflict.mockReturnValue({
      kind: "adopt",
      ownerId: "owner-id",
      stubId: "stub-id",
    });
    adoptAccountByPhone.mockResolvedValue({ kind: "stale" });
    const { ctx, reply } = makeCtx({
      contact: { phone_number: "+380972455081", user_id: 111 },
      fromId: 111,
    });

    await handlePhoneContact(ctx);

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("already linked"));
  });

  it("keeps the conservative notice when either row vanished", async () => {
    findUnique.mockResolvedValue(null);
    const { ctx, reply } = makeCtx({
      contact: { phone_number: "+380972455081", user_id: 111 },
      fromId: 111,
    });

    await handlePhoneContact(ctx);

    expect(classifyPhoneConflict).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("already linked"));
  });
});
