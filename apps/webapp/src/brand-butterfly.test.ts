import { describe, expect, it } from "vitest";
import { BUTTERFLY_PATH, WING_LEFT, WING_RIGHT } from "./brand-butterfly.js";
import { MASCOT_BODY } from "./mascot-welcome.js";

describe("Gennety brand silhouette", () => {
  it("uses the iOS pointed mark across Mini App surfaces", () => {
    expect(MASCOT_BODY).toBe(BUTTERFLY_PATH);
    expect(BUTTERFLY_PATH).toContain("25 100, 50 65 C 75 100");
    expect(BUTTERFLY_PATH).not.toMatch(/48 65|L\s*52 65/);
  });

  it("reassembles animated wings at the same lower point", () => {
    expect(WING_LEFT).toContain("-25 50, 0 15 Z");
    expect(WING_RIGHT).toContain("L 0 15 C 25 50");
    expect(WING_LEFT).not.toContain("-2 15");
    expect(WING_RIGHT).not.toContain("2 15");
  });
});
