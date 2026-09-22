import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  PROFILER_STALL_TIMEOUT_MS,
  profilerQuestionBank,
  profilerQuestionById,
  profilerQuestionText,
} from "@gennety/shared";

const USER_ID = "11111111-1111-1111-1111-111111111111";

const userFindUnique = vi.fn();
const profileFindUnique = vi.fn();
const profileUpdate = vi.fn();
const profileUpdateMany = vi.fn();
const answerFindMany = vi.fn();
const answerFindUnique = vi.fn();
const answerUpsert = vi.fn();
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

// Rush mode keys on the next drop; pin it so batch size is deterministic.
const nextDrop = { at: new Date("2026-06-20T07:00:00Z") };
vi.mock("../../services/next-batch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/next-batch.js")>()),
  getNextBatchDate: () => nextDrop.at,
}));

const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);
const botApi: { current: unknown } = { current: null };
vi.mock("../../services/main-bot-api.js", () => ({
  getMainBotApi: () => botApi.current,
}));

const { createNativeProfilerRouter } = await import("./profiler-native.js");

// 10:00 in Kyiv — outside quiet hours; the next local window is 18:00 Kyiv.
const NOW = new Date("2026-06-10T07:00:00.000Z");
const NEXT_WINDOW = new Date("2026-06-10T15:00:00.000Z");
const FEMALE = profilerQuestionBank("female").map((q) => q.id);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/me/profiler", createNativeProfilerRouter());
  return app;
}

function text(id: string, lang: "en" | "ru" = "en"): string {
  return profilerQuestionText(profilerQuestionById(id)!, lang);
}

/** The `GET` read: eligibility + scheduler columns. */
function getUser(profile: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    status: "active",
    onboardingStep: "completed",
    gender: "female",
    language: "en",
    profile: {
      timeZone: "Europe/Kyiv",
      profilerStartedAt: null,
      profilerNextAt: null,
      profilerActiveQuestionId: null,
      profilerBatchRemaining: 0,
      ...profile,
    },
    ...over,
  };
}

/** The `loadProfilerState` read the answer path makes after recording. */
function stateUser(batchRemaining: number, answers: Array<Record<string, unknown>>) {
  return {
    id: USER_ID,
    telegramId: -5n,
    gender: "female",
    language: "en",
    profile: {
      timeZone: "Europe/Kyiv",
      profilerBatchRemaining: batchRemaining,
      profilerActiveQuestionId: null,
    },
    profilerAnswers: answers,
  };
}

