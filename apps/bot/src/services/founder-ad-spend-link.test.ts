import { beforeEach, describe, expect, it, vi } from "vitest";

const { env } = vi.hoisted(() => ({ env: { ADMIN_API_KEY: "signing-secret" } }));
vi.mock("../config.js", () => ({ env }));
vi.mock("./next-batch.js", () => ({ CRON_TIMEZONE: "Europe/Kyiv" }));

const { signAdSpendLink, verifyAdSpendLink, previousWeek, isoDay, parseIsoDay } = await import(
  "./founder-ad-spend-link.js"
);

beforeEach(() => {
  env.ADMIN_API_KEY = "signing-secret";
});

describe("signAdSpendLink / verifyAdSpendLink", () => {
  const week = { weekStart: "2026-08-17", weekEnd: "2026-08-23" };

  it("round-trips a week", () => {
    const token = signAdSpendLink(week)!;
    expect(token).toBeTruthy();
    expect(verifyAdSpendLink(token)).toEqual(expect.objectContaining(week));
  });

  it("mints nothing without a signing key, rather than an unsigned link", () => {
    env.ADMIN_API_KEY = "";
    expect(signAdSpendLink(week)).toBeNull();
  });

  it("rejects a token whose payload was edited", () => {
    const token = signAdSpendLink(week)!;
    const [body, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ weekStart: "2026-01-05", weekEnd: "2026-01-11", exp: 4e9 }),
    )
      .toString("base64url");
    expect(verifyAdSpendLink(`${forged}.${sig}`)).toBeNull();
    // ...and the untouched one still verifies, so the check above proves the
    // signature rather than the parsing.
    expect(verifyAdSpendLink(`${body}.${sig}`)).not.toBeNull();
  });

  it("rejects a token signed with a different key — key rotation revokes links", () => {
    const token = signAdSpendLink(week)!;
    env.ADMIN_API_KEY = "rotated-secret";
    expect(verifyAdSpendLink(token)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signAdSpendLink(week, new Date("2026-08-24T00:00:00Z"))!;
    expect(verifyAdSpendLink(token, new Date("2026-08-30T00:00:00Z"))).not.toBeNull();
    expect(verifyAdSpendLink(token, new Date("2026-10-30T00:00:00Z"))).toBeNull();
  });

  it("rejects junk without throwing", () => {
    for (const junk of ["", ".", "a.b", "not-a-token", "../../etc/passwd", "a".repeat(400)]) {
      expect(verifyAdSpendLink(junk)).toBeNull();
    }
  });
});

describe("previousWeek", () => {
  it("names Mon–Sun of the week that closed, at the scheduled 09:00 Kyiv", () => {
    // Monday 2026-08-24 09:00 Kyiv = 06:00 UTC.
    const { start, end } = previousWeek(new Date("2026-08-24T06:00:00Z"));
    expect(isoDay(start)).toBe("2026-08-17");
    expect(isoDay(end)).toBe("2026-08-23");
  });

  it("gives the same week at an hour where UTC has not caught up yet", () => {
    // Monday 02:00 Kyiv is still Sunday 23:00 UTC. The old `now - 7d` produced
    // a Sunday here, and a UTC-anchored weekday read produces the week before
    // last — both name a window no `ad_spend` row can match.
    const { start, end } = previousWeek(new Date("2026-08-23T23:00:00Z"));
    expect(isoDay(start)).toBe("2026-08-17");
    expect(isoDay(end)).toBe("2026-08-23");
  });

  it("is stable across every hour of the scheduled day", () => {
    const days = new Set<string>();
    for (let h = 0; h < 24; h += 1) {
      const hh = String(h).padStart(2, "0");
      // Local Kyiv Monday, expressed by asking on that calendar day.
      const { start } = previousWeek(new Date(`2026-08-24T${hh}:00:00Z`));
      if (new Date(`2026-08-24T${hh}:00:00Z`) >= new Date("2026-08-23T21:00:00Z")) {
        days.add(isoDay(start));
      }
    }
    expect([...days]).toEqual(["2026-08-17"]);
  });

  it("treats Sunday as belonging to the week still in progress", () => {
    // Sunday 2026-08-23 12:00 Kyiv — this week (17th–23rd) has NOT closed yet,
    // so the answer is the one before it.
    const { start, end } = previousWeek(new Date("2026-08-23T09:00:00Z"));
    expect(isoDay(start)).toBe("2026-08-10");
    expect(isoDay(end)).toBe("2026-08-16");
  });
});

describe("parseIsoDay", () => {
  it("parses to the same instant a bare ISO date string does", () => {
    // The admin route builds its period bounds with `new Date(raw)`. If these
    // two disagreed, a row entered from the phone would MISS the upsert key
    // and silently double the week's spend instead of editing it.
    expect(parseIsoDay("2026-08-17")!.getTime()).toBe(new Date("2026-08-17").getTime());
  });

  it("refuses anything that is not a plain day", () => {
    for (const bad of ["", "2026-8-1", "2026-08-17T00:00:00Z", "oops"]) {
      expect(parseIsoDay(bad)).toBeNull();
    }
  });
});
