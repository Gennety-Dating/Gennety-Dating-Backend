import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const { state } = vi.hoisted(() => ({
  state: {
    users: [] as unknown[],
    userCount: 0,
    mobileRows: [] as unknown[],
    mobileGroups: [] as unknown[],
    timelineRows: [] as unknown[],
    timelineGroups: [] as unknown[],
    /** Set to make every chatEvent query throw, as a pre-migration DB would. */
    timelineBroken: false,
  },
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async () => state.users),
      count: vi.fn(async () => state.userCount),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const found = (state.users as Array<{ id: string }>).find((u) => u.id === where.id);
        return found ?? null;
      }),
    },
    message: {
      findMany: vi.fn(async () => state.mobileRows),
      groupBy: vi.fn(async () => state.mobileGroups),
    },
    chatEvent: {
      findMany: vi.fn(async () => {
        if (state.timelineBroken) throw new Error('relation "chat_events" does not exist');
        return state.timelineRows;
      }),
      groupBy: vi.fn(async () => {
        if (state.timelineBroken) throw new Error('relation "chat_events" does not exist');
        return state.timelineGroups;
      }),
    },
  },
}));

const { dialogsRouter } = await import("./dialogs.js");

const app = express();
app.use(dialogsRouter);

const USER_ID = "00000000-0000-0000-0000-000000000001";

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    telegramId: BigInt("123456789"),
    telegramUsername: "alice",
    firstName: "Alice",
    surname: "Smith",
    age: 21,
    gender: "female",
    language: "en",
    platform: "telegram",
    status: "active",
    onboardingStep: "completed",
    verificationStatus: "verified",
    registrationTrack: "student",
    createdAt: new Date("2026-04-01T10:00:00Z"),
    lastMessageAt: new Date("2026-07-20T12:00:00Z"),
    messageHistory: [
      { role: "system", content: "You are a matchmaker" },
      { role: "user", content: "Привет" },
      { role: "assistant", content: "Привет! Как тебя зовут?" },
    ],
    profile: { homeCity: "Kyiv", homeCityKey: "ua:kyiv", photos: ["file_1"] },
    ...overrides,
  };
}

beforeEach(() => {
  state.users = [makeUser()];
  state.userCount = 1;
  state.mobileRows = [];
  state.mobileGroups = [];
  state.timelineRows = [];
  state.timelineGroups = [];
  state.timelineBroken = false;
});

describe("GET /admin/dialogs", () => {
  it("returns dialogs with participant, counts and a preview", async () => {
    state.timelineGroups = [
      { userId: USER_ID, _count: { _all: 4 }, _max: { createdAt: new Date("2026-07-21T09:00:00Z") } },
    ];
    state.timelineRows = [
      {
        id: "ev-1",
        userId: USER_ID,
        direction: "out",
        kind: "text",
        surface: "menu",
        summary: "Твоя следующая подборка в четверг",
        actions: [{ label: "Открыть меню", data: "menu:open" }],
        matchId: null,
        createdAt: new Date("2026-07-21T09:00:00Z"),
      },
    ];

    const res = await request(app).get("/admin/dialogs");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.sources).toEqual({ agent: true, mobile: true, timeline: true });

    const dialog = res.body.data[0];
    expect(dialog.id).toBe(USER_ID);
    expect(dialog.participant.telegramId).toBe("123456789");
    expect(dialog.participant.displayName).toBe("Alice Smith");
    expect(dialog.participant.city).toBe("Kyiv");
    // 3 agent turns + 4 timeline events, no mobile-chat rows.
    expect(dialog.counts).toEqual({ total: 7, agent: 3, mobile: 0, timeline: 4 });
    expect(dialog.lastMessage.text).toBe("Твоя следующая подборка в четверг");
    expect(dialog.lastMessage.direction).toBe("out");
    // No messages array unless explicitly asked for.
    expect(dialog.messages).toBeUndefined();
  });

  it("falls back to the newest agent turn when nothing is timestamped", async () => {
    const res = await request(app).get("/admin/dialogs");

    expect(res.status).toBe(200);
    const dialog = res.body.data[0];
    // The trailing assistant turn — the system turn is technical and skipped.
    expect(dialog.lastMessage.text).toBe("Привет! Как тебя зовут?");
    expect(dialog.lastMessage.source).toBe("agent");
    expect(dialog.lastMessage.createdAt).toBeNull();
  });

  it("inlines messages with includeMessages=true", async () => {
    state.timelineGroups = [
      { userId: USER_ID, _count: { _all: 1 }, _max: { createdAt: new Date("2026-07-21T09:00:00Z") } },
    ];
    state.timelineRows = [
      {
        id: "ev-1",
        userId: USER_ID,
        direction: "in",
        kind: "callback_tap",
        surface: "match",
        summary: 'tapped "💫 Yes, I am going"',
        actions: null,
        matchId: "match-1",
        createdAt: new Date("2026-07-21T09:00:00Z"),
      },
    ];

    const res = await request(app).get("/admin/dialogs?includeMessages=true");

    expect(res.status).toBe(200);
    const { messages } = res.body.data[0];
    expect(Array.isArray(messages)).toBe(true);
    const tap = messages.at(-1);
    expect(tap.source).toBe("timeline");
    expect(tap.direction).toBe("in");
    expect(tap.kind).toBe("callback_tap");
    expect(tap.matchId).toBe("match-1");
  });

  it("degrades when the chat timeline table is unavailable", async () => {
    state.timelineBroken = true;

    const res = await request(app).get("/admin/dialogs");

    expect(res.status).toBe(200);
    expect(res.body.sources.timeline).toBe(false);
    // The other two stores still answer.
    expect(res.body.data[0].counts.agent).toBe(3);
    expect(res.body.data[0].counts.timeline).toBe(0);
  });

  it("rejects an unknown status filter", async () => {
    const res = await request(app).get("/admin/dialogs?status=nonsense");
    expect(res.status).toBe(400);
  });

  it("rejects a non-ISO activeSince", async () => {
    const res = await request(app).get("/admin/dialogs?activeSince=yesterday");
    expect(res.status).toBe(400);
  });

  it("clamps a hostile limit instead of passing it to Prisma", async () => {
    const res = await request(app).get("/admin/dialogs?limit=-5&offset=-3");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(0);
  });
});

