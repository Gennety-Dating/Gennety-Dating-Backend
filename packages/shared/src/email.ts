import { randomInt } from "node:crypto";
import { ALLOWED_EMAIL_DOMAINS } from "./constants.js";

/** Check if a string is a structurally valid email */
function isEmailFormat(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Check if the email belongs to an allowed university domain */
export function isUniversityEmail(email: string): boolean {
  if (!isEmailFormat(email)) return false;
  const emailDomain = email.slice(email.indexOf("@") + 1).toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.some((allowedDomain) => {
    const lowerAllowedDomain = allowedDomain.toLowerCase();
    if (lowerAllowedDomain.startsWith(".")) {
      return emailDomain.endsWith(lowerAllowedDomain);
    }
    return (
      emailDomain === lowerAllowedDomain ||
      emailDomain.endsWith(`.${lowerAllowedDomain}`)
    );
  });
}

/**
 * True when the local part carries a sub-address tag (`name+anything@uni.edu`).
 *
 * Most university mail systems deliver `name+1@` and `name+2@` to the same
 * inbox, while `User.email` is unique on the literal string — so without this
 * one mailbox verifies as any number of distinct students. The rails that
 * START a verification refuse such an address (`public/otp.ts`); the check is
 * on the part before the LAST `@`, the one a mail server reads.
 */
export function hasPlusAddressTag(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  return email.slice(0, at).includes("+");
}

/** Generate a cryptographically secure random numeric OTP of the given length */
export function generateOtp(length: number): string {
  let otp = "";
  for (let i = 0; i < length; i++) {
    otp += randomInt(10).toString();
  }
  return otp;
}