function answered(questionId: string) {
  return { questionId, answerText: "x", skipped: false, skipReturned: false, cycleId: "2026-W24" };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nextDrop.at = new Date("2026-06-20T07:00:00Z");
  botApi.current = null;
  userFindUnique.mockReset();
  profileFindUnique.mockReset().mockResolvedValue({ profilerQuestionMessageId: null });
  profileUpdate.mockReset().mockResolvedValue({});
  profileUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  answerFindMany.mockReset().mockResolvedValue([]);
  answerFindUnique.mockReset().mockResolvedValue(null);
  answerUpsert.mockReset().mockResolvedValue({});
  matchFindFirst.mockReset().mockResolvedValue(null);
  editMessageReplyMarkup.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /v1/me/profiler", () => {
  it("answers {} and writes nothing when no batch is due", async () => {
    userFindUnique.mockResolvedValue(
      getUser({ profilerStartedAt: NOW, profilerNextAt: new Date(NOW.getTime() + 60_000) }),
    );

    const res = await request(buildApp()).get("/v1/me/profiler");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(profileUpdateMany).not.toHaveBeenCalled();
    expect(profileUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["status is not active", { status: "paused" }],
    ["onboarding is not finished", { onboardingStep: "conversational" }],
    ["gender is unknown", { gender: null }],
  ])("answers {} when %s", async (_label, over) => {
    userFindUnique.mockResolvedValue(getUser({ profilerActiveQuestionId: "f_date_spots" }, over));

    const res = await request(buildApp()).get("/v1/me/profiler");

    expect(res.body).toEqual({});
    expect(profileUpdateMany).not.toHaveBeenCalled();
  });

  it("resumes the live question in the user's language, remaining counting it", async () => {
    userFindUnique.mockResolvedValue(
      getUser(
        {
          profilerActiveQuestionId: "f_turnoffs",
          profilerBatchRemaining: 1,
          profilerNextAt: new Date(NOW.getTime() - 60_000),
        },
        { language: "ru" },
      ),
    );

    const res = await request(buildApp()).get("/v1/me/profiler");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      question: { id: "f_turnoffs", text: text("f_turnoffs", "ru") },
      remaining: 2,
    });
    // Resuming never re-opens or re-times anything — even past the deadline.
    expect(profileUpdateMany).not.toHaveBeenCalled();
    expect(profileUpdate).not.toHaveBeenCalled();
  });

  it("opens a batch at once for a user the Profiler was never armed for", async () => {
    userFindUnique.mockResolvedValue(getUser());

    const res = await request(buildApp()).get("/v1/me/profiler");

    expect(res.body).toEqual({
      question: { id: FEMALE[0], text: text(FEMALE[0]!) },
      remaining: 3,
    });
    expect(profileUpdateMany).toHaveBeenCalledTimes(1);
    const call = profileUpdateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Compare-and-set on exactly what was read, so the worker or a parallel
    // request cannot open a second batch.
    expect(call.where).toEqual({
      userId: USER_ID,
      profilerActiveQuestionId: null,
      profilerNextAt: null,
    });
    expect(call.data).toEqual({
      profilerStartedAt: NOW,
      profilerActiveQuestionId: FEMALE[0],
      // Same convention as the worker: the stored counter excludes the live one.
      profilerBatchRemaining: 2,
      profilerAnswerWindowUntil: null,
      profilerQuestionMessageId: null,
      profilerNextAt: new Date(NOW.getTime() + PROFILER_STALL_TIMEOUT_MS),
    });
  });

  it("opens a batch whose window has passed, keeping the original start", async () => {
    const started = new Date("2026-06-01T10:00:00Z");
    const due = new Date(NOW.getTime() - 1000);
    userFindUnique.mockResolvedValue(getUser({ profilerStartedAt: started, profilerNextAt: due }));
    answerFindMany.mockResolvedValue([answered(FEMALE[0]!)]);

    const res = await request(buildApp()).get("/v1/me/profiler");

    expect(res.body.question.id).toBe(FEMALE[1]);
    const call = profileUpdateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where.profilerNextAt).toEqual(due);
    expect(call.data.profilerStartedAt).toEqual(started);
  });

  it("shrinks the batch to the rush size when a drop is imminent", async () => {
    nextDrop.at = new Date(NOW.getTime() + 60 * 60 * 1000);
    userFindUnique.mockResolvedValue(getUser());

    const res = await request(buildApp()).get("/v1/me/profiler");

    expect(res.body.remaining).toBe(2);
    const data = profileUpdateMany.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.profilerBatchRemaining).toBe(1);
  });

  it("holds a due batch while the user is mid date-negotiation", async () => {
    userFindUnique.mockResolvedValue(getUser());
    matchFindFirst.mockResolvedValue({ id: "m1" });

    const res = await request(buildApp()).get("/v1/me/profiler");

    expect(res.body).toEqual({});
    expect(profileUpdateMany).not.toHaveBeenCalled();
    const where = matchFindFirst.mock.calls[0]![0].where as { status: { in: string[] } };
    expect(where.status.in).toEqual(["proposed", "negotiating", "negotiating_venue"]);
  });

  it("reports the winner's question after losing the open race", async () => {
    userFindUnique.mockResolvedValue(getUser());
    profileUpdateMany.mockResolvedValue({ count: 0 });
    profileFindUnique.mockResolvedValue({
      profilerActiveQuestionId: FEMALE[0],
      profilerBatchRemaining: 2,
    });

    const res = await request(buildApp()).get("/v1/me/profiler");

    expect(res.body).toEqual({ question: { id: FEMALE[0], text: text(FEMALE[0]!) }, remaining: 3 });
  });

  it("parks an exhausted bank at the next local window", async () => {
    userFindUnique.mockResolvedValue(getUser({ profilerStartedAt: NOW }));
    // Everything answered this cycle — including the refreshable ones.
    answerFindMany.mockResolvedValue(
      FEMALE.map((id) => ({ ...answered(id), cycleId: "2026-W24" })),
    );

    const res = await request(buildApp()).get("/v1/me/profiler");

    expect(res.body).toEqual({});
    const call = profileUpdateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({
      profilerStartedAt: NOW,
      profilerBatchRemaining: 0,
      profilerNextAt: NEXT_WINDOW,
    });
  });

  it("releases a live id the bank no longer knows instead of stranding the user", async () => {
    userFindUnique.mockResolvedValue(getUser({ profilerActiveQuestionId: "f_activity_pref" }));

    const res = await request(buildApp()).get("/v1/me/profiler");

    expect(res.body).toEqual({});
    expect(profileUpdateMany.mock.calls[0]![0]).toEqual({
      where: { userId: USER_ID, profilerActiveQuestionId: "f_activity_pref" },
      data: {
        profilerActiveQuestionId: null,
        profilerAnswerWindowUntil: null,
        profilerQuestionMessageId: null,
      },
    });
  });
});

