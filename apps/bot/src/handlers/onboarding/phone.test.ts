import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma before importing the handler.
vi.mock("@gennety/db", () => ({
  prisma: { user: { update: vi.fn() } },
}));
// Avoid pulling the re-engagement scheduler's side effects into the unit test.
vi.mock("../../workers/re-engagement-schedule.js", () => ({
  onboardingActivityPatch: () => ({}),
}));

import { prisma } from "@gennety/db";
import { handlePhoneContact } from "./phone.js";

type Ctx = Parameters<typeof handlePhoneContact>[0];

function makeCtx(opts: { contact?: unknown; fromId?: number } = {}): {
  ctx: Ctx;
  reply: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    message: { contact: opts.contact },
    from: { id: opts.fromId ?? 111 },
    session: { language: "en" },
    reply,
  } as unknown as Ctx;
  return { ctx, reply };
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
      data: { phone: string; phoneVerifiedAt: Date };
    };
    expect(arg.where).toEqual({ telegramId: 111n });
    expect(arg.data.phone).toBe("+15551234567");
    expect(arg.data.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("confirmed"));
  });

  it("reports a duplicate when the number is linked to another account (P2002)", async () => {
    update.mockRejectedValue({ code: "P2002" });
    const { ctx, reply } = makeCtx({
      contact: { phone_number: "+15551234567", user_id: 111 },
      fromId: 111,
    });
    await handlePhoneContact(ctx);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("already linked"));
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
