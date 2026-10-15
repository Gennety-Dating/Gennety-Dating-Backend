import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { profilerQuestionBank, profilerQuestionById, profilerQuestionText } from "@gennety/shared";

const USER_ID = "11111111-1111-1111-1111-111111111111";

const userFindUnique = vi.fn();
const profileFindUnique = vi.fn();
const profileUpdate = vi.fn();
const profileUpdateMany = vi.fn();
const answerFindMany = vi.fn();
const answerFindUnique = vi.fn();
const answerUpsert = vi.fn();
const answerCount = vi.fn();
const matchFindFirst = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    profile: {
      findUnique: (...a: unknown[]) => profileFindUnique(...a),
      update: (...a: unknown[]) => profileUpdate(...a),
      updateMany: (...a: unknown[]) => profileUpdateMany(...a),
    },
    profilerAnswer: {
      findMany: (...a: unknown[]) => answerFindMany(...a),
      findUnique: (...a: unknown[]) => answerFindUnique(...a),
      upsert: (...a: unknown[]) => answerUpsert(...a),
      count: (...a: unknown[]) => answerCount(...a),
    },
    match: { findFirst: (...a: unknown[]) => matchFindFirst(...a) },
  },
}));

vi.mock("../auth-middleware.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.userId = USER_ID;
    next();
  },
}));

vi.mock("../rate-limit.js", () => ({
  voiceLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../services/next-batch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/next-batch.js")>()),
  getNextBatchDate: () => new Date("2026-06-20T07:00:00Z"),
}));

vi.mock("../../services/profiler-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/profiler-context.js")>()),
  loadProfilerContextSignals: async () => ({
    upcomingDates: [],
    attendedDates: [],
    signatureExperience: null,
  }),
}));

vi.mock("../../services/main-bot-api.js", () => ({ getMainBotApi: () => null }));

const { createNativeProfilerRouter } = await import("./profiler-native.js");

const NOW = new Date("2026-06-10T07:00:00.000Z");
const FEMALE = profilerQuestionBank("female").map((q) => q.id);
const PLAIN = FEMALE.find((id) => id !== "f_humor")!;
const MEME = "f_humor";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 2),
]);
const HEIC = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypheic", "latin1"),
  Buffer.alloc(64, 0),
]);
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ", "latin1"), Buffer.alloc(64)]);

const deps = {
  transcribe: vi.fn(),
  readMeme: vi.fn(),
  readPhoto: vi.fn(),
  storeImage: vi.fn(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/me/profiler", createNativeProfilerRouter(deps));
  return app;
}

function stateUser(batchRemaining: number, answers: Array<Record<string, unknown>>) {
  return {
    id: USER_ID,
    telegramId: -5n,
    gender: "female",
    language: "en",
    profile: { timeZone: "Europe/Kyiv", profilerBatchRemaining: batchRemaining, profilerActiveQuestionId: null },
    profilerAnswers: answers,
  };
}

/** The live question is `questionId`; the user is otherwise mid-batch. */
function live(questionId: string): void {
  profileFindUnique.mockResolvedValue({ profilerActiveQuestionId: questionId, profilerQuestionMessageId: null });
  userFindUnique.mockResolvedValue(
    stateUser(0, [{ questionId, answerText: "x", skipped: false, skipReturned: false, cycleId: "2026-W24" }]),
  );
}

function storedText(): string {
  const upsert = answerUpsert.mock.calls[0]![0] as { create: { answerText: string; answerSource: string } };
  return upsert.create.answerText;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  userFindUnique.mockReset();
  profileFindUnique.mockReset().mockResolvedValue({ profilerQuestionMessageId: null });
  profileUpdate.mockReset().mockResolvedValue({});
  profileUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  answerFindMany.mockReset().mockResolvedValue([]);
  answerFindUnique.mockReset().mockResolvedValue(null);
  answerUpsert.mockReset().mockResolvedValue({});
  answerCount.mockReset().mockResolvedValue(0);
  matchFindFirst.mockReset().mockResolvedValue(null);
  deps.transcribe.mockReset().mockResolvedValue({ ok: true, text: "a rooftop bar at sunset" });
  deps.readMeme.mockReset().mockResolvedValue({ ok: true, description: "Drake meme about Mondays, dry humour.", model: "m" });
  deps.readPhoto.mockReset().mockResolvedValue({ ok: true, description: "A candle-lit wine bar with a view.", model: "m" });
  deps.storeImage.mockReset().mockResolvedValue({ path: `${USER_ID}/1.jpg` });
});

