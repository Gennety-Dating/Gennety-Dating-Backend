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
    MANDATORY_VERIFICATION_ENABLED: true,
    ENABLE_PERSONA_VERIFICATION: true,
    PERSONA_TEMPLATE_ID: "itmpl_live",
    PERSONA_ENVIRONMENT_ID: "env_live",
    PERSONA_API_KEY: "persona_prod_live",
    PERSONA_WEBHOOK_SECRET: "webhook-live",
    FACE_MATCH_PROVIDER: "rekognition",
    PROFILE_MEDIA_VALIDATION_ENABLED: true,
    ...overrides,
  };
}

describe("identity trust configuration", () => {
  it("accepts a production-ready configuration", () => {
    expect(identityTrustConfigurationErrors(productionReady(), "production")).toEqual([]);
  });

  it("rejects the legacy soft gate and Persona sandbox in production", () => {
    const errors = identityTrustConfigurationErrors(
      productionReady({
        MANDATORY_VERIFICATION_ENABLED: false,
        PERSONA_API_KEY: "persona_sand_test",
      }),
      "production",
    );
    expect(errors).toContain("MANDATORY_VERIFICATION_ENABLED must be true");
    expect(errors).toContain("PERSONA_API_KEY must be a production key, not persona_sand*");
  });

  it("allows explicit local and test configurations", () => {
    const unsafe = productionReady({
      OTP_LOG_TO_CONSOLE: true,
      MANDATORY_VERIFICATION_ENABLED: false,
      ENABLE_PERSONA_VERIFICATION: false,
      PERSONA_API_KEY: "persona_sand_test",
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
