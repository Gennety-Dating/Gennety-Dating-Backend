import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `/v1/chat` and place scenes (decision 2026-11-26): `place` on the text and
 * voice replies and on history rows — only for a build that sent `places`,
 * the photo link signed on every read, nothing for an older build; a reviews
 * board fetched again from Google on a history read (its text is never stored).
 */

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const env: Record<string, unknown> = { JWT_SECRET, OPENAI_API_KEY: "k", WISHLIST_FEATURE_ENABLED: false, AGENT_REACTIONS_ENABLED: false, PUBLIC_BASE_URL: "https://api.gennety.test", BOT_TOKEN: "t" };
vi.mock("../../config.js", () => ({ env }));
vi.mock("../../services/usage-limiter.js", () => ({
  usageLimiter: { isOverDailyBudget: () => false, isGlobalBudgetExceeded: () => false },
}));

let historyRows: unknown[] = [];
vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: async () => ({ status: "active", onboardingStep: "completed", suspendedUntil: null, language: "ru" }),
    },
    message: {
      findMany: async () => historyRows,
    },
  },
}));

type TurnInput = { chatCards?: ReadonlySet<string>; reactionsDrawn?: boolean };
let turnResult: Record<string, unknown> = {};
const runChatTurn = vi.fn(async (_input: TurnInput) => turnResult);
vi.mock("../../services/chat-agent.js", () => ({
  runChatTurn: (input: TurnInput) => runChatTurn(input),
}));
vi.mock("../../services/chat-topics.js", () => ({ listChatTopics: async () => ({ topics: [], hasMore: false }) }));
vi.mock("../../services/chat-sessions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../services/chat-sessions.js")>();
  return {
    parseChatSessionIdField: original.parseChatSessionIdField,
    normalizeChatSessionTitle: original.normalizeChatSessionTitle,
    claimChatSession: async () => true,
    ownsChatSession: async () => true,
    listChatSessions: async () => ({ sessions: [], hasMore: false }),
    updateChatSession: async () => null,
  };
});
vi.mock("../../services/storage.js", () => ({
  uploadChatImage: async () => ({ path: "p" }),
  createChatImageSignedUrl: async () => "https://signed.example/x",
  createChatImageSignedUrls: async (paths: string[]) => paths.map(() => "https://signed.example/x"),
}));
vi.mock("../../services/whisper.js", () => ({
  transcribeVoiceResult: async () => ({ ok: true, text: "ок, спасибо" }),
  WHISPER_MAX_BYTES: 25 * 1024 * 1024,
}));

