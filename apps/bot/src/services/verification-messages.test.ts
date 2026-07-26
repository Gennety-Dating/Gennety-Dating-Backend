import { describe, it, expect } from "vitest";
import { t } from "@gennety/shared";
import {
  terminalVerificationMessage,
  verificationRetryMessage,
  livenessRetryMessage,
} from "./verification-messages.js";

describe("livenessRetryMessage", () => {
  it("maps not_live to the confidence-bar copy (framing/lighting advice)", () => {
    expect(livenessRetryMessage("en", "not_live")).toBe(t("en", "verifyRetryNotLive"));
  });

  it("maps expired and in_progress to the same unfinished-check copy", () => {
    expect(livenessRetryMessage("en", "expired")).toBe(t("en", "verifyRetryUnfinished"));
    expect(livenessRetryMessage("en", "in_progress")).toBe(t("en", "verifyRetryUnfinished"));
  });

  it("maps no_reference to the no-fault technical-hiccup copy", () => {
    expect(livenessRetryMessage("en", "no_reference")).toBe(t("en", "verifyRetryTechnical"));
  });

  it("the three copy variants are all distinct", () => {
    const variants = new Set([
      livenessRetryMessage("en", "not_live"),
      livenessRetryMessage("en", "expired"),
      livenessRetryMessage("en", "no_reference"),
    ]);
    expect(variants.size).toBe(3);
  });

  it.each(["ru", "uk", "de", "pl"] as const)(
    "resolves a non-English variant for %s (no silent English fallback)",
    (lang) => {
      expect(livenessRetryMessage(lang, "not_live")).not.toBe(
        livenessRetryMessage("en", "not_live"),
      );
    },
  );
});

describe("terminalVerificationMessage", () => {
  it("maps each terminal status to its own outcome copy", () => {
    expect(terminalVerificationMessage("en", "verified")).toBe(t("en", "verifyOutcomeVerified"));
    expect(terminalVerificationMessage("en", "pending_review")).toBe(
      t("en", "verifyOutcomePendingReview"),
    );
    expect(terminalVerificationMessage("en", "rejected")).toBe(t("en", "verifyOutcomeRejected"));
  });
});

describe("verificationRetryMessage", () => {
  it("reuses the ordinary reminder copy (infra-failure retry, not the liveness-retry copy)", () => {
    expect(verificationRetryMessage("en")).toBe(t("en", "verifyReminderNudge"));
  });
});
