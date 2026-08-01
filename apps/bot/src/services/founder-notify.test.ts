import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendMessage, sendPhoto, sendMediaGroup, ApiCtor } = vi.hoisted(() => {
  const sendMessage = vi.fn().mockResolvedValue({});
  const sendPhoto = vi.fn().mockResolvedValue({});
  const sendMediaGroup = vi.fn().mockResolvedValue({});
  const ApiCtor = vi.fn().mockImplementation(() => ({
    sendMessage,
    sendPhoto,
    sendMediaGroup,
  }));
  return { sendMessage, sendPhoto, sendMediaGroup, ApiCtor };
});

vi.mock("grammy", () => ({
  Api: ApiCtor,
  InputFile: class {
    constructor(public data: unknown) {}
  },
}));

const { env } = vi.hoisted(() => ({
  env: {
    FOUNDER_NOTIFY_ENABLED: false,
    FOUNDER_BOT_TOKEN: "founder-token",
    FOUNDER_TELEGRAM_ID: "999",
    PUBLIC_BASE_URL: "https://dating-api.gennety.com",
  },
}));
vi.mock("../config.js", () => ({ env }));

const { updateMany, findUnique, createReport } = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findUnique: vi.fn(),
  createReport: vi.fn(),
}));
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { updateMany, findUnique },
    founderReport: { create: createReport },
  },
}));

const { downloadProfileImage } = vi.hoisted(() => ({
  downloadProfileImage: vi.fn().mockResolvedValue(Buffer.from("img")),
}));
vi.mock("./storage.js", () => ({ downloadProfileImage }));

vi.mock("./main-bot-api.js", () => ({
  getMainBotApi: () => ({ token: "main" }),
}));

const { buildWeeklyMatchesReport } = vi.hoisted(() => ({
  buildWeeklyMatchesReport: vi.fn(),
}));
vi.mock("./weekly-matches-report.js", () => ({ buildWeeklyMatchesReport }));

import {
  notifyFounderNewUser,
  notifyFounderWeeklyMatches,
  notifyFounderAccountClosed,
  isFounderFeedSuppressedRuntime,
  __resetFounderApiForTests,
  type FounderAccountUser,
} from "./founder-notify.js";

