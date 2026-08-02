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
  downloadProfileImage: vi.fn(),
  getMainBotApi: vi.fn(),
  notifyFounder: vi.fn(),
  unpinKnownStatusBanner: vi.fn(),
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

const testEnv = vi.hoisted(() => ({
  SUPABASE_SELFIE_BUCKET: "selfies",
  SUPABASE_PHOTO_BUCKET: "profile-photos",
  SUPABASE_CHAT_BUCKET: "chat-attachments",
  FOUNDER_NOTIFY_ENABLED: true,
}));
vi.mock("../config.js", () => ({ env: testEnv }));

vi.mock("./cancel-in-flight-matches.js", () => ({
  claimInFlightMatchCancellations: mocks.claimMatches,
  deliverCancelledPartnerEffects: mocks.deliverEffects,
}));
vi.mock("./storage.js", () => ({
  deleteStorageObject: mocks.deleteStorageObject,
  downloadProfileImage: mocks.downloadProfileImage,
}));
vi.mock("./main-bot-api.js", () => ({
  getMainBotApi: mocks.getMainBotApi,
}));
vi.mock("./founder-notify.js", () => ({
  notifyFounderAccountClosed: mocks.notifyFounder,
  FOUNDER_ACCOUNT_CLOSED_SELECT: {
    firstName: true,
    age: true,
    gender: true,
    preference: true,
    phone: true,
    email: true,
    language: true,
    registrationTrack: true,
    verificationStatus: true,
    telegramUsername: true,
    telegramId: true,
    profile: {
      select: {
        homeCity: true,
        height: true,
        hobbies: true,
        partnerPreferences: true,
        photos: true,
        eloSeedDetails: true,
      },
    },
  },
}));
vi.mock("./status-banner.js", () => ({
  unpinKnownStatusBanner: mocks.unpinKnownStatusBanner,
}));

import {
  AccountDeletionCleanupError,
  deleteUserAccount,
} from "./account-deletion.js";

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
  testEnv.FOUNDER_NOTIFY_ENABLED = true;
  mocks.userFindUnique.mockResolvedValue({
    id: USER_ID,
    telegramId: 42n,
    statusMessageId: 555,
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
  mocks.getMainBotApi.mockReturnValue({ token: "main-bot" });
  mocks.downloadProfileImage.mockResolvedValue(Buffer.from("img"));
  mocks.notifyFounder.mockResolvedValue(undefined);
  mocks.unpinKnownStatusBanner.mockResolvedValue(undefined);
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
    expect(mocks.notifyFounder).toHaveBeenCalledWith(
      "deleted",
      expect.objectContaining({ id: USER_ID }),
      [Buffer.from("img"), Buffer.from("img")],
    );
    expect(result).toEqual({
      deleted: true,
      cancelledMatches: 1,
      deletedFounderReports: 1,
      deletedStorageObjects: 5,
    });
  });

  it("downloads the founder-DM photo bytes before storage cleanup deletes them", async () => {
    await deleteUserAccount(USER_ID, null);

    // profile.photos = [`${USER_ID}/photo.jpg`, "telegram-file-id"] → both
    // downloaded, and strictly BEFORE any Supabase object is removed.
    expect(mocks.downloadProfileImage).toHaveBeenCalledTimes(2);
    const lastDownloadOrder =
      mocks.downloadProfileImage.mock.invocationCallOrder[1]!;
    const firstDeleteOrder =
      mocks.deleteStorageObject.mock.invocationCallOrder[0]!;
    expect(lastDownloadOrder).toBeLessThan(firstDeleteOrder);
  });

  it("skips the photo download entirely when the founder feed is off", async () => {
    testEnv.FOUNDER_NOTIFY_ENABLED = false;
    await deleteUserAccount(USER_ID, null);

    expect(mocks.downloadProfileImage).not.toHaveBeenCalled();
    expect(mocks.notifyFounder).toHaveBeenCalledWith(
      "deleted",
      expect.objectContaining({ id: USER_ID }),
      [],
    );
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
    expect(mocks.unpinKnownStatusBanner).not.toHaveBeenCalled();
  });

  it("unpins the exact Telegram banner after storage cleanup and before DB erasure", async () => {
    const api = {} as any;
    await deleteUserAccount(USER_ID, api);

    expect(mocks.unpinKnownStatusBanner).toHaveBeenCalledWith(api, 42n, 555);
    expect(mocks.unpinKnownStatusBanner.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userDelete.mock.invocationCallOrder[0]!,
    );
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
