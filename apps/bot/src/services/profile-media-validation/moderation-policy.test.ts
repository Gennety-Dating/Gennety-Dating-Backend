import { describe, expect, it } from "vitest";
import { combineModerationResults } from "./moderation-policy.js";

describe("combineModerationResults", () => {
  it("blocks when either provider returns a hard signal", () => {
    expect(
      combineModerationResults([
        { ok: true, signals: [] },
        {
          ok: true,
          signals: [
            {
              provider: "aws",
              category: "Explicit Nudity",
              score: 0.97,
              severity: "block",
            },
          ],
        },
      ]),
    ).toMatchObject({ kind: "blocked" });
  });

  it("keeps borderline content in review", () => {
    expect(
      combineModerationResults([
        {
          ok: true,
          signals: [
            {
              provider: "openai",
              category: "violence",
              score: 0.7,
              severity: "review",
            },
          ],
        },
      ]),
    ).toMatchObject({ kind: "review" });
  });

  it("does not approve when a provider is unavailable", () => {
    expect(
      combineModerationResults([
        { ok: true, signals: [] },
        { ok: false, error: "timeout" },
      ]),
    ).toEqual({ kind: "unavailable", errors: ["timeout"] });
  });

  it("returns safe only when every provider succeeded without signals", () => {
    expect(
      combineModerationResults([
        { ok: true, signals: [] },
        { ok: true, signals: [] },
      ]),
    ).toEqual({ kind: "safe", signals: [] });
  });
});
