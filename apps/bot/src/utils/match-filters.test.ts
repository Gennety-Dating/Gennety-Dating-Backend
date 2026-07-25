import { describe, it, expect } from "vitest";
import { PAIR_NOT_BOTH_ACCEPTED } from "./match-filters.js";

/**
 * Cheap shape guard that rides the DEFAULT test run.
 *
 * The behavioural proof lives in `match-filters.integration.test.ts` (it needs
 * real SQL — three-valued logic is invisible to a mocked Prisma client), but
 * integration tests are excluded from `vitest run`, so this file is the check
 * that actually fires on every `pnpm test`: it fails loudly if anyone
 * re-introduces the `NOT: { AND: [...] }` spelling or drops the explicit
 * `null` branches that make the filter null-safe.
 */
describe("PAIR_NOT_BOTH_ACCEPTED shape", () => {
  it("enumerates null AND false for both sides", () => {
    expect(PAIR_NOT_BOTH_ACCEPTED.OR).toEqual([
      { acceptedByA: null },
      { acceptedByA: false },
      { acceptedByB: null },
      { acceptedByB: false },
    ]);
  });

  it("never uses the NULL-swallowing NOT/AND or `not: true` spellings", () => {
    const serialized = JSON.stringify(PAIR_NOT_BOTH_ACCEPTED);
    expect(serialized).not.toContain('"NOT"');
    expect(serialized).not.toContain('"AND"');
    expect(serialized).not.toContain('"not"');
  });
});