const { chatRouter } = await import("./chat.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

/**
 * One server, bound to 127.0.0.1 explicitly. Handed a bare app, supertest
 * listens on the wildcard `::` and then connects to `127.0.0.1:<port>`; on
 * macOS another process (a parallel test run) may bind `127.0.0.1` on that
 * same port, and its socket wins — the request lands in a foreign app and
 * comes back 404 or without ever reaching `runChatTurn`. A specific bind
 * cannot be shadowed.
 */
let server: Server;
beforeAll(async () => {
  const a = express();
  a.use(express.json());
  a.use("/v1/chat", chatRouter);
  server = await new Promise<Server>((resolve) => {
    const s = a.listen(0, "127.0.0.1", () => resolve(s));
  });
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const app = () => server;
const auth = (sub = USER_ID) => ({
  Authorization: `Bearer ${jwt.sign({ sub, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  })}`,
});
const REPLY = {
  id: "m1",
  role: "assistant" as const,
  content: "Там тихо до восьми.",
  imageUrl: null,
  createdAt: new Date("2026-11-26T10:00:00Z"),
  sessionId: "s1",
  userMessageId: "u1",
};
const STORED = {
  kind: "place_scene",
  sceneKind: "venue",
  title: "Win Bar",
  subtitle: null,
  venues: [{
    id: "v1", name: "Win Bar", categoryLabel: "Бар", address: "Хрещатик 1", lat: 50.45, lng: 30.52, photoVenueId: "v1",
    rating: 4.6, ratingCount: 100, priceLevel: 2, openNow: true, hoursLabel: "до 23:00", today: [{ open: "12:00", close: "23:00" }],
    nowLocal: "18:00", walkMinutes: null, distanceM: null, reason: null, tags: [],
  }],
  anchors: [],
  dishes: [],
  links: [],
  versus: null,
  footnote: null,
};

/** `ChatPlaceScene`: the stored scene, its photo signed now, no internal id, no `versus` unless a duel. */
function expectView(place: { venues: Array<Record<string, unknown>> } & Record<string, unknown>) {
  expect(place).toMatchObject({ kind: "venue", title: "Win Bar", subtitle: null, anchors: [], dishes: [], links: [], footnote: null });
  expect(place.venues[0]).toMatchObject({ id: "v1", hoursLabel: "до 23:00", openNow: true, today: [{ open: "12:00", close: "23:00" }] });
  expect(place.venues[0]!.photoUrl).toMatch(/^https:\/\/api\.gennety\.test\/v1\/venues\/v1\/photo\?w=1200&e=\d+&sig=[0-9a-f]{24}$/);
  expect(place.venues[0]).not.toHaveProperty("photoVenueId");
  expect(place).not.toHaveProperty("versus");
  expect(place).not.toHaveProperty("sceneKind");
}

beforeEach(() => {
  historyRows = [];
  turnResult = REPLY;
  runChatTurn.mockClear();
});

describe("turn responses", () => {
  it("text: the scene rides `place`, the build's cards reach the turn", async () => {
    turnResult = { ...REPLY, place: STORED };
    const res = await request(app()).post("/v1/chat/message").set(auth()).set("X-Gennety-Chat-Cards", "vibe, places").send({ text: "куда?" });
    expect(res.status).toBe(200);
    expect([...runChatTurn.mock.calls[0]![0].chatCards!]).toEqual(["vibe", "places"]);
    expectView(res.body.place);
    expect(res.body.message).toMatchObject({ id: "m1" });
  });

  it("no scene: no field, never null", async () => {
    const res = await request(app()).post("/v1/chat/message").set(auth()).set("X-Gennety-Chat-Cards", "places").send({ text: "привет" });
    expect(res.body).not.toHaveProperty("place");
  });

  it("voice: the same", async () => {
    turnResult = { ...REPLY, place: STORED };
    const res = await request(app())
      .post("/v1/chat/voice")
      .set(auth())
      .set("X-Gennety-Chat-Cards", "places")
      .attach("file", Buffer.from("audio"), { filename: "v.m4a", contentType: "audio/m4a" });
    expect(res.status).toBe(200);
    expectView(res.body.place);
  });
});

describe("history", () => {
  beforeEach(() => {
    historyRows = [
      { id: "a1", role: "assistant", content: "Там тихо.", imageUrl: null, imageUrls: [], context: null, attachment: STORED, userReaction: null, agentReaction: null, createdAt: new Date("2026-11-26T10:00:00Z") },
      { id: "u1", role: "user", content: "куда?", imageUrl: null, imageUrls: [], context: null, attachment: null, userReaction: null, agentReaction: null, createdAt: new Date("2026-11-26T09:59:00Z") },
    ];
  });

  it("a build that sends `places`: the scene as shown, the photo signed now, no internal id", async () => {
    const res = await request(app()).get("/v1/chat/history").set(auth()).set("X-Gennety-Chat-Cards", "places");
    const a1 = res.body.messages.find((m: { id: string }) => m.id === "a1");
    expect(a1.place).toMatchObject({ kind: "venue", title: "Win Bar", venues: [{ id: "v1", hoursLabel: "до 23:00", openNow: true }] });
    expect(a1.place.venues[0].photoUrl).toMatch(/^https:\/\/api\.gennety\.test\/v1\/venues\/v1\/photo\?w=1200&e=\d+&sig=/);
    expect(a1.place.venues[0]).not.toHaveProperty("photoVenueId");
    expect(a1.place).not.toHaveProperty("versus");
    expect(res.body.messages.find((m: { id: string }) => m.id === "u1")).not.toHaveProperty("place");
  });

  it("an older build: no `place` (the text stays)", async () => {
    const res = await request(app()).get("/v1/chat/history").set(auth()).set("X-Gennety-Chat-Cards", "vibe, reactions");
    const a1 = res.body.messages.find((m: { id: string }) => m.id === "a1");
    expect(a1).not.toHaveProperty("place");
    expect(a1.content).toBe("Там тихо.");
  });
});

describe("reviews board", () => {
  const BOARD = [
    { author: "Olena Kovalenko", rating: 5, text: "Уютная веранда, приятно посидеть вечером. Вкусная кухня и хорошее вино.", when: "2 недели назад", source: "google", authorUri: "https://www.google.com/maps/contrib/1", authorPhotoUri: null, reviewUri: null, translated: false },
    { author: "Max", rating: 4, text: "Тихая музыка и отличный кофе, можно спокойно посидеть вдвоём и поговорить.", when: "месяц назад", source: "google", authorUri: null, authorPhotoUri: null, reviewUri: null, translated: false },
  ];
  const STORED_REVIEWS = { ...STORED, sceneKind: "reviews", reviews: [], reviewsFrom: { placeId: "ChIJ-veranda", language: "ru" }, footnote: "Отзывы из Google Maps." };
  const googleBody = {
    reviews: [
      { rating: 5, relativePublishTimeDescription: "неделю назад", publishTime: "2026-11-19T10:00:00Z", text: { text: "Прекрасное место, очень вкусная кухня и уютная атмосфера, хочется сидеть весь вечер.", languageCode: "ru" }, authorAttribution: { displayName: "Ira P" } },
      { rating: 4, relativePublishTimeDescription: "месяц назад", publishTime: "2026-10-20T10:00:00Z", text: { text: "Хороший вид на парк, тихая музыка и отличный кофе. Были вдвоём, понравилось.", languageCode: "ru" }, authorAttribution: { displayName: "Dmytro" } },
    ],
  };
  const row = (attachment: unknown) => [
    { id: "a1", role: "assistant", content: "Загляни.", imageUrl: null, imageUrls: [], context: null, attachment, userReaction: null, agentReaction: null, createdAt: new Date("2026-11-26T10:00:00Z") },
  ];

  it("the live reply carries the board as `reviews` (contract fields only)", async () => {
    turnResult = { ...REPLY, place: { ...STORED, sceneKind: "reviews", reviews: BOARD, footnote: "Отзывы из Google Maps." } };
    const res = await request(app()).post("/v1/chat/message").set(auth()).set("X-Gennety-Chat-Cards", "places").send({ text: "где поужинать?" });
    expect(res.body.place.kind).toBe("reviews");
    expect(res.body.place.reviews).toEqual([
      { author: "Olena Kovalenko", rating: 5, text: BOARD[0]!.text, when: "2 недели назад", source: "google" },
      { author: "Max", rating: 4, text: BOARD[1]!.text, when: "месяц назад", source: "google" },
    ]);
  });

  it("history: fetched again from Google in the stored language, never read from the row", async () => {
    process.env.PLACES_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(googleBody), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      historyRows = row({ ...STORED_REVIEWS, reviews: BOARD });
      const res = await request(app()).get("/v1/chat/history").set(auth()).set("X-Gennety-Chat-Cards", "places");
      const place = res.body.messages[0].place;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("https://places.googleapis.com/v1/places/ChIJ-veranda?languageCode=ru");
      expect(place.kind).toBe("reviews");
      expect(place.reviews.map((r: { author: string }) => r.author)).toEqual(["Ira P", "Dmytro"]);
      expect(JSON.stringify(place)).not.toContain("Olena");
    } finally {
      vi.unstubAllGlobals();
      delete process.env.PLACES_API_KEY;
    }
  });

  it("history: Google unavailable → drawn as the venue, no board, no notice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    process.env.PLACES_API_KEY = "test-key";
    try {
      historyRows = row(STORED_REVIEWS);
      const res = await request(app()).get("/v1/chat/history").set(auth()).set("X-Gennety-Chat-Cards", "places");
      const place = res.body.messages[0].place;
      expect(place).toMatchObject({ kind: "venue", dishes: [], footnote: null });
      expect(place).not.toHaveProperty("reviews");
    } finally {
      vi.unstubAllGlobals();
      delete process.env.PLACES_API_KEY;
    }
  });
});
