import express from "express";
import multer from "multer";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { publicErrorHandler } from "./error-handler.js";
import { MULTIPART_FIELD_LIMITS } from "../utils/upload-limits.js";

/**
 * B-07/B-08: a multer refusal (oversized file, unexpected field, too many
 * parts) used to reach the last-resort handler without a `.status` and answer
 * 500. B-19: Prisma's "record not found" / "malformed id" did the same.
 */

function uploadApp() {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { ...MULTIPART_FIELD_LIMITS, fileSize: 16, files: 1 },
  });
  const app = express();
  app.post("/voice", upload.single("file"), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(publicErrorHandler);
  return app;
}

function prismaError(code: string): Error {
  const err = new Error(`prisma ${code}`) as Error & { code: string };
  err.name = "PrismaClientKnownRequestError";
  err.code = code;
  return err;
}

function throwingApp(err: Error) {
  const app = express();
  app.get("/x", () => {
    throw err;
  });
  app.use(publicErrorHandler);
  return app;
}

describe("publicErrorHandler", () => {
  it("answers 413 for a file over the configured size", async () => {
    const res = await request(uploadApp())
      .post("/voice")
      .attach("file", Buffer.alloc(64), "a.m4a");
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "LIMIT_FILE_SIZE" });
  });

  it("answers 400 for a file under the wrong field name", async () => {
    const res = await request(uploadApp())
      .post("/voice")
      .attach("audio", Buffer.alloc(4), "a.m4a");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "LIMIT_UNEXPECTED_FILE" });
  });

  it("answers 400 for a body of too many text fields", async () => {
    let req = request(uploadApp()).post("/voice");
    for (let i = 0; i <= MULTIPART_FIELD_LIMITS.fields; i++) req = req.field(`f${i}`, "x");
    const res = await req;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^LIMIT_/);
  });

  it("maps Prisma P2025 to 404 and P2023 to 400", async () => {
    const missing = await request(throwingApp(prismaError("P2025"))).get("/x");
    expect(missing.status).toBe(404);
    const malformed = await request(throwingApp(prismaError("P2023"))).get("/x");
    expect(malformed.status).toBe(400);
  });

  it("still answers 500 for anything else", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await request(throwingApp(prismaError("P2002"))).get("/x");
    expect(res.status).toBe(500);
    spy.mockRestore();
  });
});
