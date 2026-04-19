import { randomInt } from "node:crypto";
import { ALLOWED_EMAIL_DOMAINS } from "./constants.js";

/** Check if a string is a structurally valid email */
function isEmailFormat(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Check if the email belongs to an allowed university domain */
export function isUniversityEmail(email: string): boolean {
  if (!isEmailFormat(email)) return false;
  const lower = email.toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.some((domain) => lower.endsWith(domain));
}

/** Generate a cryptographically secure random numeric OTP of the given length */
export function generateOtp(length: number): string {
  let otp = "";
  for (let i = 0; i < length; i++) {
    otp += randomInt(10).toString();
  }
  return otp;
}