function accountUser(over: Partial<FounderAccountUser> = {}): FounderAccountUser {
  return {
    firstName: "Alice",
    age: 22,
    gender: "female",
    preference: "men",
    phone: "+380991234567",
    email: "a@uni.edu",
    language: "en",
    registrationTrack: "general",
    verificationStatus: "verified",
    telegramUsername: "alice",
    telegramId: 12345n,
    createdAt: new Date(Date.now() - 5 * 86_400_000),
    status: "active",
    onboardingStep: "completed",
    profile: {
      homeCity: "Kyiv",
      height: 170,
      hobbies: ["art"],
      partnerPreferences: "kind",
      photos: ["f1"],
      eloSeedDetails: { score: 66 },
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  env.FOUNDER_NOTIFY_ENABLED = false;
  __resetFounderApiForTests();
});

describe("production-only runtime guard", () => {
  it("suppresses the feed on the dev launcher's NODE_ENV=development", () => {
    // Dev and prod share one founder bot + chat, so a stale
    // FOUNDER_NOTIFY_ENABLED=true in .env.local would post local test
    // registrations into the real founder DM.
    expect(isFounderFeedSuppressedRuntime("development")).toBe(true);
  });

  it("never suppresses a production-like runtime, including an unset NODE_ENV", () => {
    expect(isFounderFeedSuppressedRuntime(undefined)).toBe(false);
    expect(isFounderFeedSuppressedRuntime("production")).toBe(false);
    expect(isFounderFeedSuppressedRuntime("")).toBe(false);
  });

  it("does not construct the founder Api under NODE_ENV=development", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      env.FOUNDER_NOTIFY_ENABLED = true;
      updateMany.mockResolvedValue({ count: 1 });
      await notifyFounderNewUser("u1");
      expect(ApiCtor).not.toHaveBeenCalled();
      expect(sendMediaGroup).not.toHaveBeenCalled();
      expect(sendPhoto).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe("notifyFounderNewUser", () => {
  it("is a no-op when the feature is disabled (no Api, no DB claim)", async () => {
    env.FOUNDER_NOTIFY_ENABLED = false;
    await notifyFounderNewUser("u1");
    expect(ApiCtor).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("claims idempotently and sends profile + photos, excluding AI dump", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue({
      id: "u1",
      firstName: "Alice",
      age: 22,
      gender: "female",
      preference: "men",
      language: "en",
      registrationTrack: "student",
      verificationStatus: "verified",
      telegramUsername: "alice",
      profile: {
        homeCity: "Kyiv",
        height: 170,
        hobbies: ["art"],
        partnerPreferences: "kind",
        photos: ["f1", "f2"],
        psychologicalSummary: "SECRET AI DUMP",
        eloSeedDetails: { score: 80 },
      },
    });

    await notifyFounderNewUser("u1");

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "u1", status: "active", founderNotifiedAt: null },
      data: expect.objectContaining({ founderNotifiedAt: expect.any(Date) }),
    });
    // Two photos → a media group to the founder chat id (999).
    expect(sendMediaGroup).toHaveBeenCalledTimes(1);
    const [chatId, media] = sendMediaGroup.mock.calls[0]!;
    expect(chatId).toBe(999);
    const caption = (media as Array<{ caption?: string }>)[0]!.caption ?? "";
    expect(caption).toContain("Alice");
    expect(caption).toContain("80/100");
    // The AI-memory dump / psychological summary must never leak.
    expect(caption).not.toContain("SECRET AI DUMP");
  });

  it("does not send when the idempotency claim finds no row", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    updateMany.mockResolvedValue({ count: 0 });
    await notifyFounderNewUser("u1");
    expect(findUnique).not.toHaveBeenCalled();
    expect(sendMediaGroup).not.toHaveBeenCalled();
    expect(sendPhoto).not.toHaveBeenCalled();
  });
});

describe("notifyFounderAccountClosed", () => {
  it("is a no-op when disabled", async () => {
    env.FOUNDER_NOTIFY_ENABLED = false;
    await notifyFounderAccountClosed("deleted", accountUser());
    expect(ApiCtor).not.toHaveBeenCalled();
    expect(sendPhoto).not.toHaveBeenCalled();
  });

  // A deletion is an Art. 17 erasure request: nothing personal may outlive it
  // in the ops chat, so this notification is a coarse lifecycle event only.
  it("sends an ANONYMOUS lifecycle event on delete — no profile, phone or photos", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    await notifyFounderAccountClosed("deleted", accountUser(), [Buffer.from("img")]);

    expect(sendPhoto).not.toHaveBeenCalled();
    expect(downloadProfileImage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe(999);
    const body = String(text);
    expect(body).toContain("УДАЛЁН");
    // Coarse, non-identifying context the operator still gets.
    expect(body).toContain("Kyiv");
    expect(body).toContain("general");
    expect(body).toContain("5 дн.");
    // Nothing that identifies the erased person.
    for (const pii of ["+380991234567", "Alice", "a@uni.edu", "alice", "12345"]) {
      expect(body).not.toContain(pii);
    }
  });

  it("downloads photos itself when no buffers are supplied (freeze path)", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    await notifyFounderAccountClosed("frozen", accountUser());
    expect(downloadProfileImage).toHaveBeenCalledTimes(1);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    const [, , opts] = sendPhoto.mock.calls[0]!;
    const caption = (opts as { caption?: string }).caption ?? "";
    expect(caption).toContain("ЗАМОРОЖЕН");
    expect(caption).toContain("Alice");
    // The phone is a contact identifier the ops feed never needed.
    expect(caption).not.toContain("+380991234567");
  });

  it("falls back to a plain message when there is no profile", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    await notifyFounderAccountClosed("frozen", accountUser({ profile: null }));
    // No profile → no photos → header sent as a plain message.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendMessage.mock.calls[0]!;
    expect(text).toContain("ЗАМОРОЖЕН");
    expect(text).not.toContain("+380991234567");
  });
});

describe("notifyFounderWeeklyMatches", () => {
  it("snapshots a report and DMs the founder a tokenized link", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    buildWeeklyMatchesReport.mockResolvedValue({
      pairs: [{ matchId: "m1" }],
    });
    createReport.mockResolvedValue({});

    await notifyFounderWeeklyMatches(["m1"]);

    expect(createReport).toHaveBeenCalledTimes(1);
    const token = createReport.mock.calls[0]![0].data.token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe(999);
    expect(text).toContain(`/v1/founder/report/${token}`);
  });

  it("does nothing when there are no matches", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    await notifyFounderWeeklyMatches([]);
    expect(buildWeeklyMatchesReport).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
