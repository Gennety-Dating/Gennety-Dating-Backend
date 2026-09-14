import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userDelete: vi.fn(),
  messageFindMany: vi.fn(),
  reportFindMany: vi.fn(),
  reportDeleteMany: vi.fn(),
  botSessionDeleteMany: vi.fn(),
  claimMatches: vi.fn(),
  deliverEffects: vi.fn(),
  deleteStorageObject: vi.fn(),
  downloadProfileImage: vi.fn(),
  getMainBotApi: vi.fn(),
  notifyFounder: vi.fn(),
  notifyFounderStuckRefunds: vi.fn(),
  unpinKnownStatusBanner: vi.fn(),
  findRefundsInFlight: vi.fn(),
  writeSafetyTombstones: vi.fn(),
  listStorageObjects: vi.fn(),
  storageBucketState: vi.fn(),
  /** Any payment-table write inside the deletion transaction. There must be none. */
  paymentWrite: vi.fn(),
}));

vi.mock("@gennety/db", () => {
  // Payment rows outlive the account (A13-H14): the schema's `SetNull` keeps
  // them when the user row goes, so the deletion itself must never delete or
  // rewrite one. Every write a payment delegate offers is wired to one spy.
  const paymentDelegate = {
    delete: mocks.paymentWrite,
    deleteMany: mocks.paymentWrite,
    update: mocks.paymentWrite,
    updateMany: mocks.paymentWrite,
  };
  const tx = {
    user: { delete: mocks.userDelete },
    match: { findMany: vi.fn(), updateMany: vi.fn() },
    founderReport: { deleteMany: mocks.reportDeleteMany },
    botSession: { deleteMany: mocks.botSessionDeleteMany },
    ticketLedger: paymentDelegate,
    subscriptionLedger: paymentDelegate,
    rematchPurchase: paymentDelegate,
    venueChangePurchase: paymentDelegate,
    primeTimePurchase: paymentDelegate,
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
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  SUPABASE_SELFIE_BUCKET: "selfies",
  SUPABASE_PHOTO_BUCKET: "profile-photos",
  SUPABASE_CHAT_BUCKET: "chat-attachments",
  SUPABASE_VOICE_BUCKET: "voice-prompts",
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
  listStorageObjects: mocks.listStorageObjects,
  storageBucketState: mocks.storageBucketState,
}));
vi.mock("./refund-in-flight.js", () => ({
  findRefundsInFlight: mocks.findRefundsInFlight,
}));
vi.mock("./safety-tombstone.js", () => ({
  writeSafetyTombstones: mocks.writeSafetyTombstones,
}));
vi.mock("./main-bot-api.js", () => ({
  getMainBotApi: mocks.getMainBotApi,
}));
vi.mock("./founder-notify.js", () => ({
  notifyFounderAccountClosed: mocks.notifyFounder,
  notifyFounderDeletionStuckRefunds: mocks.notifyFounderStuckRefunds,
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
  AccountDeletionDeferredError,
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
  mocks.botSessionDeleteMany.mockResolvedValue({ count: 1 });
  mocks.userDelete.mockResolvedValue({});
  mocks.claimMatches.mockResolvedValue([{ matchId: "m1" }]);
  mocks.deliverEffects.mockResolvedValue(undefined);
  mocks.deleteStorageObject.mockResolvedValue(true);
  mocks.getMainBotApi.mockReturnValue({ token: "main-bot" });
  mocks.downloadProfileImage.mockResolvedValue(Buffer.from("img"));
  mocks.notifyFounder.mockResolvedValue(undefined);
  mocks.notifyFounderStuckRefunds.mockResolvedValue(undefined);
  mocks.unpinKnownStatusBanner.mockResolvedValue(undefined);
  mocks.findRefundsInFlight.mockResolvedValue({ blocking: [], stale: [] });
  mocks.writeSafetyTombstones.mockResolvedValue({
    tombstones: 0,
    reportsKept: 0,
    blocksKept: 0,
    reportsDropped: 0,
    blocksDropped: 0,
  });
  // The bucket listing returns nothing extra by default, so the referenced
  // paths alone are what gets deleted — the pre-M12 expectations still hold.
  mocks.listStorageObjects.mockResolvedValue([]);
  mocks.storageBucketState.mockResolvedValue("unreachable");
});

const YOUNG_REFUND = {
  table: "rematch_purchases",
  id: "rp-young",
  status: "refund_failed",
  since: new Date(),
};
const STALE_REFUND = {
  table: "ticket_ledger",
  id: "tl-stale",
  status: "gate_refund_pending",
  since: new Date("2026-08-01T00:00:00Z"),
};

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

  // ── A13-H14: payment records survive, safety history is captured ─────────

  it("never deletes or rewrites a payment row — the ledgers outlive the account", async () => {
    await deleteUserAccount(USER_ID, null);

    expect(mocks.userDelete).toHaveBeenCalledTimes(1);
    expect(mocks.paymentWrite).not.toHaveBeenCalled();
  });

  it("writes the safety tombstones inside the transaction, before the user row goes", async () => {
    await deleteUserAccount(USER_ID, null);

    expect(mocks.writeSafetyTombstones).toHaveBeenCalledWith(expect.anything(), USER_ID);
    expect(mocks.writeSafetyTombstones.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userDelete.mock.invocationCallOrder[0]!,
    );
  });

  it("defers while a refund is in flight, before erasing anything", async () => {
    mocks.findRefundsInFlight.mockResolvedValueOnce({ blocking: [YOUNG_REFUND], stale: [] });

    const attempt = deleteUserAccount(USER_ID, null);
    await expect(attempt).rejects.toBeInstanceOf(AccountDeletionDeferredError);
    await expect(attempt).rejects.toMatchObject({
      reason: "refund_in_progress",
      rows: [YOUNG_REFUND],
    });
    // The refusal must cost nothing but a retry.
    expect(mocks.downloadProfileImage).not.toHaveBeenCalled();
    expect(mocks.listStorageObjects).not.toHaveBeenCalled();
    expect(mocks.deleteStorageObject).not.toHaveBeenCalled();
    expect(mocks.unpinKnownStatusBanner).not.toHaveBeenCalled();
    expect(mocks.claimMatches).not.toHaveBeenCalled();
    expect(mocks.writeSafetyTombstones).not.toHaveBeenCalled();
    expect(mocks.userDelete).not.toHaveBeenCalled();
    expect(mocks.botSessionDeleteMany).not.toHaveBeenCalled();
    expect(mocks.notifyFounder).not.toHaveBeenCalled();
  });

  it("re-checks inside the transaction and rolls back when a refund appeared meanwhile", async () => {
    mocks.findRefundsInFlight
      .mockResolvedValueOnce({ blocking: [], stale: [] })
      .mockResolvedValueOnce({ blocking: [YOUNG_REFUND], stale: [] });

    await expect(deleteUserAccount(USER_ID, null)).rejects.toBeInstanceOf(
      AccountDeletionDeferredError,
    );
    expect(mocks.findRefundsInFlight).toHaveBeenLastCalledWith(USER_ID, expect.anything());
    expect(mocks.writeSafetyTombstones).not.toHaveBeenCalled();
    expect(mocks.userDelete).not.toHaveBeenCalled();
    expect(mocks.deliverEffects).not.toHaveBeenCalled();
    expect(mocks.notifyFounder).not.toHaveBeenCalled();
  });

  it("proceeds past a refund stuck for longer than the window and hands its id to the founder", async () => {
    mocks.findRefundsInFlight.mockResolvedValue({ blocking: [], stale: [STALE_REFUND] });

    const result = await deleteUserAccount(USER_ID, null);

    expect(result.deleted).toBe(true);
    expect(mocks.notifyFounderStuckRefunds).toHaveBeenCalledWith({
      userId: USER_ID,
      telegramId: 42n,
      rows: [
        {
          table: "ticket_ledger",
          id: "tl-stale",
          status: "gate_refund_pending",
          createdAt: STALE_REFUND.since,
        },
      ],
    });
    expect(mocks.notifyFounderStuckRefunds.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.userDelete.mock.invocationCallOrder[0]!,
    );
  });

  // ── A13-M12: the bucket, not the row, is the record of what we hold ──────

  it("erases every object listed under the user's prefix, including ones no row references", async () => {
    mocks.listStorageObjects.mockImplementation(async (bucket: string, prefix: string) => {
      expect(prefix).toBe(USER_ID);
      if (bucket === "selfies") return [`${USER_ID}/persona.jpg`, `${USER_ID}/replaced-selfie.jpg`];
      if (bucket === "voice-prompts") return [`${USER_ID}/1715000000000.m4a`];
      if (bucket === "chat-attachments") return [`${USER_ID}/never-sent.jpg`];
      return [];
    });

    const result = await deleteUserAccount(USER_ID, null);

    expect(mocks.deleteStorageObject.mock.calls).toEqual(
      expect.arrayContaining([
        ["selfies", `${USER_ID}/replaced-selfie.jpg`],
        ["voice-prompts", `${USER_ID}/1715000000000.m4a`],
        ["chat-attachments", `${USER_ID}/never-sent.jpg`],
      ]),
    );
    // A listed AND referenced object is deleted once, not twice.
    expect(
      mocks.deleteStorageObject.mock.calls.filter(
        ([bucket, path]) => bucket === "selfies" && path === `${USER_ID}/persona.jpg`,
      ),
    ).toHaveLength(1);
    expect(result.deletedStorageObjects).toBe(8);
  });

  it("fails closed when a bucket listing cannot be completed", async () => {
    mocks.listStorageObjects.mockImplementation(async (bucket: string) =>
      bucket === "voice-prompts" ? null : [],
    );

    const attempt = deleteUserAccount(USER_ID, null);
    await expect(attempt).rejects.toBeInstanceOf(AccountDeletionCleanupError);
    await expect(attempt).rejects.toMatchObject({
      failedObjects: [`voice-prompts/${USER_ID}/ (listing failed)`],
    });
    expect(mocks.userDelete).not.toHaveBeenCalled();
  });

  it("treats a bucket Supabase says does not exist as empty when nothing references it", async () => {
    // The fixture user holds no voice prompt, so nothing names an object in the
    // voice bucket — and that bucket was never created on this install.
    mocks.listStorageObjects.mockImplementation(async (bucket: string) =>
      bucket === "voice-prompts" ? null : [],
    );
    mocks.storageBucketState.mockImplementation(async (bucket: string) =>
      bucket === "voice-prompts" ? "missing" : "present",
    );

    const result = await deleteUserAccount(USER_ID, null);

    expect(result.deleted).toBe(true);
    expect(mocks.userDelete).toHaveBeenCalledTimes(1);
  });

  it("still fails closed on a missing bucket that a row references", async () => {
    // The fixture's profile photo lives in the photo bucket: a "missing" photo
    // bucket is a misconfiguration, not an empty one.
    mocks.listStorageObjects.mockImplementation(async (bucket: string) =>
      bucket === "profile-photos" ? null : [],
    );
    mocks.storageBucketState.mockResolvedValue("missing");

    await expect(deleteUserAccount(USER_ID, null)).rejects.toBeInstanceOf(
      AccountDeletionCleanupError,
    );
    expect(mocks.userDelete).not.toHaveBeenCalled();
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

  it("erases the chat session, which no cascade can reach", async () => {
    await deleteUserAccount(USER_ID, null);

    // Keyed by Telegram CHAT id, with no relation to `users` — so it survives
    // the cascade unless deleted explicitly. It carries pendingPhotos,
    // contextDumpBuffer and activeMatchId, and whatever it still says is
    // inherited by the NEXT account created in the same chat.
    expect(mocks.botSessionDeleteMany).toHaveBeenCalledWith({
      where: { key: "42" },
    });
  });

  it("does not erase the chat session when storage cleanup fails", async () => {
    mocks.deleteStorageObject.mockImplementation(
      async (_bucket: string, path: string) => !path.endsWith("persona.jpg"),
    );

    await expect(deleteUserAccount(USER_ID, null)).rejects.toBeInstanceOf(
      AccountDeletionCleanupError,
    );
    // The account survives for a safe retry, so its session must survive too:
    // wiping it here would sign the user out of a flow they are still in.
    expect(mocks.botSessionDeleteMany).not.toHaveBeenCalled();
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

/**
 * The survival of payment and safety rows is a property of the SCHEMA — a mock
 * transaction cannot observe a database cascade — so the relations themselves
 * are pinned here. Before A13-H14 every one of them was `onDelete: Cascade`, and
 * deleting an account erased its ledgers, pending refunds, and every report and
 * block filed against it.
 */
describe("schema: what outlives a deleted account", () => {
  const schema = readFileSync(
    resolve(__dirname, "../../../../packages/db/prisma/schema.prisma"),
    "utf8",
  );
  const modelBody = (name: string): string => {
    const match = new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
    if (!match?.[1]) throw new Error(`model ${name} not found in schema.prisma`);
    return match[1];
  };

  it.each([
    "TicketLedger",
    "SubscriptionLedger",
    "RematchPurchase",
    "VenueChangePurchase",
    "PrimeTimePurchase",
  ])("%s keeps its row with a null owner", (model) => {
    const body = modelBody(model);
    expect(body).toMatch(/\n\s+userId\s+String\?\s/);
    expect(body).toMatch(/\n\s+user\s+User\?\s+@relation\(fields: \[userId\], references: \[id\], onDelete: SetNull\)/);
  });

  it("keeps a report when either side or the match is deleted", () => {
    const body = modelBody("Report");
    expect(body).toMatch(/reporter\s+User\?\s+@relation\("ReportReporter".*onDelete: SetNull\)/);
    expect(body).toMatch(/reported\s+User\?\s+@relation\("ReportReported".*onDelete: SetNull\)/);
    expect(body).toMatch(/match\s+Match\?\s+@relation\(.*onDelete: SetNull\)/);
    expect(body).toMatch(/reportedFormerId\s+String\?/);
  });

  it("keeps a block against a deleted account, and erases the ones it drew", () => {
    const body = modelBody("UserBlock");
    expect(body).toMatch(/blocked\s+User\?\s+@relation\("UserBlockBlocked".*onDelete: SetNull\)/);
    expect(body).toMatch(/blocker\s+User\s+@relation\("UserBlockBlocker".*onDelete: Cascade\)/);
    expect(body).toMatch(/blockedFormerId\s+String\?/);
  });
});
