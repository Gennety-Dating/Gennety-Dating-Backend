import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  tombstoneFindMany: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    safetyTombstone: { findMany: mocks.tombstoneFindMany },
  },
}));

const testEnv = vi.hoisted(() => ({ JWT_SECRET: "unit-test-secret", DEMO_MODE_ENABLED: false }));
vi.mock("../config.js", () => ({ env: testEnv }));

const { formerAccountsOf, hasFormerAccount } = await import("./former-account.js");
const { safetyIdentitiesOf } = await import("./identity-hash.js");

const FORMER_ID = "11111111-1111-4111-8111-111111111111";
const NEW_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-13T12:00:00Z");

const IDENTITY = {
  telegramId: 4242n,
  phone: "+380501234567",
  phoneVerifiedAt: new Date("2026-08-01T00:00:00Z"),
  email: "Ana@Uni.Edu",
  isEmailVerified: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  testEnv.JWT_SECRET = "unit-test-secret";
  testEnv.DEMO_MODE_ENABLED = false;
  mocks.userFindUnique.mockResolvedValue({ ...IDENTITY });
  mocks.tombstoneFindMany.mockResolvedValue([]);
});

describe("formerAccountsOf / hasFormerAccount (re-registration)", () => {
  it("groups the matching tombstones by former account, with the identities they share", async () => {
    const deletedAt = new Date("2026-09-01T00:00:00Z");
    mocks.tombstoneFindMany.mockResolvedValueOnce([
      { formerUserId: FORMER_ID, kind: "telegram", createdAt: deletedAt },
      { formerUserId: FORMER_ID, kind: "phone", createdAt: deletedAt },
    ]);
    const former = await formerAccountsOf(NEW_ID);
    expect(former).toEqual([{ formerUserId: FORMER_ID, deletedAt, kinds: ["telegram", "phone"] }]);
    const where = mocks.tombstoneFindMany.mock.calls[0]![0].where;
    expect(where.formerUserId).toEqual({ not: NEW_ID });
    expect(where.identityHash.in).toEqual(
      safetyIdentitiesOf(IDENTITY, "unit-test-secret").map((identity) => identity.identityHash),
    );
  });

  it("is false for a first-time account", async () => {
    expect(await hasFormerAccount(NEW_ID)).toBe(false);
  });

  it("is true when a deleted account shared an identity", async () => {
    mocks.tombstoneFindMany.mockResolvedValueOnce([
      { formerUserId: FORMER_ID, kind: "telegram", createdAt: NOW },
    ]);
    expect(await hasFormerAccount(NEW_ID)).toBe(true);
  });

  it("never matches in the demo or without a secret", async () => {
    mocks.tombstoneFindMany.mockResolvedValue([{ formerUserId: FORMER_ID, kind: "telegram", createdAt: NOW }]);
    testEnv.DEMO_MODE_ENABLED = true;
    expect(await hasFormerAccount(NEW_ID)).toBe(false);
    testEnv.DEMO_MODE_ENABLED = false;
    expect(await hasFormerAccount(NEW_ID, "")).toBe(false);
    expect(mocks.tombstoneFindMany).not.toHaveBeenCalled();
  });
});
