import { describe, it, expect } from "vitest";
import { isUniversityEmail, generateOtp } from "./email.js";

describe("isUniversityEmail", () => {
  it("accepts valid .edu emails", () => {
    expect(isUniversityEmail("alice@stanford.edu")).toBe(true);
    expect(isUniversityEmail("bob@mit.edu")).toBe(true);
  });

  it("accepts valid .ac.uk emails", () => {
    expect(isUniversityEmail("charlie@cam.ac.uk")).toBe(true);
  });

  it("accepts valid .edu.ua emails", () => {
    expect(isUniversityEmail("dima@knu.edu.ua")).toBe(true);
  });

  it("accepts valid .edu.ru emails", () => {
    expect(isUniversityEmail("ivan@msu.edu.ru")).toBe(true);
  });

  it("rejects non-university emails", () => {
    expect(isUniversityEmail("user@gmail.com")).toBe(false);
    expect(isUniversityEmail("user@yahoo.com")).toBe(false);
    expect(isUniversityEmail("user@company.io")).toBe(false);
  });

  it("rejects malformed emails", () => {
    expect(isUniversityEmail("notanemail")).toBe(false);
    expect(isUniversityEmail("@stanford.edu")).toBe(false);
    expect(isUniversityEmail("alice@")).toBe(false);
    expect(isUniversityEmail("")).toBe(false);
  });
});

describe("generateOtp", () => {
  it("generates OTP of the specified length", () => {
    const otp = generateOtp(6);
    expect(otp).toHaveLength(6);
  });

  it("generates only numeric characters", () => {
    const otp = generateOtp(10);
    expect(otp).toMatch(/^\d+$/);
  });

  it("generates different OTPs on successive calls", () => {
    const otps = new Set(Array.from({ length: 20 }, () => generateOtp(6)));
    // With 20 random 6-digit OTPs, we should get at least 2 unique values
    expect(otps.size).toBeGreaterThan(1);
  });
});
