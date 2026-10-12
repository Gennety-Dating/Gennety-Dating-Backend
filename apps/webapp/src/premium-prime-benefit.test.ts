import { describe, expect, it } from "vitest";
// `?raw` for the same reason `location-thinking.test.ts` gives: `premium.ts` is
// a Mini App entry that runs on import and exports nothing, so its `COPY` table
// is reachable only as source text.
import SRC from "./premium.ts?raw";

/**
 * The evening band is the reason a user can arrive on the Premium screen from
 * the calendar at all (PRIME_TIME_PRODUCT_SPEC §10), so two things about the
 * fourth benefit card are load-bearing rather than styling:
 *
 *   - it exists in every locale — a missing one renders `undefined` on a screen
 *     that asks for money;
 *   - it is SECOND. That reader tapped a padlock thirty seconds ago and came
 *     here to find out what removes it; behind two venue perks they scroll past
 *     the answer.
 */
describe("Premium screen — the evening-band benefit card", () => {
  it("is written in all five locales", () => {
    for (const key of ["b4t", "b4d", "b4x"]) {
      const written = SRC.match(new RegExp(`\\n\\s+${key}:\\s*"`, "g")) ?? [];
      expect(written).toHaveLength(5);
    }
  });

  it("is rendered second, straight after the Date Wishlist", () => {
    const list = SRC.slice(SRC.indexOf("const cards:"), SRC.indexOf("for (const [ico"));
    const order = [...list.matchAll(/s\.b(\d)t/g)].map((m) => m[1]);
    expect(order).toEqual(["1", "4", "2", "3"]);
  });

  it("names no slot count — the number is env-side and would go stale in copy", () => {
    const values = [...SRC.matchAll(/\n\s+b4[tdx]:\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(values).toHaveLength(15);
    for (const value of values) expect(value).not.toMatch(/\d/);
  });
});

/**
 * Premium stopped covering Date Tickets on 2026-10-08 ("за билет на свидание
 * платят всегда"); the Date Wishlist took the lead card. Nothing on a screen
 * that asks for money may still promise a free ticket.
 */
describe("Premium screen — the lead benefit card", () => {
  it("is the Date Wishlist, written in all five locales", () => {
    for (const key of ["b1t", "b1d", "b1x"]) {
      const written = SRC.match(new RegExp(`\\n\\s+${key}:\\s*"`, "g")) ?? [];
      expect(written).toHaveLength(5);
    }
    const titles = [...SRC.matchAll(/\n\s+b1t:\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(titles).toEqual([
      "Date Wishlist",
      "Шпаргалка ко второму свиданию",
      "Шпаргалка до другого побачення",
      "Spickzettel fürs zweite Date",
      "Ściąga na drugą randkę",
    ]);
  });

  it("promises no free or covered ticket in any locale", () => {
    const values = [...SRC.matchAll(/\n\s+b\d[tdx]:\s*"([^"]*)"/g)].map((m) => m[1]!);
    expect(values.length).toBeGreaterThanOrEqual(60);
    for (const value of values) {
      expect(value).not.toMatch(
        /ticket|билет|квит|bilet|unlimited|безлимит|безлім|unbegrenzt|nielimit|covered|покрыт|покрит|abgedeckt|pokryt/i,
      );
    }
  });
});
