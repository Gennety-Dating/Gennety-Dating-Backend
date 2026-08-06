import { describe, expect, it } from "vitest";
import type { TelegramProfileBasics } from "./api.js";
import {
  BASICS_STEPS,
  nextBasicsStep,
  previousBasicsStep,
} from "./onboarding-basics-route.js";

function basics(overrides: Partial<TelegramProfileBasics> = {}): TelegramProfileBasics {
  return {
    firstName: null,
    age: null,
    gender: null,
    preference: null,
    height: null,
    ...overrides,
  };
}

describe("nextBasicsStep", () => {
  it("walks the canonical order one field at a time", () => {
    expect(nextBasicsStep(basics())).toBe("name");
    expect(nextBasicsStep(basics({ firstName: "Alice" }))).toBe("age");
    expect(nextBasicsStep(basics({ firstName: "Alice", age: 24 }))).toBe("gender");
    expect(
      nextBasicsStep(basics({ firstName: "Alice", age: 24, gender: "female" })),
    ).toBe("preference");
    expect(
      nextBasicsStep(
        basics({ firstName: "Alice", age: 24, gender: "female", preference: "men" }),
      ),
    ).toBe("height");
  });

  it("is done once every field is answered", () => {
    expect(
      nextBasicsStep(
        basics({
          firstName: "Alice",
          age: 24,
          gender: "female",
          preference: "men",
          height: 170,
        }),
      ),
    ).toBeNull();
  });

  it("matches the collector's canonical question order", () => {
    expect([...BASICS_STEPS]).toEqual(["name", "age", "gender", "preference", "height"]);
  });

  it("does not treat a legitimate value as missing", () => {
    // `18` and `140` are the low bounds, not falsy placeholders — a truthiness
    // check here would re-ask the youngest and shortest users forever.
    expect(nextBasicsStep(basics({ firstName: "Alice", age: 18 }))).toBe("gender");
    expect(
      nextBasicsStep(
        basics({
          firstName: "Alice",
          age: 18,
          gender: "male",
          preference: "both",
          height: 140,
        }),
      ),
    ).toBeNull();
  });

  it("collects nothing when the server predates these screens", () => {
    expect(nextBasicsStep(undefined)).toBeNull();
    expect(nextBasicsStep(null)).toBeNull();
  });
});

describe("previousBasicsStep", () => {
  it("pages back through the set and stops at the first screen", () => {
    expect(previousBasicsStep("height")).toBe("preference");
    expect(previousBasicsStep("age")).toBe("name");
    expect(previousBasicsStep("name")).toBeNull();
  });
});
