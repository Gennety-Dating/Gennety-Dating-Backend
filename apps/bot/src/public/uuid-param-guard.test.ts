import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `:id` on `/v1/matches/*` must never reach Prisma unless it is a UUID.
 *
 * `Match.id` is a `@db.Uuid`, so a non-UUID does not read as "no such match" —
 * Prisma throws `P2023` ("Error creating UUID"), and this router has no catch,
 * so the answer was `500 Internal server error` plus a stack trace in the log
 * for what is only ever a caller's typo. The admin surface has guarded this
 * since `admin/utils/uuid.ts`; the public one had eight private copies of the
 * regex and none of them here.
 *
 * The assertion that matters is that the SERVICE is never reached: a 404 alone
 * would also be produced by a service that looked the id up and found nothing.
 */

const applyMatchDecision = vi.fn();
const getCurrentMatchForUser = vi.fn();
const countPartnerPhotos = vi.fn();
const getVenueIntentState = vi.fn();

vi.mock("../public/matches-service.js", () => ({
  applyMatchDecision,
  getCurrentMatchForUser,
  submitVibeLocation: vi.fn(),
  acknowledgeSafetyBrief: vi.fn(),
  submitMatchReport: vi.fn(),
}));
vi.mock("./matches-service.js", () => ({
  applyMatchDecision,
  getCurrentMatchForUser,
  submitVibeLocation: vi.fn(),
  acknowledgeSafetyBrief: vi.fn(),
  submitMatchReport: vi.fn(),
}));
vi.mock("./partner-photos.js", () => ({
  countPartnerPhotos,
  partnerPhotoUrls: vi.fn(() => []),
}));
vi.mock("../services/venue-intent-v2.js", () => ({
  confirmVenueIntent: vi.fn(),
  getVenueIntentState,
  interpretVenueIntent: vi.fn(),
  venueIntentMode: vi.fn(() => "v2"),
}));
vi.mock("../services/user-block.js", () => ({ blockMatchPartner: vi.fn() }));
vi.mock("../services/decision-intent.js", () => ({ classifyMatchDecisionForUser: vi.fn() }));
vi.mock("../services/emergency-cancel.js", () => ({
  cancelScheduledDate: vi.fn(),
  EMERGENCY_REASON_MAX_LENGTH: 500,
}));
vi.mock("../services/venue-origin.js", () => ({
  assertDepartureOrigin: vi.fn(async () => ({ ok: true })),
  isVenueOriginRefusal: vi.fn(() => false),
  venueOriginRefusal: vi.fn(),
}));
vi.mock("../services/date-vibe.js", () => ({ recordDateVibe: vi.fn() }));
vi.mock("./server.js", () => ({ getBotApi: vi.fn(() => null) }));
vi.mock("./auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = "11111111-1111-4111-8111-111111111111";
    next();
  },
}));
vi.mock("./rate-limit.js", () => ({
  agentTextLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { matchesRouter } = await import("./routes/matches.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/matches", matchesRouter);
  return app;
}

const MALFORMED = ["not-a-uuid", "1", "..", "%2e%2e", "00000000-0000-0000-0000-00000000000"];

beforeEach(() => {
  applyMatchDecision.mockReset().mockResolvedValue(null);
  countPartnerPhotos.mockReset().mockResolvedValue(null);
  getVenueIntentState.mockReset().mockResolvedValue(null);
  getCurrentMatchForUser.mockReset().mockResolvedValue(null);
});

describe("/v1/matches/:id — UUID shape guard", () => {
  it("404s a malformed id without calling the service", async () => {
    for (const id of MALFORMED) {
      const res = await request(buildApp())
        .post(`/v1/matches/${id}/decision`)
        .send({ decision: "accept" });
      expect(res.status, id).toBe(404);
    }
    expect(applyMatchDecision).not.toHaveBeenCalled();
  });

  it("guards the GET routes too", async () => {
    const app = buildApp();
    await request(app).get("/v1/matches/nope/partner-photos").expect(404);
    await request(app).get("/v1/matches/nope/venue-intent").expect(404);
    expect(countPartnerPhotos).not.toHaveBeenCalled();
    expect(getVenueIntentState).not.toHaveBeenCalled();
  });

  it("leaves the sibling /current route alone — it declares no :id", async () => {
    const res = await request(buildApp()).get("/v1/matches/current");
    expect(res.status).toBe(200);
    expect(getCurrentMatchForUser).toHaveBeenCalledTimes(1);
  });

  it("lets a well-formed id through to the service", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    await request(buildApp()).post(`/v1/matches/${id}/decision`).send({ decision: "accept" });
    expect(applyMatchDecision).toHaveBeenCalledWith(
      id,
      "11111111-1111-4111-8111-111111111111",
      "accept",
      // A decline may carry an explanation; an accept never does.
      undefined,
    );
  });
});
