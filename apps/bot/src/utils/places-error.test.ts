import { describe, expect, it } from "vitest";
import { formatPlacesError, readPlacesError } from "./places-error.js";

const json = (error: unknown) => new Response(JSON.stringify({ error }), { status: 403 });

describe("readPlacesError", () => {
  it("reads status, reason and message", async () => {
    const body = await readPlacesError(
      json({ status: "PERMISSION_DENIED", message: "Blocked.", details: [{}, { reason: "API_KEY_SERVICE_BLOCKED" }] }),
    );
    expect(body).toEqual({ status: "PERMISSION_DENIED", reason: "API_KEY_SERVICE_BLOCKED", message: "Blocked." });
  });

  it("scrubs a quoted key and a project number, and bounds the message", async () => {
    const { message } = await readPlacesError(
      json({ message: `key AIzaSyD-abc_123 of project 123456789012 ${"x".repeat(500)}` }),
    );
    expect(message).toContain("key <key> of project <number>");
    expect(message!.length).toBeLessThanOrEqual(160);
  });

  it.each([
    ["an HTML page", "<html>403</html>"],
    ["an empty body", ""],
    ["JSON without an error", "{}"],
    ["JSON null", "null"],
    ["an oversized body", "x".repeat(20_000)],
  ])("never throws on %s", async (_name, raw) => {
    expect(await readPlacesError(new Response(raw, { status: 403 }))).toEqual({
      status: null,
      reason: null,
      message: null,
    });
  });

  it("tolerates malformed details", async () => {
    expect((await readPlacesError(json({ status: 7, details: [null, { reason: 1 }] }))).reason).toBeNull();
    expect((await readPlacesError(json({ details: "no" }))).reason).toBeNull();
  });
});

describe("formatPlacesError", () => {
  it("keeps the status first and drops what is absent", () => {
    expect(formatPlacesError(403, { status: "PERMISSION_DENIED", reason: null, message: "No." })).toBe(
      "403 PERMISSION_DENIED: No.",
    );
    expect(formatPlacesError(502, { status: null, reason: null, message: null })).toBe("502");
  });
});
