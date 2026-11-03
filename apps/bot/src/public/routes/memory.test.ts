import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const LISTED = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const IDEA = "22222222-2222-4222-8222-222222222222";

const env = vi.hoisted(() => ({
  MEMORY_IDEAS_ENABLED: false,
  MEMORY_IDEAS_USER_IDS: [] as string[],
  JWT_SECRET: "test-jwt-secret-value-long-enough",
  BOT_TOKEN: "123456:test-bot-token",
  PUBLIC_BASE_URL: "https://api.example",
  LLM_TOKEN_BUDGET_ENABLED: false,
}));
vi.mock("../../config.js", () => ({ env }));
vi.mock("@gennety/db", () => ({ prisma: { user: { findUnique: async () => ({ language: "en" }) } } }));

const idea = { id: IDEA, usage: { ownDates: true }, reminder: { state: "on", dueAt: "2026-12-01T00:00:00.000Z" } };
const svc = vi.hoisted(() => {
  class MemoryIdeaError extends Error {
    constructor(readonly code: string, readonly status: number) {
      super(code);
    }
  }
  return { MemoryIdeaError, saveIdea: vi.fn(), deleteIdea: vi.fn(async () => undefined), removeSource: vi.fn(async () => ({ ideaDeleted: false })) };
});
vi.mock("../../services/memory-ideas.js", () => ({
  MemoryIdeaError: svc.MemoryIdeaError,
  saveIdea: svc.saveIdea,
  deleteIdea: svc.deleteIdea,
  removeSource: svc.removeSource,
  confirmPreference: vi.fn(), deletionScope: vi.fn(), getIdea: vi.fn(), listIdeas: vi.fn(async () => ({ items: [], nextBefore: null })),
  listPreferences: vi.fn(async () => []), mergeIdeas: vi.fn(), reasonQuestions: vi.fn(async () => []), revokePreference: vi.fn(),
  setIntent: vi.fn(), setOnlyForMe: vi.fn(), setPlace: vi.fn(), setPreferenceMatching: vi.fn(), setReason: vi.fn(), setUsage: vi.fn(),
  snoozeReason: vi.fn(), splitIdea: vi.fn(),
}));
const planning = vi.hoisted(() => ({ setReminder: vi.fn(), cancelReminder: vi.fn(async () => undefined) }));
vi.mock("../../services/memory-planning.js", () => ({
  setReminder: planning.setReminder,
  cancelReminder: planning.cancelReminder,
  dateMemo: vi.fn(), ideaMap: vi.fn(async () => ({ points: [], withoutPoint: [] })), pendingImpressions: vi.fn(async () => []),
  planningSuggestions: vi.fn(), recordImpression: vi.fn(), vibeQuestion: vi.fn(async () => null),
}));

const { createMemoryRouter } = await import("./memory.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

const app = () => express().use(express.json()).use("/v1/me/memory", createMemoryRouter());
const as = (id: string) => ({ Authorization: `Bearer ${jwt.sign({ sub: id, typ: "access" }, JWT_SECRET, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: "15m" })}` });

beforeEach(() => {
  vi.clearAllMocks();
  env.MEMORY_IDEAS_ENABLED = false;
  env.MEMORY_IDEAS_USER_IDS = [LISTED];
  svc.saveIdea.mockResolvedValue({ idea, created: true, candidates: [] });
  planning.setReminder.mockResolvedValue({ dueAt: idea.reminder.dueAt, idea, ownDatesTurnedOn: true });
});

describe("memory routes, per-user preview (decision 2026-11-03)", () => {
  it("a listed person saves an idea and turns a reminder on with the flag off", async () => {
    const saved = await request(app()).post("/v1/me/memory/ideas").set(as(LISTED)).send({ kind: "place", title: "Roof", quote: "хочу" });
    expect(saved.status).toBe(201);
    const reminder = await request(app()).put(`/v1/me/memory/ideas/${IDEA}/reminder`).set(as(LISTED));
    expect(reminder.status).toBe(200);
    expect(reminder.body).toMatchObject({ dueAt: idea.reminder.dueAt, ownDatesTurnedOn: true, idea: { usage: { ownDates: true }, reminder: { state: "on" } } });
  });

  it("anyone else gets feature-disabled for saving and reminders", async () => {
    expect((await request(app()).post("/v1/me/memory/ideas").set(as(OTHER)).send({ kind: "place", title: "Roof", quote: "хочу" })).status).toBe(404);
    expect((await request(app()).put(`/v1/me/memory/ideas/${IDEA}/reminder`).set(as(OTHER))).status).toBe(404);
    expect(svc.saveIdea).not.toHaveBeenCalled();
  });

  it("deleting stays open for anyone, and a repeat answers the same (item 5)", async () => {
    for (let i = 0; i < 2; i++) {
      expect((await request(app()).delete(`/v1/me/memory/ideas/${IDEA}`).set(as(OTHER))).status).toBe(204);
      expect((await request(app()).delete(`/v1/me/memory/ideas/${IDEA}/reminder`).set(as(OTHER))).status).toBe(204);
    }
  });
});
