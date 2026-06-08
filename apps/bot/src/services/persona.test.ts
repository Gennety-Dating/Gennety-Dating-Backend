import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  mapPersonaStatusToInternal,
  parsePersonaSignatureHeader,
  verifyPersonaWebhookSignature,
  WEBHOOK_MAX_AGE_SECONDS,
} from "./persona.js";

const SECRET = "wbhsec_test_secret_000";
const BODY = Buffer.from(
  JSON.stringify({
    data: { type: "event", id: "evt_1", attributes: { name: "inquiry.completed" } },
  }),
);

function sign(ts: string, body: Buffer, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex");
}

describe("parsePersonaSignatureHeader", () => {
  it("extracts t and v1 from a single-digest header", () => {
    expect(parsePersonaSignatureHeader("t=1700000000,v1=abc")).toEqual({
      ts: "1700000000",
      digests: ["abc"],
    });
  });

  it("collects multiple v1 entries (secret rotation window)", () => {
    const parsed = parsePersonaSignatureHeader("t=1700000000,v1=abc,v1=def");
    expect(parsed?.digests).toEqual(["abc", "def"]);
  });

  it("returns null for an empty header", () => {
    expect(parsePersonaSignatureHeader(undefined)).toBeNull();
    expect(parsePersonaSignatureHeader("")).toBeNull();
  });

  it("returns null when the timestamp is missing", () => {
    expect(parsePersonaSignatureHeader("v1=abc")).toBeNull();
  });

  it("returns null when no v1 is present", () => {
    expect(parsePersonaSignatureHeader("t=1700000000")).toBeNull();
  });
});

describe("verifyPersonaWebhookSignature", () => {
  const now = 1_700_000_000;
  const ts = String(now);
  const goodSig = sign(ts, BODY);

  it("returns true for a valid signature within the freshness window", () => {
    expect(verifyPersonaWebhookSignature(BODY, `t=${ts},v1=${goodSig}`, SECRET, now)).toBe(true);
  });

  it("returns true if any one of several v1 values matches (rotation)", () => {
    const header = `t=${ts},v1=${"0".repeat(64)},v1=${goodSig}`;
    expect(verifyPersonaWebhookSignature(BODY, header, SECRET, now)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from('{"data":{"evil":true}}');
    expect(verifyPersonaWebhookSignature(tampered, `t=${ts},v1=${goodSig}`, SECRET, now)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifyPersonaWebhookSignature(BODY, `t=${ts},v1=${goodSig}`, "other-secret", now)).toBe(false);
  });

  it("rejects an empty secret (feature disabled)", () => {
    expect(verifyPersonaWebhookSignature(BODY, `t=${ts},v1=${goodSig}`, "", now)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyPersonaWebhookSignature(BODY, undefined, SECRET, now)).toBe(false);
  });

  it("rejects a stale timestamp (> max age)", () => {
    const stale = now - (WEBHOOK_MAX_AGE_SECONDS + 1);
    const sig = sign(String(stale), BODY);
    expect(verifyPersonaWebhookSignature(BODY, `t=${stale},v1=${sig}`, SECRET, now)).toBe(false);
  });

  it("rejects a future timestamp > max age (clock skew attack)", () => {
    const future = now + (WEBHOOK_MAX_AGE_SECONDS + 1);
    const sig = sign(String(future), BODY);
    expect(verifyPersonaWebhookSignature(BODY, `t=${future},v1=${sig}`, SECRET, now)).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(verifyPersonaWebhookSignature(BODY, `t=abc,v1=${goodSig}`, SECRET, now)).toBe(false);
  });
});

describe("mapPersonaStatusToInternal", () => {
  it("treats only approved as verified", () => {
    expect(mapPersonaStatusToInternal("approved")).toBe("verified");
  });

  it("treats declined/failed/expired as rejected", () => {
    expect(mapPersonaStatusToInternal("declined")).toBe("rejected");
    expect(mapPersonaStatusToInternal("failed")).toBe("rejected");
    expect(mapPersonaStatusToInternal("expired")).toBe("rejected");
  });

  it("treats in-progress states as pending", () => {
    expect(mapPersonaStatusToInternal("created")).toBe("pending");
    expect(mapPersonaStatusToInternal("pending")).toBe("pending");
    expect(mapPersonaStatusToInternal("completed")).toBe("pending");
    expect(mapPersonaStatusToInternal("needs_review")).toBe("pending");
  });
});
