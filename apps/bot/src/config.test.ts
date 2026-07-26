import { describe, expect, it } from "vitest";
import {
  identityTrustConfigurationErrors,
  type IdentityTrustConfiguration,
} from "./config.js";

function productionReady(
  overrides: Partial<IdentityTrustConfiguration> = {},
): IdentityTrustConfiguration {
  return {
    OTP_LOG_TO_CONSOLE: false,
    DEV_OTP_BYPASS_TELEGRAM_IDS: new Set(),
    MANDATORY_VERIFICATION_ENABLED: true,
    FACE_LIVENESS_ENABLED: true,
    LIVENESS_STS_ROLE_ARN: "arn:aws:iam::147010141827:role/GennetyLivenessClient",
    AWS_ACCESS_KEY_ID: "AKIA_LIVE",
    AWS_SECRET_ACCESS_KEY: "secret-live",
    FACE_MATCH_PROVIDER: "rekognition",
    PROFILE_MEDIA_VALIDATION_ENABLED: true,
    ...overrides,
  };
}

describe("identity trust configuration", () => {
  it("accepts a production-ready configuration", () => {
    expect(identityTrustConfigurationErrors(productionReady(), "production")).toEqual([]);
  });

  it("rejects the legacy soft gate and a disabled liveness provider", () => {
    const errors = identityTrustConfigurationErrors(
      productionReady({
        MANDATORY_VERIFICATION_ENABLED: false,
        FACE_LIVENESS_ENABLED: false,
      }),
      "production",
    );
    expect(errors).toContain("MANDATORY_VERIFICATION_ENABLED must be true");
    expect(errors).toContain("FACE_LIVENESS_ENABLED must be true");
  });

  it("refuses to boot a half-configured liveness deploy", () => {
    // Flag on but no credentials / no STS role means the verification CTA
    // opens a Mini App that cannot start a check — fail at boot, not at the
    // user's first tap.
    const errors = identityTrustConfigurationErrors(
      productionReady({
        AWS_ACCESS_KEY_ID: "",
        AWS_SECRET_ACCESS_KEY: "",
        LIVENESS_STS_ROLE_ARN: "",
      }),
      "production",
    );

    expect(errors).toContain("AWS_ACCESS_KEY_ID must be configured");
    expect(errors).toContain("AWS_SECRET_ACCESS_KEY must be configured");
    expect(errors).toContain("LIVENESS_STS_ROLE_ARN must be configured");
  });

  it("has no sandbox escape hatch left to waive the identity gate", () => {
    // The Persona era shipped `ALLOW_SANDBOX_PERSONA`, which let production
    // run test-only KYC. Face Liveness has no sandbox/production key split, so
    // there is nothing equivalent to opt into — a production-like config is
    // either complete or it does not boot.
    const errors = identityTrustConfigurationErrors(
      productionReady({
        MANDATORY_VERIFICATION_ENABLED: false,
        PROFILE_MEDIA_VALIDATION_ENABLED: false,
      }),
      "production",
    );
    expect(errors).toContain("MANDATORY_VERIFICATION_ENABLED must be true");
    expect(errors).toContain("PROFILE_MEDIA_VALIDATION_ENABLED must be true");
  });

  it("rejects console OTP and dev bypass accounts outside development", () => {
    const errors = identityTrustConfigurationErrors(
      productionReady({
        OTP_LOG_TO_CONSOLE: true,
        DEV_OTP_BYPASS_TELEGRAM_IDS: new Set([123n]),
      }),
      "production",
    );

    expect(errors).toContain("OTP_LOG_TO_CONSOLE must be false outside development");
    expect(errors).toContain(
      "DEV_OTP_BYPASS_TELEGRAM_IDS must be empty outside development",
    );
  });

  it("does not treat a debug OTP flag as local when NODE_ENV is missing", () => {
    const errors = identityTrustConfigurationErrors(
      productionReady({ OTP_LOG_TO_CONSOLE: true }),
      "",
    );

    expect(errors).toContain("OTP_LOG_TO_CONSOLE must be false outside development");
  });

  it("allows explicit local and test configurations", () => {
    const unsafe = productionReady({
      OTP_LOG_TO_CONSOLE: true,
      MANDATORY_VERIFICATION_ENABLED: false,
      FACE_LIVENESS_ENABLED: false,
      FACE_MATCH_PROVIDER: "disabled",
    });
    expect(identityTrustConfigurationErrors(unsafe, "development")).toEqual([]);
    expect(
      identityTrustConfigurationErrors(
        { ...unsafe, OTP_LOG_TO_CONSOLE: false },
        "test",
      ),
    ).toEqual([]);
  });
});
