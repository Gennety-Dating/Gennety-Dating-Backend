import { describe, expect, it } from "vitest";
import {
  assertDemoIsolation,
  demoIsolationErrors,
  describeDatabase,
  type DemoIsolationConfig,
} from "./config.js";
import {
  identityTrustConfigurationErrors,
  type IdentityTrustConfiguration,
} from "../config.js";

function isolated(overrides: Partial<DemoIsolationConfig> = {}): DemoIsolationConfig {
  return {
    FOUNDER_NOTIFY_ENABLED: false,
    TICKET_STARS_ENABLED: false,
    ADMIN_API_KEY: "",
    ...overrides,
  };
}

describe("demo isolation guard", () => {
  it("accepts a properly isolated demo process", () => {
    expect(demoIsolationErrors(isolated())).toEqual([]);
    expect(() => assertDemoIsolation(isolated())).not.toThrow();
  });

  it("refuses to announce demo traffic into the founder ops chat", () => {
    const errors = demoIsolationErrors(isolated({ FOUNDER_NOTIFY_ENABLED: true }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("FOUNDER_NOTIFY_ENABLED");
  });

  it("refuses to take real Telegram Stars", () => {
    const errors = demoIsolationErrors(isolated({ TICKET_STARS_ENABLED: true }));
    expect(errors[0]).toContain("TICKET_STARS_ENABLED");
  });

  it("refuses to expose an admin surface", () => {
    const errors = demoIsolationErrors(isolated({ ADMIN_API_KEY: "secret" }));
    expect(errors[0]).toContain("ADMIN_API_KEY");
  });

  /**
   * The scenario the guard exists for: someone sets DEMO_MODE_ENABLED=true in
   * the PRODUCTION .env. Because demo is a recognised non-production runtime for
   * the identity gate, that flag would otherwise silently stop enforcing
   * liveness verification for real users. It must be a boot failure instead.
   */
  it("stops a production-shaped process from booting as a demo", () => {
    const productionEnv = isolated({
      FOUNDER_NOTIFY_ENABLED: true,
      ADMIN_API_KEY: "prod-admin-key",
    });
    expect(demoIsolationErrors(productionEnv)).toHaveLength(2);
    expect(() => assertDemoIsolation(productionEnv)).toThrow(/Refusing to start/);
  });
});

describe("database banner", () => {
  it("names the host and database but never the credentials", () => {
    const described = describeDatabase(
      "postgresql://postgres.abc:sup3rsecret@aws-0-eu-west-1.pooler.supabase.com:5432/postgres",
    );
    expect(described).toBe("aws-0-eu-west-1.pooler.supabase.com:5432/postgres");
    expect(described).not.toContain("sup3rsecret");
  });

  it("degrades rather than throwing on an unparseable URL", () => {
    expect(describeDatabase("not-a-url")).toBe("(unparseable DATABASE_URL)");
  });
});

describe("identity trust gate interaction", () => {
  function config(overrides: Partial<IdentityTrustConfiguration> = {}): IdentityTrustConfiguration {
    return {
      OTP_LOG_TO_CONSOLE: false,
      DEV_OTP_BYPASS_TELEGRAM_IDS: new Set(),
      DEMO_MODE_ENABLED: false,
      MANDATORY_VERIFICATION_ENABLED: false,
      FACE_LIVENESS_ENABLED: false,
      LIVENESS_STS_ROLE_ARN: "",
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      FACE_MATCH_PROVIDER: "disabled",
      PROFILE_MEDIA_VALIDATION_ENABLED: false,
      ...overrides,
    };
  }

  it("still fails closed for a production process with the flag unset", () => {
    // The whole point: nothing about adding a demo runtime may soften this.
    expect(identityTrustConfigurationErrors(config(), "production").length).toBeGreaterThan(0);
  });

  it("treats a demo process as a non-production runtime", () => {
    expect(
      identityTrustConfigurationErrors(config({ DEMO_MODE_ENABLED: true }), "production"),
    ).toEqual([]);
  });
});