describe("POST /v1/me/profiler/answer/media", () => {
  it("records a voice answer as its transcript", async () => {
    live(PLAIN);
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer/media")
      .field("questionId", PLAIN)
      .attach("voice", M4A, { filename: "a.m4a", contentType: "audio/mp4" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: "done" });
    expect(deps.transcribe).toHaveBeenCalledWith(expect.any(Buffer), { mime: "audio/mp4", language: "en" });
    expect(storedText()).toBe("a rooftop bar at sunset");
    expect((answerUpsert.mock.calls[0]![0] as { create: { answerSource: string } }).create.answerSource).toBe("text");
  });

  it("422s a voice note that transcribes to nothing and records nothing", async () => {
    live(PLAIN);
    deps.transcribe.mockResolvedValue({ ok: true, text: "  " });
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer/media")
      .field("questionId", PLAIN)
      .attach("voice", M4A, { filename: "a.m4a", contentType: "audio/mp4" });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "not_heard" });
    expect(profileUpdateMany).not.toHaveBeenCalled();
    expect(answerUpsert).not.toHaveBeenCalled();
  });

  it("503s when transcription is down", async () => {
    live(PLAIN);
    deps.transcribe.mockResolvedValue({ ok: false, reason: "unavailable" });
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer/media")
      .field("questionId", PLAIN)
      .attach("voice", M4A, { filename: "a.m4a", contentType: "audio/mp4" });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "transcription_unavailable" });
    expect(answerUpsert).not.toHaveBeenCalled();
  });

  it("reads a meme question's photo with the meme reader and stores the description", async () => {
    live(MEME);
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer/media")
      .field("questionId", MEME)
      .attach("images", JPEG, { filename: "m.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(deps.readMeme).toHaveBeenCalledWith(
      { buffer: expect.any(Buffer), mime: "image/jpeg" },
      { language: "en", caption: undefined },
    );
    expect(deps.readPhoto).not.toHaveBeenCalled();
    // Photo-only: the bare description, the Telegram meme path's form.
    expect(storedText()).toBe("Drake meme about Mondays, dry humour.");
    // No Telegram pointer — meme reveal re-sends file_ids only.
    expect((answerUpsert.mock.calls[0]![0] as { create: Record<string, unknown> }).create.memeFileId).toBeNull();
    expect(deps.storeImage).toHaveBeenCalledWith(USER_ID, expect.any(Buffer), "image/jpeg");
  });

  it("reads any other question's photo against the question, after the person's words", async () => {
    live(PLAIN);
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer/media")
      .field("questionId", PLAIN)
      .field("text", "  somewhere like this  ")
      .attach("images", PNG, { filename: "p.png", contentType: "application/octet-stream" });

    expect(res.status).toBe(200);
    expect(deps.readPhoto).toHaveBeenCalledWith(
      { buffer: expect.any(Buffer), mime: "image/png" },
      {
        language: "en",
        questionText: profilerQuestionText(profilerQuestionById(PLAIN)!, "en"),
        caption: "somewhere like this",
      },
    );
    expect(deps.readMeme).not.toHaveBeenCalled();
    expect(storedText()).toBe("somewhere like this\n\nPhoto: A candle-lit wine bar with a view.");
    expect(deps.storeImage).toHaveBeenCalledTimes(1);
  });

  it("422s when every photo is refused and nothing else was said, keeping the question live", async () => {
    live(PLAIN);
    deps.readPhoto.mockResolvedValue({ ok: false, error: "unsafe" });
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer/media")
      .field("questionId", PLAIN)
      .attach("images", JPEG, { filename: "a.jpg" })
      .attach("images", PNG, { filename: "b.png" });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "image_unreadable" });
    expect(deps.readPhoto).toHaveBeenCalledTimes(2);
    expect(profileUpdateMany).not.toHaveBeenCalled();
    expect(deps.storeImage).not.toHaveBeenCalled();
  });

  it("skips a refused photo beside words and stores neither it nor its description", async () => {
    live(PLAIN);
    deps.readPhoto.mockResolvedValue({ ok: false, error: "unsafe" });
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer/media")
      .field("questionId", PLAIN)
      .field("text", "a quiet bar")
      .attach("images", JPEG, { filename: "a.jpg" });

    expect(res.status).toBe(200);
    expect(storedText()).toBe("a quiet bar");
    expect(deps.storeImage).not.toHaveBeenCalled();
  });

  it("400s a request without any media", async () => {
    live(PLAIN);
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer/media")
      .field("questionId", PLAIN)
      .field("text", "just words");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "missing_media" });
  });

  it("415s a HEIC photo before any paid call", async () => {
    live(PLAIN);
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer/media")
      .field("questionId", PLAIN)
      .attach("images", HEIC, { filename: "a.heic" });

    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: "unsupported_image" });
    expect(deps.readPhoto).not.toHaveBeenCalled();
  });

  it("413s a photo over the profiler image cap", async () => {
    live(PLAIN);
    const big = Buffer.concat([JPEG, Buffer.alloc(6 * 1024 * 1024)]);
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer/media")
      .field("questionId", PLAIN)
      .attach("images", big, { filename: "a.jpg" });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "image_too_large" });
  });

  it("409s a question that is not live without transcribing or reading anything", async () => {
    profileFindUnique.mockResolvedValue({ profilerActiveQuestionId: FEMALE[2], profilerQuestionMessageId: null });
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer/media")
      .field("questionId", PLAIN)
      .attach("voice", M4A, { filename: "a.m4a" })
      .attach("images", JPEG, { filename: "a.jpg" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "question_not_active" });
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.readPhoto).not.toHaveBeenCalled();
    expect(answerUpsert).not.toHaveBeenCalled();
  });

  it("409s a lost claim race and keeps no photo", async () => {
    live(PLAIN);
    profileUpdateMany.mockResolvedValue({ count: 0 });
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer/media")
      .field("questionId", PLAIN)
      .attach("images", JPEG, { filename: "a.jpg" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "question_not_active" });
    expect(deps.storeImage).not.toHaveBeenCalled();
  });

  it("accepts option ids as a JSON array string beside the media", async () => {
    live(PLAIN);
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer/media")
      .field("questionId", PLAIN)
      .field("optionIds", JSON.stringify(["nope"]))
      .attach("voice", M4A, { filename: "a.m4a" });

    // An unknown option is the client's bug, same as `/answer`.
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "unknown_option" });
    expect(answerUpsert).not.toHaveBeenCalled();
  });
});
