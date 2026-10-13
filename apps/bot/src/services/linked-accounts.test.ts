import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  profileFindUnique: vi.fn(),
  profileFindMany: vi.fn(),
  queryRaw: vi.fn(),
  tombstoneFindMany: vi.fn(),
  userFindMany: vi.fn(),
  formerAccountsOf: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    profile: { findUnique: mocks.profileFindUnique, findMany: mocks.profileFindMany },
    safetyTombstone: { findMany: mocks.tombstoneFindMany },
    user: { findMany: mocks.userFindMany },
    $queryRaw: mocks.queryRaw,
  },
}));
vi.mock("./former-account.js", () => ({ formerAccountsOf: mocks.formerAccountsOf }));

const { linkedAccountGroups, linkedAccountsOf } = await import("./linked-accounts.js");

const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const TWIN = "aaaaaaaa-0000-4000-8000-000000000002";
const GONE = "aaaaaaaa-0000-4000-8000-000000000003";
const THIRD = "aaaaaaaa-0000-4000-8000-000000000004";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.profileFindUnique.mockResolvedValue({ uploadedPhotoHashes: ["h1", "h2", "h3"] });
  mocks.profileFindMany.mockResolvedValue([]);
  mocks.formerAccountsOf.mockResolvedValue([]);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.tombstoneFindMany.mockResolvedValue([]);
  mocks.userFindMany.mockResolvedValue([]);
});

describe("linkedAccountsOf (the admin user card)", () => {
  it("is empty for an account nothing links to", async () => {
    expect(await linkedAccountsOf(ME)).toEqual([]);
  });

  it("links a live account that uploaded the same photos, and counts them", async () => {
    mocks.profileFindMany.mockResolvedValueOnce([
      {
        userId: TWIN,
        uploadedPhotoHashes: ["h2", "h3", "other"],
        user: { firstName: "Ana", createdAt: new Date("2026-10-01T00:00:00Z") },
      },
    ]);
    const linked = await linkedAccountsOf(ME);
    expect(linked).toEqual([
      expect.objectContaining({ userId: TWIN, firstName: "Ana", deleted: false, signals: ["same_photo"], sharedPhotos: 2 }),
    ]);
    expect(mocks.profileFindMany.mock.calls[0]![0].where).toEqual({
      userId: { not: ME },
      uploadedPhotoHashes: { hasSome: ["h1", "h2", "h3"] },
    });
  });

  it("links the deleted account this person registered with before", async () => {
    const deletedAt = new Date("2026-09-01T00:00:00Z");
    mocks.formerAccountsOf.mockResolvedValueOnce([{ formerUserId: GONE, deletedAt, kinds: ["telegram"] }]);
    expect(await linkedAccountsOf(ME)).toEqual([
      expect.objectContaining({ userId: GONE, deleted: true, at: deletedAt, signals: ["former_account"], sharedIdentities: ["telegram"] }),
    ]);
  });

  it("does not search photos for a profile without any", async () => {
    mocks.profileFindUnique.mockResolvedValueOnce({ uploadedPhotoHashes: [] });
    await linkedAccountsOf(ME);
    expect(mocks.profileFindMany).not.toHaveBeenCalled();
  });
});

describe("linkedAccountGroups (the admin groups list)", () => {
  it("is empty when nothing links", async () => {
    expect(await linkedAccountGroups()).toEqual([]);
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it("merges shared photos and a re-registration into one group (connected components)", async () => {
    mocks.queryRaw.mockResolvedValueOnce([{ user_ids: [ME, TWIN] }, { user_ids: [TWIN, THIRD] }]);
    mocks.tombstoneFindMany.mockResolvedValueOnce([{ formerUserId: GONE, restoredToUserId: ME }]);
    mocks.userFindMany.mockResolvedValueOnce([
      { id: ME, firstName: "Ana", createdAt: new Date("2026-10-01T00:00:00Z") },
      { id: TWIN, firstName: "Ana", createdAt: new Date("2026-10-02T00:00:00Z") },
      { id: THIRD, firstName: "Anna", createdAt: new Date("2026-10-03T00:00:00Z") },
    ]);

    const groups = await linkedAccountGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe(ME);
    expect(groups[0]!.signals).toEqual(["former_account", "same_photo"]);
    expect(groups[0]!.members.map((member) => [member.userId, member.deleted])).toEqual([
      [ME, false],
      [TWIN, false],
      [GONE, true],
      [THIRD, false],
    ]);
  });

  it("keeps unrelated pairs as separate groups, largest first", async () => {
    mocks.queryRaw.mockResolvedValueOnce([{ user_ids: [ME, TWIN] }, { user_ids: [GONE, THIRD] }]);
    mocks.tombstoneFindMany.mockResolvedValueOnce([{ formerUserId: "aaaaaaaa-0000-4000-8000-000000000005", restoredToUserId: THIRD }]);
    const groups = await linkedAccountGroups();
    expect(groups.map((group) => group.members.length)).toEqual([3, 2]);
  });
});
