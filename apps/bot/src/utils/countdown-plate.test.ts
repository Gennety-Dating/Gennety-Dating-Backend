import { describe, it, expect } from "vitest";

import {
  PROPOSAL_TTL_MS,
  appendCountdownPlate,
  minutesLeftFromDispatch,
  renderCountdownPlate,
} from "./countdown-plate.js";

describe("renderCountdownPlate", () => {
  it("at T+0 (1440 min left) shows 24h", () => {
    expect(renderCountdownPlate("en", 1440)).toBe("⏳ 24h left to reply");
  });

  it("ceiling-hours: 1380 min (T+60min) flips to 23h, never shows 24h once any time passed", () => {
    expect(renderCountdownPlate("en", 1380)).toBe("⏳ 23h left to reply");
    expect(renderCountdownPlate("en", 1379)).toBe("⏳ 23h left to reply"); // still 23 (ceil 22.98 = 23)
  });

  it("hour boundary at exactly 60 min still renders as 1h (>=60 → hours)", () => {
    expect(renderCountdownPlate("en", 60)).toBe("⏳ 1h left to reply");
  });

  it("under 60 min renders raw minutes", () => {
    expect(renderCountdownPlate("en", 59)).toBe("⏳ 59 min left to reply");
    expect(renderCountdownPlate("en", 5)).toBe("⏳ 5 min left to reply");
    expect(renderCountdownPlate("en", 1)).toBe("⏳ 1 min left to reply");
  });

  it("0 or negative renders the expired notice", () => {
    expect(renderCountdownPlate("en", 0)).toBe("⏳ Time's up — this proposal expired.");
    expect(renderCountdownPlate("en", -5)).toBe("⏳ Time's up — this proposal expired.");
  });

  it("respects ru / uk locales", () => {
    expect(renderCountdownPlate("ru", 720)).toBe("⏳ Осталось 12ч на ответ");
    expect(renderCountdownPlate("uk", 30)).toBe("⏳ Залишилось 30 хв на відповідь");
  });
});

describe("minutesLeftFromDispatch", () => {
  it("returns 1440 at T+0", () => {
    const dispatched = new Date("2026-04-30T12:00:00Z");
    const now = new Date(dispatched);
    expect(minutesLeftFromDispatch(dispatched, now)).toBe(1440);
  });

  it("returns 0 at exactly the deadline", () => {
    const dispatched = new Date("2026-04-30T12:00:00Z");
    const now = new Date(dispatched.getTime() + PROPOSAL_TTL_MS);
    expect(minutesLeftFromDispatch(dispatched, now)).toBe(0);
  });

  it("returns negative past the deadline", () => {
    const dispatched = new Date("2026-04-30T12:00:00Z");
    const now = new Date(dispatched.getTime() + PROPOSAL_TTL_MS + 60_000);
    expect(minutesLeftFromDispatch(dispatched, now)).toBe(-1);
  });

  it("matches the cadence design: 5-min ticks during first 23h give one transition per hour", () => {
    // Walk a 5-min cadence from minutesLeft=1440 down to 1320 (2 hours
    // wall-clock). Render must change exactly twice — once when the
    // displayed hours value flips from 24→23, and once at 23→22.
    const seen = new Set<string>();
    for (let m = 1440; m >= 1320; m -= 5) {
      seen.add(renderCountdownPlate("en", m));
    }
    expect(seen.size).toBe(3); // "24h", "23h", "22h"
  });

  it("matches the cadence design: 5-min ticks during the final hour change every tick", () => {
    const seen = new Set<string>();
    for (let m = 60; m > 0; m -= 5) {
      seen.add(renderCountdownPlate("en", m));
    }
    // 60 (still hours format → "1h") + minute renders for 55..5 (11
    // distinct values) = 12 unique strings.
    expect(seen.size).toBe(12);
  });
});

describe("appendCountdownPlate", () => {
  it("separates body and plate with a blank line so the message stays readable", () => {
    const result = appendCountdownPlate("Pitch body here.", "en", 720);
    expect(result).toBe("Pitch body here.\n\n⏳ 12h left to reply");
  });
});
