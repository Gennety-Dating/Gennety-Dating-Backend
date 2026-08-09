import { describe, expect, it } from "vitest";
import { DEFAULT_SESSION, type SessionData } from "@gennety/shared";
import {
  MENU_CLAIM_TTL_MS,
  claimMenuText,
  isClaimableMenuState,
  menuClaimIsLive,
  releaseMenuClaim,
  updateReleasesMenuClaim,
} from "./menu-text-claim.js";

const session = (over: Partial<SessionData> = {}): SessionData => ({
  ...DEFAULT_SESSION,
  ...over,
});

const NOW = new Date("2026-08-08T12:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("claimMenuText", () => {
  it("stamps a deadline sized to the state", () => {
    const s = session();
    claimMenuText(s, "edit_bio", NOW);

    expect(s.menuState).toBe("edit_bio");
    expect(s.menuClaimUntil).toBe(NOW.getTime() + MENU_CLAIM_TTL_MS.edit_bio!);
  });

  it("gives the states that feed the embedding the shortest window", () => {
    // The ordering is the point: a wrong write to the bio or to partner
    // preferences re-aims matching and cannot be seen, while a wrong major or
    // age range is on screen and one tap from being fixed.
    expect(MENU_CLAIM_TTL_MS.edit_bio!).toBeLessThan(MENU_CLAIM_TTL_MS.edit_major!);
    expect(MENU_CLAIM_TTL_MS.edit_partner_preferences!).toBeLessThan(
      MENU_CLAIM_TTL_MS.edit_age_range!,
    );
  });

  it("leaves a non-claimable menu state unbounded", () => {
    // `edit_photos` consumes media, not text — a stray photo lands in a gallery
    // the user can see and delete, so it is deliberately outside this rule.
    const s = session();
    claimMenuText(s, "edit_photos", NOW);

    expect(s.menuState).toBe("edit_photos");
    expect(s.menuClaimUntil).toBeNull();
  });
});

describe("menuClaimIsLive", () => {
  it("is live inside the window and dead past it", () => {
    const s = session();
    claimMenuText(s, "edit_bio", NOW);

    expect(menuClaimIsLive(s, "edit_bio", later(1_000))).toBe(true);
    expect(
      menuClaimIsLive(s, "edit_bio", later(MENU_CLAIM_TTL_MS.edit_bio! + 1)),
    ).toBe(false);
  });

  /**
   * THE regression this module exists for. A user taps "About me", walks away,
   * and comes back weeks later to ask the concierge something. That message
   * used to be written verbatim into `Profile.psychologicalSummary` — the
   * dominant embedding input — replacing an AI-memory analysis with no snapshot
   * to restore from, while their actual question went unanswered.
   */
  it("does not let a forgotten bio edit swallow a message sent weeks later", () => {
    const s = session();
    claimMenuText(s, "edit_bio", NOW);

    const threeWeeksLater = later(21 * 24 * 60 * 60 * 1000);
    expect(menuClaimIsLive(s, "edit_bio", threeWeeksLater)).toBe(false);
  });

  it("fails closed for a session written before the field existed", () => {
    // The storage adapter merges defaults, so an in-flight edit spanning the
    // deploy reads `null` and falls through to the agent rather than being
    // trusted forever. That is the safe direction: the agent can hand the
    // editor straight back, a trusted stale state overwrites a profile.
    const s = session({ menuState: "edit_bio", menuClaimUntil: null });
    expect(menuClaimIsLive(s, "edit_bio", NOW)).toBe(false);
  });

  it("is not live for a different state than the one claimed", () => {
    const s = session();
    claimMenuText(s, "edit_major", NOW);
    expect(menuClaimIsLive(s, "edit_bio", NOW)).toBe(false);
  });
});

describe("updateReleasesMenuClaim", () => {
  it("releases an edit state on any button tap", () => {
    const s = session();
    claimMenuText(s, "edit_bio", NOW);
    expect(updateReleasesMenuClaim(s, { callbackData: "menu:open" })).toBe(true);
  });

  it("releases on a slash command", () => {
    const s = session();
    claimMenuText(s, "edit_partner_preferences", NOW);
    expect(updateReleasesMenuClaim(s, { text: "/menu" })).toBe(true);
  });

  it("does not release on plain text — that IS the answer", () => {
    const s = session();
    claimMenuText(s, "edit_bio", NOW);
    expect(updateReleasesMenuClaim(s, { text: "I like long walks" })).toBe(false);
  });

  it("keeps the premium reason claim alive for its own Skip button", () => {
    // A claim's own buttons must be exempt, or Skip would invalidate the state
    // it exists to resolve.
    const s = session();
    claimMenuText(s, "awaiting_premium_cancel_reason", NOW);
    expect(
      updateReleasesMenuClaim(s, { callbackData: "prem:cancel:reason:skip" }),
    ).toBe(false);
    expect(updateReleasesMenuClaim(s, { callbackData: "menu:open" })).toBe(true);
  });

  it("ignores states it does not govern", () => {
    const s = session({ menuState: "edit_photos" });
    expect(updateReleasesMenuClaim(s, { callbackData: "menu:open" })).toBe(false);
  });
});

describe("releaseMenuClaim", () => {
  it("drops the claim and everything scoped to it", () => {
    const s = session({ premiumCancelLedgerId: "ledger-1" });
    claimMenuText(s, "awaiting_premium_cancel_reason", NOW);

    releaseMenuClaim(s);

    expect(s.menuState).toBe("idle");
    expect(s.menuClaimUntil).toBeNull();
    expect(s.premiumCancelLedgerId).toBeNull();
  });
});

describe("isClaimableMenuState", () => {
  it("covers exactly the states that consume plain text", () => {
    for (const state of [
      "edit_bio",
      "edit_major",
      "edit_partner_preferences",
      "edit_age_range",
      "awaiting_premium_cancel_reason",
    ] as const) {
      expect(isClaimableMenuState(state)).toBe(true);
      // Every governed state needs a TTL, or `claimMenuText` would stamp a
      // deadline of `now` and the claim would be dead on arrival.
      expect(MENU_CLAIM_TTL_MS[state]).toBeGreaterThan(0);
    }
    for (const state of ["idle", "edit_photos", "edit_video", "settings_lang"] as const) {
      expect(isClaimableMenuState(state)).toBe(false);
    }
  });
});
