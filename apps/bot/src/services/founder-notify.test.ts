import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendMessage, sendPhoto, sendMediaGroup, useTransformers, ApiCtor } = vi.hoisted(() => {
  const sendMessage = vi.fn().mockResolvedValue({});
  const sendPhoto = vi.fn().mockResolvedValue({});
  const sendMediaGroup = vi.fn().mockResolvedValue({});
  // The founder bot is a second Bot API token with its own rate limits, so it
  // gets the same throttler + 429 replay as the main one — which means this
  // stand-in has to own a `config` like the real `Api` does.
  const useTransformers = vi.fn();
  const ApiCtor = vi.fn().mockImplementation(() => ({
    sendMessage,
    sendPhoto,
    sendMediaGroup,
    config: { use: useTransformers },
  }));
  return { sendMessage, sendPhoto, sendMediaGroup, useTransformers, ApiCtor };
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
    ADMIN_DASHBOARD_URL: "",
    ADMIN_API_KEY: "test-admin-key",
  },
}));
vi.mock("../config.js", () => ({ env }));

const { updateMany, findUnique, createReport, adSpendFindMany, eventFindUnique } = vi.hoisted(
  () => ({
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    createReport: vi.fn(),
    adSpendFindMany: vi.fn().mockResolvedValue([]),
    eventFindUnique: vi.fn().mockResolvedValue(null),
  }),
);
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { updateMany, findUnique },
    founderReport: { create: createReport },
    adSpend: { findMany: adSpendFindMany },
    event: { findUnique: eventFindUnique },
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
  notifyFounderAdSpendReminder,
  isFounderFeedSuppressedRuntime,
  __resetFounderApiForTests,
  __resetHandlerAlertsForTests,
  notifyFounderHandlerError,
  type FounderAccountUser,
} from "./founder-notify.js";
import { verifyAdSpendLink } from "./founder-ad-spend-link.js";

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
  env.ADMIN_DASHBOARD_URL = "";
  env.ADMIN_API_KEY = "test-admin-key";
  adSpendFindMany.mockResolvedValue([]);
  eventFindUnique.mockResolvedValue(null);
  __resetFounderApiForTests();
});

