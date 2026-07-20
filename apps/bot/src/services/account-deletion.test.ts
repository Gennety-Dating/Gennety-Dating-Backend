import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userDelete: vi.fn(),
  messageFindMany: vi.fn(),
  reportFindMany: vi.fn(),
  reportDeleteMany: vi.fn(),
  claimMatches: vi.fn(),
  deliverEffects: vi.fn(),
  deleteStorageObject: vi.fn(),
  notifyFounder: vi.fn(),
}));

vi.mock("@gennety/db", () => {
  const tx = {
    user: { delete: mocks.userDelete },
    match: { findMany: vi.fn(), updateMany: vi.fn() },
    founderReport: { deleteMany: mocks.reportDeleteMany },
  };
  return {
    prisma: {
      user: { findUnique: mocks.userFindUnique },
      message: { findMany: mocks.messageFindMany },
      founderReport: { findMany: mocks.reportFindMany },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
  };
});

vi.mock("../config.js", () => ({
  env: {
    SUPABASE_SELFIE_BUCKET: "selfies",
    SUPABASE_PHOTO_BUCKET: "profile-photos",
    SUPABASE_CHAT_BUCKET: "chat-attachments",
  },
}));

vi.mock("./cancel-in-flight-matches.js", () => ({
  claimInFlightMatchCancellations: mocks.claimMatches,
  deliverCancelledPartnerEffects: mocks.deliverEffects,
}));
vi.mock("./storage.js", () => ({
  deleteStorageObject: mocks.deleteStorageObject,
}));
vi.mock("./founder-notify.js", () => ({
  notifyFounderAccountClosed: mocks.notifyFounder,
}));

import {
  AccountDeletionCleanupError,
  deleteUserAccount,
} from "./account-deletion.js";

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({
    id: USER_ID,
    selfiePath: `${USER_ID}/legacy-selfie.jpg`,
    verifiedSelfiePath: `${USER_ID}/persona.jpg`,
    profile: {
      photos: [`${USER_ID}/photo.jpg`, "telegram-file-id"],
      profileMedia: [
        { type: "photo", photo: `${USER_ID}/photo.jpg` },
        { type: "video", video: "telegram-video-id" },
      ],
      pendingPhotoCandidates: [
        { photoRef: `${USER_ID}/pending.jpg` },
      ],
    },
  });
  mocks.messageFindMany.mockResolvedValue([
    { imageUrl: `${USER_ID}/chat.jpg` },
  ]);
  mocks.reportFindMany.mockResolvedValue([
    {
      id: "report-hit",
      dataJson: { pairs: [{ users: [{ userId: USER_ID }] }] },
    },
    {
      id: "report-other",
      dataJson: { pairs: [{ users: [{ userId: "someone-else" }] }] },
    },
  ]);
  mocks.reportDeleteMany.mockResolvedValue({ count: 1 });
  mocks.userDelete.mockResolvedValue({});
  mocks.claimMatches.mockResolvedValue([{ matchId: "m1" }]);
  mocks.deliverEffects.mockResolvedValue(undefined);
  mocks.deleteStorageObject.mockResolvedValue(true);
  mocks.notifyFounder.mockResolvedValue(undefined);
});

describe("deleteUserAccount", () => {
  it("erases storage before atomically cancelling matches and deleting the account", async () => {
    const result = await deleteUserAccount(USER_ID, null);

    expect(mocks.claimMatches).toHaveBeenCalledWith(USER_ID, expect.anything(), {
      strict: true,
    });
    expect(mocks.deliverEffects).toHaveBeenCalledWith([{ matchId: "m1" }], null);
    expect(mocks.deleteStorageObject.mock.calls).toEqual(
      expect.arrayContaining([
        ["selfies", `${USER_ID}/legacy-selfie.jpg`],
        ["selfies", `${USER_ID}/persona.jpg`],
        ["profile-photos", `${USER_ID}/photo.jpg`],
        ["profile-photos", `${USER_ID}/pending.jpg`],
        ["chat-attachments", `${USER_ID}/chat.jpg`],
      ]),
    );
    expect(mocks.deleteStorageObject).not.toHaveBeenCalledWith(
      "profile-photos",
      "telegram-file-id",
    );
    expect(mocks.reportDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["report-hit"] } },
    });
    expect(mocks.userDelete).toHaveBeenCalledWith({ where: { id: USER_ID } });
    expect(mocks.notifyFounder).toHaveBeenCalledWith("deleted");
    expect(result).toEqual({
      deleted: true,
      cancelledMatches: 1,
      deletedFounderReports: 1,
      deletedStorageObjects: 5,
    });
  });

  it("fails closed and preserves the DB row when storage cannot be erased", async () => {
    mocks.deleteStorageObject.mockImplementation(
      async (_bucket: string, path: string) => !path.endsWith("persona.jpg"),
    );

    await expect(deleteUserAccount(USER_ID, null)).rejects.toBeInstanceOf(
      AccountDeletionCleanupError,
    );
    expect(mocks.userDelete).not.toHaveBeenCalled();
    expect(mocks.reportDeleteMany).not.toHaveBeenCalled();
    expect(mocks.claimMatches).not.toHaveBeenCalled();
    expect(mocks.deliverEffects).not.toHaveBeenCalled();
    expect(mocks.notifyFounder).not.toHaveBeenCalled();
  });

  it("returns a not-found result without touching related systems", async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.messageFindMany.mockResolvedValue([]);

    await expect(deleteUserAccount(USER_ID, null)).resolves.toEqual({
      deleted: false,
      cancelledMatches: 0,
      deletedFounderReports: 0,
      deletedStorageObjects: 0,
    });
    expect(mocks.claimMatches).not.toHaveBeenCalled();
    expect(mocks.deleteStorageObject).not.toHaveBeenCalled();
    expect(mocks.userDelete).not.toHaveBeenCalled();
  });
});