describe("POST /v1/me/profiler/answer", () => {
  it("records the answer like Telegram does and returns the next question", async () => {
    userFindUnique.mockResolvedValue(stateUser(2, [answered(FEMALE[0]!)]));

    const res = await request(buildApp())
      .post("/v1/me/profiler/answer")
      .send({ questionId: FEMALE[0], text: "  wine bar, then a walk  " });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: "next",
      question: { id: FEMALE[1], text: text(FEMALE[1]!) },
      remaining: 2,
    });
    // The claim is the same compare-and-set the chat uses.
    expect(profileUpdateMany.mock.calls[0]![0]).toEqual({
      where: { userId: USER_ID, profilerActiveQuestionId: FEMALE[0] },
      data: {
        profilerActiveQuestionId: null,
        profilerAnswerWindowUntil: null,
        profilerQuestionMessageId: null,
      },
    });
    const upsert = answerUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(upsert.update).toEqual({
      answerText: "wine bar, then a walk",
      answeredAt: NOW,
      skipped: false,
      skipReturned: false,
      cycleId: "2026-W24",
      memeFileId: null,
      memeKind: null,
      memeSourceUrl: null,
    });
    expect(profileUpdate.mock.calls[0]![0]).toEqual({
      where: { userId: USER_ID },
      data: {
        profilerActiveQuestionId: FEMALE[1],
        profilerBatchRemaining: 1,
        profilerAnswerWindowUntil: null,
        profilerQuestionMessageId: null,
        profilerNextAt: new Date(NOW.getTime() + PROFILER_STALL_TIMEOUT_MS),
      },
    });
  });

  it("caps an over-long answer at PROFILER_MAX_ANSWER_LEN", async () => {
    userFindUnique.mockResolvedValue(stateUser(1, [answered(FEMALE[0]!)]));

    await request(buildApp())
      .post("/v1/me/profiler/answer")
      .send({ questionId: FEMALE[0], text: "a".repeat(1500) });

    const upsert = answerUpsert.mock.calls[0]![0] as { create: { answerText: string } };
    expect(upsert.create.answerText).toHaveLength(1000);
  });

  it("finishes the batch on its last question and parks it at the next window", async () => {
    userFindUnique.mockResolvedValue(stateUser(0, [answered(FEMALE[0]!), answered(FEMALE[1]!)]));

    const res = await request(buildApp())
      .post("/v1/me/profiler/answer")
      .send({ questionId: FEMALE[1], text: "texting" });

    expect(res.body).toEqual({ outcome: "done" });
    expect(profileUpdate.mock.calls[0]![0]).toEqual({
      where: { userId: USER_ID },
      data: {
        profilerActiveQuestionId: null,
        profilerAnswerWindowUntil: null,
        profilerQuestionMessageId: null,
        profilerBatchRemaining: 0,
        profilerNextAt: NEXT_WINDOW,
      },
    });
  });

  it("records a Skip with the return-once transition and advances", async () => {
    userFindUnique.mockResolvedValue(
      stateUser(2, [{ ...answered(FEMALE[0]!), answerText: null, skipped: true }]),
    );

    const res = await request(buildApp())
      .post("/v1/me/profiler/answer")
      .send({ questionId: FEMALE[0], skip: true, text: "ignored" });

    expect(res.body.outcome).toBe("next");
    expect(res.body.question.id).toBe(FEMALE[1]);
    const upsert = answerUpsert.mock.calls[0]![0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(upsert.create).toMatchObject({ answerText: null, skipped: true, skipReturned: false });
    expect(upsert.update).toEqual({ skipped: true, skipReturned: false, cycleId: "2026-W24" });
  });

  it("treats a typed refusal as a skip and pauses the rest of the batch", async () => {
    userFindUnique.mockResolvedValue(stateUser(2, []));

    const res = await request(buildApp())
      .post("/v1/me/profiler/answer")
      .send({ questionId: FEMALE[0], text: "Не хочу." });

    expect(res.body).toEqual({ outcome: "paused" });
    const upsert = answerUpsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    // Never stored as an answer — it would burn the question and feed the
    // icebreaker generator "не хочу" as an interest.
    expect(upsert.create).toMatchObject({ answerText: null, skipped: true });
    expect(profileUpdate.mock.calls[0]![0].data).toEqual({
      profilerActiveQuestionId: null,
      profilerAnswerWindowUntil: null,
      profilerQuestionMessageId: null,
      profilerBatchRemaining: 0,
      profilerNextAt: NEXT_WINDOW,
    });
  });

  it("keeps the answer but pauses the batch when a negotiation started mid-batch", async () => {
    userFindUnique.mockResolvedValue(stateUser(2, [answered(FEMALE[0]!)]));
    matchFindFirst.mockResolvedValue({ id: "m1" });

    const res = await request(buildApp())
      .post("/v1/me/profiler/answer")
      .send({ questionId: FEMALE[0], text: "cinema" });

    expect(res.body).toEqual({ outcome: "done" });
    expect(answerUpsert).toHaveBeenCalledTimes(1);
    expect(profileUpdate.mock.calls[0]![0].data).toMatchObject({
      profilerActiveQuestionId: null,
      profilerNextAt: NEXT_WINDOW,
    });
  });

  it("409s a question that is not the live one and records nothing", async () => {
    profileUpdateMany.mockResolvedValue({ count: 0 });

    const res = await request(buildApp())
      .post("/v1/me/profiler/answer")
      .send({ questionId: FEMALE[2], text: "night owl" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "question_not_active" });
    expect(answerUpsert).not.toHaveBeenCalled();
    expect(profileUpdate).not.toHaveBeenCalled();
  });

  it("409s an id the bank does not know without claiming anything", async () => {
    const res = await request(buildApp())
      .post("/v1/me/profiler/answer")
      .send({ questionId: "nope", text: "x" });

    expect(res.status).toBe(409);
    expect(profileUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty body", {}, "missing_question_id"],
    ["no answer and no skip", { questionId: "f_date_spots" }, "empty_answer"],
    ["a blank answer", { questionId: "f_date_spots", text: "   " }, "empty_answer"],
    ["skip that is not true", { questionId: "f_date_spots", skip: "yes" }, "empty_answer"],
  ])("400s %s", async (_label, body, error) => {
    const res = await request(buildApp()).post("/v1/me/profiler/answer").send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expect(profileUpdateMany).not.toHaveBeenCalled();
  });

  it("strips the Skip button of a question the bot had sent to Telegram", async () => {
    botApi.current = { editMessageReplyMarkup };
    profileFindUnique.mockResolvedValue({ profilerQuestionMessageId: 77 });
    userFindUnique.mockResolvedValue({
      ...stateUser(2, [answered(FEMALE[0]!)]),
      telegramId: 12345n,
    });

    const res = await request(buildApp())
      .post("/v1/me/profiler/answer")
      .send({ questionId: FEMALE[0], text: "a rooftop" });

    expect(res.body.outcome).toBe("next");
    expect(editMessageReplyMarkup).toHaveBeenCalledWith(12345, 77);
  });
});
