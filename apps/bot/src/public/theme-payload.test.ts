import { describe, it, expect } from "vitest";
import { parseThemePayload } from "./theme-payload.js";

describe("parseThemePayload", () => {
  it("accepts an explicit pick that agrees with itself", () => {
    expect(parseThemePayload({ mode: "light", theme: "light" })).toEqual({
      mode: "light",
      theme: "light",
    });
  });

  it("accepts `system` with either resolved colour — there the phone decides", () => {
    expect(parseThemePayload({ mode: "system", theme: "light" })).toEqual({
      mode: "system",
      theme: "light",
    });
    expect(parseThemePayload({ mode: "system", theme: "dark" })).toEqual({
      mode: "system",
      theme: "dark",
    });
  });

  it("refuses an explicit pick that disagrees with its own colour", () => {
    // Storing this would leave the app dark and the Telegram cards light.
    expect(parseThemePayload({ mode: "dark", theme: "light" })).toEqual({
      error: "mode and theme disagree",
    });
  });

  it("refuses `system` as a resolved colour — nothing can render it", () => {
    expect(parseThemePayload({ mode: "system", theme: "system" })).toEqual({
      error: "Invalid theme",
    });
  });

  it("refuses junk and a missing body", () => {
    expect(parseThemePayload({ mode: "sepia", theme: "dark" })).toEqual({
      error: "Invalid mode",
    });
    expect(parseThemePayload(undefined)).toEqual({ error: "Invalid mode" });
    expect(parseThemePayload({ mode: "light" })).toEqual({ error: "Invalid theme" });
  });
});
