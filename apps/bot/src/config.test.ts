import { describe, expect, it } from "vitest";
import {
  identityTrustConfigurationErrors,
  paymentTrustConfigurationErrors,
  type IdentityTrustConfiguration,
  type PaymentTrustConfiguration,
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
 * фейковые деньги пускали. Оба флага дефолтятся в небезопасную сторону
 * (`TICKET_PAYMENT_MODE ?? "mock"`, `TICKET_STARS_ENABLED === "true"`), то
 * есть опасное состояние — это ровно то, что даёт неполный `.env`.
 */
function paymentsProductionReady(
  overrides: Partial<PaymentTrustConfiguration> = {},
): PaymentTrustConfiguration {
  return {
    DEMO_MODE_ENABLED: false,
    TICKET_FEATURE_ENABLED: true,
    TICKET_STARS_ENABLED: true,
    TICKET_PAYMENT_MODE: "mock",
    ...overrides,
  };
}

describe("payment trust configuration", () => {
  it("accepts production: билеты включены, Stars — единственный рельс", () => {
    expect(paymentTrustConfigurationErrors(paymentsProductionReady(), "production")).toEqual([]);
  });

  it("отказывается стартовать, когда mock-рельс открыт в проде", () => {
    // Ровно то, что даёт потерянная при ротации строка: Stars выключены,
    // значит PAY-1 не закрывает /intent + /confirm, а режим по умолчанию
    // выдаёт clientSecret и принимает его же назад как доказательство оплаты.
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