describe("handler-error alerts", () => {
  beforeEach(() => __resetHandlerAlertsForTests());

  it("announces the first failure and folds the storm into the next window", async () => {
    // The failure being reported is precisely the one that would otherwise send
    // a message per update: a deploy where every handler throws.
    env.FOUNDER_NOTIFY_ENABLED = true;
    const start = new Date("2026-09-07T10:00:00Z");

    await notifyFounderHandlerError("update 1: boom", start);
    await notifyFounderHandlerError("update 2: boom", new Date(start.getTime() + 60_000));
    await notifyFounderHandlerError("update 3: boom", new Date(start.getTime() + 120_000));

    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Past the window, the next one carries what was swallowed.
    await notifyFounderHandlerError(
      "update 4: boom",
      new Date(start.getTime() + 16 * 60_000),
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    // Two were swallowed between the announcements; the fourth is itself the
    // one being announced, so it is not among them.
    expect(String(sendMessage.mock.calls[1]![1])).toContain("и ещё 2");
  });
});

describe("the founder bot's own Bot API limits", () => {
  it("throttles and replays 429s on the second token too", async () => {
    // Eleven notifiers share this token and several fire together after the
    // Thursday batch. A second bot is a second, independent set of limits — it
    // does not inherit the main bot's transformers.
    env.FOUNDER_NOTIFY_ENABLED = true;
    findUnique.mockResolvedValue(null);

    await notifyFounderAdSpendReminder(new Date("2026-09-07T09:00:00Z"));

    expect(ApiCtor).toHaveBeenCalledTimes(1);
    expect(useTransformers).toHaveBeenCalledTimes(1);
    expect(useTransformers.mock.calls[0]).toHaveLength(2);
  });
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

  // Founder decision 2026-08-02: the delete notification carries the full
  // profile, phone and photos. Disclosed in legal/privacy-policy.md §12.2 and
  // accepted as a residual risk in legal/dpia.md R9 — if this test is changed,
  // those documents change with it.
  it("DMs the founder the profile + phone with a delete title, using pre-downloaded photo buffers", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    await notifyFounderAccountClosed("deleted", accountUser(), [Buffer.from("img")]);

    // One buffer → sendPhoto with a caption. The generic download path
    // (downloadProfileImage) must NOT be used since buffers were supplied.
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(downloadProfileImage).not.toHaveBeenCalled();
    const [chatId, , opts] = sendPhoto.mock.calls[0]!;
    expect(chatId).toBe(999);
    const caption = (opts as { caption?: string }).caption ?? "";
    expect(caption).toContain("УДАЛЁН");
    expect(caption).toContain("+380991234567");
    expect(caption).toContain("Alice");
    // Days-in-product survived from the anonymous version — the single most
    // useful number for reading early churn.
    expect(caption).toContain("5 дн.");
  });

  it("downloads photos itself when no buffers are supplied (freeze path)", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    await notifyFounderAccountClosed("frozen", accountUser());
    expect(downloadProfileImage).toHaveBeenCalledTimes(1);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    const [, , opts] = sendPhoto.mock.calls[0]!;
    const caption = (opts as { caption?: string }).caption ?? "";
    expect(caption).toContain("ЗАМОРОЖЕН");
    expect(caption).toContain("+380991234567");
  });

  it("falls back to a plain message when there is no profile", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    await notifyFounderAccountClosed("frozen", accountUser({ profile: null }));
    // No profile → no photos → header sent as a plain message.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendMessage.mock.calls[0]!;
    expect(text).toContain("ЗАМОРОЖЕН");
    expect(text).toContain("+380991234567");
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

describe("notifyFounderAdSpendReminder", () => {
  it("is a no-op when the feature is disabled", async () => {
    env.FOUNDER_NOTIFY_ENABLED = false;
    await notifyFounderAdSpendReminder(new Date("2026-08-17T00:00:00Z"));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("names the closed Mon–Sun week and links to the dashboard when configured", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    env.ADMIN_DASHBOARD_URL = "https://admin.gennety.com/";
    await notifyFounderAdSpendReminder(new Date("2026-08-17T00:00:00Z")); // a Monday
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe(999);
    expect(text).toContain("17 августа");
    expect(text).toContain("23 августа");
    // Trailing slash on the configured URL must not become a doubled one.
    expect(text).toContain("https://admin.gennety.com/ad-spend");
    expect(text).not.toContain("//ad-spend");
  });

  it("carries a one-tap link to the mobile form, not only the dashboard", async () => {
    // The whole point of the rework: the dashboard link is useless from a
    // phone (its Bearer key lives in sessionStorage, which Telegram's in-app
    // browser always opens empty), so the reminder must carry a login-free one.
    env.FOUNDER_NOTIFY_ENABLED = true;
    await notifyFounderAdSpendReminder(new Date("2026-08-17T00:00:00Z"));
    const [, text] = sendMessage.mock.calls[0]!;
    expect(text).toContain("https://dating-api.gennety.com/v1/founder/ad-spend/");

    // The token must be live and must name the week the message names.
    const token = /ad-spend\/([\w-]+\.[\w-]+)/.exec(text as string)?.[1];
    expect(token).toBeTruthy();
    expect(verifyAdSpendLink(token!)).toEqual(
      expect.objectContaining({ weekStart: "2026-08-17", weekEnd: "2026-08-23" }),
    );
  });

  it("derives the closed week from the calendar when given no date", async () => {
    // It used to be handed `now - 7d`, which only lands on a Monday because
    // the cron fires at 09:00 Kyiv. Fixing the hour must not move the week.
    env.FOUNDER_NOTIFY_ENABLED = true;
    vi.useFakeTimers();
    try {
      // Monday 02:00 Kyiv = Sunday 23:00 UTC — the exact case `now - 7d` got
      // wrong, naming a Sun–Sat window no dashboard entry could match.
      vi.setSystemTime(new Date("2026-08-23T23:00:00Z"));
      await notifyFounderAdSpendReminder();
    } finally {
      vi.useRealTimers();
    }
    const [, text] = sendMessage.mock.calls[0]!;
    expect(text).toContain("17 августа");
    expect(text).toContain("23 августа");
  });

  it("reports what is already logged instead of nagging unconditionally", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    adSpendFindMany.mockResolvedValue([
      { channel: "tg:promo", amountUsdCents: 12_000 },
      { channel: "tg:promo", amountUsdCents: 3_000 },
    ]);
    await notifyFounderAdSpendReminder(new Date("2026-08-17T00:00:00Z"));
    const [, text] = sendMessage.mock.calls[0]!;
    expect(text).toContain("2 записи");
    expect(text).toContain("$150.00");
    expect(text).toContain("tg:promo");
    expect(text).not.toContain("ещё не внесены");
  });

  it("says the week is empty when nothing is logged", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    adSpendFindMany.mockResolvedValue([]);
    await notifyFounderAdSpendReminder(new Date("2026-08-17T00:00:00Z"));
    const [, text] = sendMessage.mock.calls[0]!;
    expect(text).toContain("ещё не внесены");
  });

  it("degrades to a linkless reminder rather than sending nothing", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    env.ADMIN_DASHBOARD_URL = "";
    // No signing key → no tokenized form link either. The nudge still lands.
    env.ADMIN_API_KEY = "";
    await notifyFounderAdSpendReminder(new Date("2026-08-17T00:00:00Z"));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendMessage.mock.calls[0]!;
    expect(text).not.toContain("/ad-spend");
    expect(text).toContain("17 августа");
  });

  it("never throws when Telegram rejects the send", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    sendMessage.mockRejectedValueOnce(new Error("blocked"));
    await expect(
      notifyFounderAdSpendReminder(new Date("2026-08-17T00:00:00Z")),
    ).resolves.toBeUndefined();
  });

  it("never throws when the spend lookup fails", async () => {
    env.FOUNDER_NOTIFY_ENABLED = true;
    adSpendFindMany.mockRejectedValueOnce(new Error("db down"));
    await expect(
      notifyFounderAdSpendReminder(new Date("2026-08-17T00:00:00Z")),
    ).resolves.toBeUndefined();
  });
});
