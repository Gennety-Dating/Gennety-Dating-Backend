import { describe, expect, it } from "vitest";
import { pruneSlotsToProposedTimes } from "./calendar-selection.js";

describe("calendar selection helpers", () => {
  it("drops cached slots outside the server allowlist", () => {
    const allowed = ["2026-05-01T19:00:00.000Z", "2026-05-02T19:00:00.000Z"];

    const pruned = pruneSlotsToProposedTimes(
      [
        "2026-05-01T19:00:00.000Z",
        "2026-09-09T19:00:00.000Z",
        "not-a-date",
      ],
      allowed,
    );

    expect(Array.from(pruned)).toEqual(["2026-05-01T19:00:00.000Z"]);
  });

  it("normalizes equivalent ISO strings to the canonical server value", () => {
    const allowed = ["2026-05-01T19:00:00.000Z"];

    const pruned = pruneSlotsToProposedTimes(["2026-05-01T19:00:00Z"], allowed);

    expect(Array.from(pruned)).toEqual(["2026-05-01T19:00:00.000Z"]);
  });
});
