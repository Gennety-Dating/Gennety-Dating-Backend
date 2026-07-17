import { describe, expect, it } from "vitest";
import {
  CURRENT_MATCH_STATUS_PRIORITY,
  pickCurrentMatch,
} from "./active-match-priority.js";

describe("pickCurrentMatch", () => {
  it("uses the documented progression priority instead of enum order", () => {
    expect(CURRENT_MATCH_STATUS_PRIORITY).toEqual([
      "scheduled",
      "negotiating_venue",
      "negotiating",
      "proposed",
    ]);
    expect(
      pickCurrentMatch([
        { id: "proposal", status: "proposed" as const },
        { id: "calendar", status: "negotiating" as const },
        { id: "date", status: "scheduled" as const },
      ]),
    ).toEqual({ id: "date", status: "scheduled" });
  });

  it("keeps input order as the tie-break within the same status", () => {
    expect(
      pickCurrentMatch([
        { id: "newest", status: "proposed" as const },
        { id: "older", status: "proposed" as const },
      ]),
    ).toEqual({ id: "newest", status: "proposed" });
  });
});
