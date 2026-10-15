import { beforeEach, describe, expect, it } from "vitest";
import {
  APP_REVIEW_MAX_FAILURES,
  APP_REVIEW_LOCKOUT_WINDOW_MS,
  APP_REVIEW_PARTNER_TELEGRAM_ID,
  APP_REVIEW_REVIEWER_TELEGRAM_ID,
  appReviewConfigurationErrors,
  checkAppReviewCode,
  isAppReviewEmail,
  isAppReviewEnabled,
  isAppReviewTelegramId,
  NOT_APP_REVIEW_ACCOUNT_SQL,
  resetAppReviewFailures,
} from "./app-review.js";

const ON = { APP_REVIEW_EMAIL: "review@gennety.com", APP_REVIEW_CODE: "583014" };
const OFF = { APP_REVIEW_EMAIL: "", APP_REVIEW_CODE: "" };

describe("app review configuration", () => {
  it("is off and valid when both values are empty", () => {
    expect(isAppReviewEnabled(OFF)).toBe(false);
    expect(appReviewConfigurationErrors(OFF)).toEqual([]);
  });

  it("is on with a valid pair", () => {
    expect(isAppReviewEnabled(ON)).toBe(true);
    expect(appReviewConfigurationErrors(ON)).toEqual([]);
  });

  it("refuses a half-set pair", () => {
    expect(appReviewConfigurationErrors({ ...ON, APP_REVIEW_CODE: "" })).toHaveLength(1);
    expect(appReviewConfigurationErrors({ ...ON, APP_REVIEW_EMAIL: "" })).toHaveLength(1);
  });

  it.each(["12345", "1234567", "12a456", "000000", "777777", "123456", "654321", "234567"])(
    "refuses code %s",
    (code) => {
      expect(appReviewConfigurationErrors({ ...ON, APP_REVIEW_CODE: code }).length).toBeGreaterThan(0);
    },
  );

  it("refuses a non-address", () => {
    expect(appReviewConfigurationErrors({ ...ON, APP_REVIEW_EMAIL: "review" })).toHaveLength(1);
  });
});

describe("isAppReviewEmail", () => {
  it("matches only the configured address, case-insensitively", () => {
    expect(isAppReviewEmail(" Review@Gennety.com ", ON)).toBe(true);
    expect(isAppReviewEmail("other@gennety.com", ON)).toBe(false);
  });

  it("never matches while the feature is off", () => {
    expect(isAppReviewEmail("", OFF)).toBe(false);
    expect(isAppReviewEmail("review@gennety.com", { ...OFF, APP_REVIEW_EMAIL: "review@gennety.com" })).toBe(false);
  });
});

describe("checkAppReviewCode", () => {
  beforeEach(() => resetAppReviewFailures());

  it("accepts the configured code and rejects others", () => {
    expect(checkAppReviewCode("583014", 0, ON)).toBe("ok");
    expect(checkAppReviewCode("583015", 0, ON)).toBe("mismatch");
    expect(checkAppReviewCode("", 0, ON)).toBe("mismatch");
  });

  it("never accepts anything while the code is empty", () => {
    expect(checkAppReviewCode("", 0, OFF)).toBe("mismatch");
  });

  it("locks globally after too many wrong codes, even for the right one", () => {
    for (let i = 0; i < APP_REVIEW_MAX_FAILURES; i++) {
      expect(checkAppReviewCode("000000", 1000, ON)).toBe("mismatch");
    }
    expect(checkAppReviewCode("583014", 1001, ON)).toBe("locked");
  });

  it("unlocks once the window has passed", () => {
    for (let i = 0; i < APP_REVIEW_MAX_FAILURES; i++) checkAppReviewCode("000000", 1000, ON);
    expect(checkAppReviewCode("583014", 1000 + APP_REVIEW_LOCKOUT_WINDOW_MS, ON)).toBe("ok");
  });
});

describe("reserved telegramId band", () => {
  it("covers both accounts and nothing outside it", () => {
    expect(isAppReviewTelegramId(APP_REVIEW_REVIEWER_TELEGRAM_ID)).toBe(true);
    expect(isAppReviewTelegramId(APP_REVIEW_PARTNER_TELEGRAM_ID)).toBe(true);
    expect(isAppReviewTelegramId(-777_000_001n)).toBe(false);
    expect(isAppReviewTelegramId(-779_000_100n)).toBe(false);
    expect(isAppReviewTelegramId(123n)).toBe(false);
  });

  it("SQL filter carries the literal band", () => {
    expect(NOT_APP_REVIEW_ACCOUNT_SQL).toBe("u.telegram_id NOT BETWEEN -779000099 AND -779000001");
  });
});
