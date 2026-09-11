import { describe, expect, it } from "vitest";
import {
  identityTrustConfigurationErrors,
  paymentTrustConfigurationErrors,
  type IdentityTrustConfiguration,
  type PaymentTrustConfiguration,
  runtimeConfigurationErrors,
  type RuntimeConfiguration,
} from "./config.js";

function productionReady(
  overrides: Partial<IdentityTrustConfiguration> = {},
): IdentityTrustConfiguration {
  return {
    OTP_LOG_TO_CONSOLE: false,
    RESEND_API_KEY: "re_live_key",
    DEV_OTP_BYPASS_TELEGRAM_IDS: new Set(),
    DEMO_MODE_ENABLED: false,
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

  it("refuses to start production without a mail key", () => {
    // `sendOtpEmail` used to print the code to stdout whenever this was empty
    // — the second branch of `OTP_LOG_TO_CONSOLE || !RESEND_API_KEY`, and only
    // the first was guarded here. The key is assembled as
    // `RESEND_API_KEY ?? SMTP_PASS ?? ""`, so losing either variable produced
    // an empty string quietly: every registration code in plaintext in the log
    // and no email sent, which makes access to logs the email gate itself.
    expect(
      identityTrustConfigurationErrors(productionReady({ RESEND_API_KEY: "" }), "production"),
    ).toEqual([expect.stringContaining("RESEND_API_KEY")]);
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

/**
 * Платёжный контур — та же дисциплина, что и у контура личности.
 *
 * Аудит 2026-09-06 нашёл асимметрию: фейковый OTP не пускал процесс в прод, а
 * фейковые деньги пускали. `TICKET_STARS_ENABLED === "true"` дефолтится в
 * небезопасную сторону, то есть опасное состояние — это ровно то, что даёт
 * неполный `.env`. С 2026-09-11 mock-рельса нет вовсе, и прод без Stars — это
 * уже не бесплатные билеты, а пейволл, который никто не может оплатить; ассерт
 * остался, потому что такой деплой всё равно обязан отказать.
 */
function paymentsProductionReady(
  overrides: Partial<PaymentTrustConfiguration> = {},
): PaymentTrustConfiguration {
  return {
    DEMO_MODE_ENABLED: false,
    TICKET_FEATURE_ENABLED: true,
    TICKET_STARS_ENABLED: true,
    ...overrides,
  };
}

describe("payment trust configuration", () => {
  it("accepts production: билеты включены, Stars — единственный рельс", () => {
    expect(paymentTrustConfigurationErrors(paymentsProductionReady(), "production")).toEqual([]);
  });

  it("отказывается стартовать, когда в проде нечем принять оплату", () => {
    // Ровно то, что даёт потерянная при ротации строка: Stars выключены, а
    // других денежных рельсов нет — гейт и магазин не могут взять оплату.
    const errors = paymentTrustConfigurationErrors(
      paymentsProductionReady({ TICKET_STARS_ENABLED: false }),
      "production",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("TICKET_STARS_ENABLED must be true");
  });

  it("молчит, пока билеты вообще выключены", () => {
    // Рельса нет — и запрещать нечего.
    expect(
      paymentTrustConfigurationErrors(
        paymentsProductionReady({ TICKET_FEATURE_ENABLED: false, TICKET_STARS_ENABLED: false }),
        "production",
      ),
    ).toEqual([]);
  });

  it("пропускает три не-продовых рантайма", () => {
    const unsafe = paymentsProductionReady({ TICKET_STARS_ENABLED: false });
    expect(paymentTrustConfigurationErrors(unsafe, "development")).toEqual([]);
    expect(paymentTrustConfigurationErrors(unsafe, "test")).toEqual([]);
    // Демо — не самозаверение: assertDemoIsolation ТРЕБУЕТ Stars выключенными
    // (они двигали бы реальные звёзды посетителя) и отрабатывает раньше.
    expect(
      paymentTrustConfigurationErrors({ ...unsafe, DEMO_MODE_ENABLED: true }, "production"),
    ).toEqual([]);
  });
});

describe("runtime configuration", () => {
  /**
   * `required()` guards exactly two variables; everything else falls back to
   * `""`. The failures that produces are silent by construction: without
   * `JWT_SECRET` the public server logs one line and returns, so PM2 shows the
   * bot green, `/admin/health` answers, and the entire native iOS API is dead —
   * discovered by users complaining.
   */
  function complete(overrides: Partial<RuntimeConfiguration> = {}): RuntimeConfiguration {
    return {
      JWT_SECRET: "j".repeat(64),
      OPENAI_API_KEY: "sk-live",
      PHONE_AUTH_ENABLED: true,
      TWILIO_ACCOUNT_SID: "AC",
      TWILIO_AUTH_TOKEN: "token",
      TWILIO_VERIFY_SERVICE_SID: "VA",
      APNS_KEY_PATH: "/keys/AuthKey.p8",
      APNS_KEY_ID: "KEY",
      APNS_TEAM_ID: "TEAM",
      TICKET_FEATURE_ENABLED: true,
      APPSTORE_KEY_PATH: "/keys/SubscriptionKey.p8",
      APPSTORE_KEY_ID: "AKEY",
      APPSTORE_ISSUER_ID: "issuer",
      PROFILE_MUSIC_ENABLED: true,
      SPOTIFY_CLIENT_ID: "spotify-id",
      SPOTIFY_CLIENT_SECRET: "spotify-secret",
      SPOTIFY_TOP_TRACKS_ENABLED: false,
      SPOTIFY_REDIRECT_URI: "",
      ...overrides,
    };
  }

  it("requires Spotify's credentials while music is on, and the redirect only for the import", () => {
    expect(
      runtimeConfigurationErrors(complete({ SPOTIFY_CLIENT_SECRET: "" }), "production"),
    ).toEqual([expect.stringContaining("SPOTIFY_CLIENT_SECRET")]);
    // Off, the missing keys are simply the truth.
    expect(
      runtimeConfigurationErrors(
        complete({ PROFILE_MUSIC_ENABLED: false, SPOTIFY_CLIENT_ID: "", SPOTIFY_CLIENT_SECRET: "" }),
        "production",
      ),
    ).toEqual([]);
    expect(
      runtimeConfigurationErrors(complete({ SPOTIFY_TOP_TRACKS_ENABLED: true }), "production"),
    ).toEqual([expect.stringContaining("SPOTIFY_REDIRECT_URI")]);
    // The import alone has nowhere to put what it finds.
    expect(
      runtimeConfigurationErrors(
        complete({
          PROFILE_MUSIC_ENABLED: false,
          SPOTIFY_TOP_TRACKS_ENABLED: true,
          SPOTIFY_REDIRECT_URI: "https://api.example/v1/integrations/spotify/callback",
        }),
        "production",
      ),
    ).toEqual([expect.stringContaining("PROFILE_MUSIC_ENABLED")]);
  });

  it("accepts a complete configuration", () => {
    expect(runtimeConfigurationErrors(complete(), "production")).toEqual([]);
  });

  it("refuses to start with the native API silently disabled", () => {
    expect(runtimeConfigurationErrors(complete({ JWT_SECRET: "" }), "production")).toEqual([
      expect.stringContaining("JWT_SECRET"),
    ]);
  });

  it("requires a live rail's credentials, and only a live rail's", () => {
    // The flag is what says the rail is on, so its keys stop being optional.
    expect(
      runtimeConfigurationErrors(complete({ TWILIO_AUTH_TOKEN: "" }), "production"),
    ).toEqual([expect.stringContaining("TWILIO_AUTH_TOKEN")]);
    // Switched off, the same absence is simply the truth.
    expect(
      runtimeConfigurationErrors(
        complete({ PHONE_AUTH_ENABLED: false, TWILIO_AUTH_TOKEN: "" }),
        "production",
      ),
    ).toEqual([]);
  });

  it("refuses a half-configured APNs, and accepts none at all", () => {
    // APNs has no feature flag — "configured or not" is the whole switch — so
    // the rule is coherence. A partial set makes `apnsConfigured()` answer
    // false and every push is dropped with a warning nobody reads.
    expect(runtimeConfigurationErrors(complete({ APNS_KEY_ID: "" }), "production")).toEqual([
      expect.stringContaining("half-configured"),
    ]);
    expect(
      runtimeConfigurationErrors(
        complete({ APNS_KEY_PATH: "", APNS_KEY_ID: "", APNS_TEAM_ID: "" }),
        "production",
      ),
    ).toEqual([]);
  });

  it("stays out of the way in test and development", () => {
    const empty = complete({ JWT_SECRET: "", OPENAI_API_KEY: "" });
    expect(runtimeConfigurationErrors(empty, "test")).toEqual([]);
    expect(runtimeConfigurationErrors(empty, "development")).toEqual([]);
  });
});
