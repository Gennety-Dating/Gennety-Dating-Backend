import { describe, it, expect } from "vitest";
import { isE164, normalizePhoneE164 } from "./phone.js";

describe("isE164", () => {
  it("accepts valid E.164 numbers", () => {
    expect(isE164("+380501234567")).toBe(true);
    expect(isE164("+15551234567")).toBe(true);
    expect(isE164("+491701234567")).toBe(true);
  });

  it("rejects invalid forms", () => {
    expect(isE164("0501234567")).toBe(false); // missing +
    expect(isE164("+0501234567")).toBe(false); // leading zero after +
    expect(isE164("+12")).toBe(false); // too short
    expect(isE164("+1234567890123456")).toBe(false); // 16 digits, too long
    expect(isE164("+38050abc4567")).toBe(false);
  });
});

describe("normalizePhoneE164", () => {
  it("adds a leading + when missing (typical Telegram contact)", () => {
    expect(normalizePhoneE164("380501234567")).toBe("+380501234567");
  });

  it("strips spaces, dashes, parens and dots", () => {
    expect(normalizePhoneE164("+38 (050) 123-45.67")).toBe("+380501234567");
  });

  it("converts a leading 00 to +", () => {
    expect(normalizePhoneE164("0038 050 1234567")).toBe("+380501234567");
  });

  it("returns null for empty or unparseable input", () => {
    expect(normalizePhoneE164("")).toBeNull();
    expect(normalizePhoneE164(null)).toBeNull();
    expect(normalizePhoneE164(undefined)).toBeNull();
    expect(normalizePhoneE164("abc")).toBeNull();
  });
});
