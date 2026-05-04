import { describe, it, expect } from "vitest";
import { computeDevBypassFields, DEV_BYPASS_EMAIL_DOMAIN } from "./dev-bypass.js";

describe("computeDevBypassFields", () => {
  it("returns null when telegramId is not in the bypass set", () => {
    const set = new Set<bigint>([5986970093n]);
    expect(computeDevBypassFields(12345n, set)).toBeNull();
  });

  it("returns synthetic verified-email fields when telegramId IS in the set", () => {
    const tgId = 5986970093n;
    const set = new Set<bigint>([tgId]);
    const fields = computeDevBypassFields(tgId, set);

    expect(fields).toEqual({
      email: `dev+5986970093@${DEV_BYPASS_EMAIL_DOMAIN}`,
      universityDomain: DEV_BYPASS_EMAIL_DOMAIN,
      isEmailVerified: true,
    });
  });

  it("returns null for an empty bypass set (production-safe default)", () => {
    expect(computeDevBypassFields(5986970093n, new Set())).toBeNull();
  });

  it("uses the gennety.dev domain (not a real university domain)", () => {
    const fields = computeDevBypassFields(1n, new Set([1n]));
    expect(fields?.universityDomain).toBe("gennety.dev");
    // Sanity: never accidentally synthesise a .edu address — that could leak
    // into matching logic that filters by university.
    expect(fields?.email).not.toMatch(/\.edu$/);
  });

  it("emits unique synthetic emails per telegramId (so DB unique constraint holds)", () => {
    const set = new Set<bigint>([1n, 2n, 3n]);
    const a = computeDevBypassFields(1n, set);
    const b = computeDevBypassFields(2n, set);
    const c = computeDevBypassFields(3n, set);
    expect(new Set([a?.email, b?.email, c?.email]).size).toBe(3);
  });
});