describe("GET /admin/dialogs/:id", () => {
  it("returns a chronological transcript with technical turns hidden", async () => {
    state.mobileRows = [
      {
        id: "msg-1",
        role: "user",
        content: "Where is the date?",
        imageUrl: null,
        createdAt: new Date("2026-07-22T10:00:00Z"),
      },
    ];
    state.timelineRows = [
      {
        id: "ev-1",
        direction: "out",
        kind: "photo",
        surface: "match",
        summary: "Date card",
        actions: null,
        matchId: null,
        createdAt: new Date("2026-07-21T09:00:00Z"),
      },
    ];

    const res = await request(app).get(`/admin/dialogs/${USER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(USER_ID);
    expect(res.body.photos).toEqual([{ type: "photo", ref: "file_1" }]);

    const texts = res.body.messages.map((m: { text: string }) => m.text);
    // System turn dropped; agent block first, then timestamped rows in order.
    expect(texts).toEqual(["Привет", "Привет! Как тебя зовут?", "Date card", "Where is the date?"]);
  });

  it("keeps technical turns with includeTechnical=true", async () => {
    const res = await request(app).get(`/admin/dialogs/${USER_ID}?includeTechnical=true`);
    expect(res.status).toBe(200);
    expect(res.body.messages[0].role).toBe("system");
    expect(res.body.messages[0].technical).toBe(true);
  });

  it("reverses with order=desc", async () => {
    const res = await request(app).get(`/admin/dialogs/${USER_ID}?order=desc`);
    expect(res.status).toBe(200);
    expect(res.body.messages[0].text).toBe("Привет! Как тебя зовут?");
  });

  it("404s an unknown dialog", async () => {
    const res = await request(app).get("/admin/dialogs/00000000-0000-0000-0000-0000000000ff");
    expect(res.status).toBe(404);
  });

  it("rejects a bad order value", async () => {
    const res = await request(app).get(`/admin/dialogs/${USER_ID}?order=sideways`);
    expect(res.status).toBe(400);
  });
});

describe("timeline media", () => {
  it("hands the transcript refs it can render, tagged as Telegram media", async () => {
    state.timelineRows = [
      {
        id: "ev-photo",
        userId: USER_ID,
        direction: "in",
        kind: "user_media",
        surface: null,
        summary: "sent a photo",
        actions: null,
        media: [{ kind: "photo", ref: "AgACAgIAAx" }],
        matchId: null,
        createdAt: new Date("2026-07-21T09:00:00Z"),
      },
    ];

    const res = await request(app).get(`/admin/dialogs/${USER_ID}`);

    expect(res.status).toBe(200);
    const message = res.body.messages.find((m: { id: string }) => m.id === "ev-photo");
    expect(message.media).toEqual([
      { type: "telegram", kind: "photo", ref: "AgACAgIAAx" },
    ]);
  });

  it("keeps a ref-less attachment, so a voice note still reads as one", async () => {
    state.timelineRows = [
      {
        id: "ev-voice",
        userId: USER_ID,
        direction: "out",
        kind: "voice",
        surface: null,
        summary: "(voice note)",
        actions: null,
        media: [{ kind: "voice" }],
        matchId: null,
        createdAt: new Date("2026-07-21T09:00:00Z"),
      },
    ];

    const res = await request(app).get(`/admin/dialogs/${USER_ID}`);

    const message = res.body.messages.find((m: { id: string }) => m.id === "ev-voice");
    expect(message.media).toEqual([{ type: "telegram", kind: "voice" }]);
  });

  it("drops malformed media instead of shipping a half-shaped object", async () => {
    state.timelineRows = [
      {
        id: "ev-bad",
        userId: USER_ID,
        direction: "out",
        kind: "photo",
        surface: null,
        summary: "(photo card, no caption)",
        // Rows written before the column existed, or hand-edited in the DB.
        actions: null,
        media: [{ ref: "no-kind" }, null, "nonsense", { kind: 7 }],
        matchId: null,
        createdAt: new Date("2026-07-21T09:00:00Z"),
      },
    ];

    const res = await request(app).get(`/admin/dialogs/${USER_ID}`);

    const message = res.body.messages.find((m: { id: string }) => m.id === "ev-bad");
    expect(message.media).toBeUndefined();
  });
});
