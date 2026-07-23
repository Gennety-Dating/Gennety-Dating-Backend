import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WeeklyMatchesReport } from "../../services/weekly-matches-report.js";

const TOKEN = "a".repeat(32);

const founderReportFindUnique = vi.fn();
const downloadProfileImage = vi.fn();
const getMainBotApi = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    founderReport: { findUnique: founderReportFindUnique },
  },
}));

vi.mock("../../services/storage.js", () => ({
  downloadProfileImage: (...args: unknown[]) => downloadProfileImage(...args),
}));

vi.mock("../../services/main-bot-api.js", () => ({
  getMainBotApi: (...args: unknown[]) => getMainBotApi(...args),
}));

const { founderReportRouter } = await import("./founder-report.js");

function buildApp() {
  const app = express();
  app.use("/v1/founder", founderReportRouter);
  return app;
}

function reportRow(refs: string[]) {
  const report: WeeklyMatchesReport = {
    pairs: [
      {
        matchId: "m1",
        status: "scheduled",
        synergyScore: 88,
        synergyReason: "great fit",
        createdAtIso: new Date().toISOString(),
        users: [
          {
            userId: "u1",
            firstName: "Alice",
            age: 24,
            gender: "female",
            city: "Kyiv",
            verificationStatus: "verified",
            attractiveness: 70,
            photoRefs: [refs[0]!],
          },
          {
            userId: "u2",
            firstName: "Bob",
            age: 26,
            gender: "male",
            city: "Kyiv",
            verificationStatus: "verified",
            attractiveness: 65,
            photoRefs: [refs[1] ?? refs[0]!],
          },
        ],
      },
    ],
  };
  return { token: TOKEN, weekOf: new Date("2026-07-16T00:00:00Z"), dataJson: report };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /v1/founder/report/:token/media", () => {
  it("404s for an unknown token", async () => {
    founderReportFindUnique.mockResolvedValue(null);
    const res = await request(buildApp()).get(`/v1/founder/report/${TOKEN}/media?ref=foo`);
    expect(res.status).toBe(404);
  });

  it("404s for a ref not present in this report's snapshot", async () => {
    founderReportFindUnique.mockResolvedValue(reportRow(["ref-a", "ref-b"]));
    const res = await request(buildApp()).get(`/v1/founder/report/${TOKEN}/media?ref=not-in-report`);
    expect(res.status).toBe(404);
    expect(downloadProfileImage).not.toHaveBeenCalled();
  });

  it("serves an allowed ref with a no-store Cache-Control header (FOUNDER-1)", async () => {
    founderReportFindUnique.mockResolvedValue(reportRow(["ref-a", "ref-b"]));
    getMainBotApi.mockReturnValue({});
    downloadProfileImage.mockResolvedValue(Buffer.from("jpeg-bytes"));

    const res = await request(buildApp()).get(`/v1/founder/report/${TOKEN}/media?ref=ref-a`);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["x-robots-tag"]).toBe("noindex");
  });
});
