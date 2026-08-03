import { describe, it, expect } from "vitest";
import {
  HEALTH_CONFIG,
  classifyUser,
  computeFunnel,
  computeRegistrationBursts,
  isMatchmakingEligible,
  median,
  pct,
  rate,
  summarizeHealth,
  USER_HEALTH_CLASSES,
  type ClassifiedUser,
  type HealthUserInput,
  type UserHealthClass,
} from "./user-health.js";

const NOW = new Date("2026-08-03T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let seq = 0;
function user(overrides: Partial<HealthUserInput> = {}): HealthUserInput {
  seq++;
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    telegramId: String(100000 + seq),
    firstName: "Anna",
    email: null,
    status: "active",
    onboardingStep: "completed",
    verificationStatus: "verified",
    faceMatchScore: 0.97,
    faceMatchedAt: new Date(NOW.getTime() - 5 * DAY),
    createdAt: new Date(NOW.getTime() - 10 * DAY),
    lastMessageAt: new Date(NOW.getTime() - 1 * DAY),
    photoCount: 3,
    messageCountIn: 4,
    medianResponseSec: 40,
    responseSamples: 4,
    registrationBurstSize: 1,
    ...overrides,
  };
}

const classify = (u: HealthUserInput) => classifyUser(u, NOW);

// ---------------------------------------------------------------------------
// По одному тесту на класс
// ---------------------------------------------------------------------------
describe("classifyUser — классы", () => {
  it("live: активен, верифицирован, недавно писал, есть фото", () => {
    const v = classify(user());
    expect(v.classification).toBe("live");
    expect(v.matchmaking_eligible).toBe(true);
  });

  it("test: аккаунт по шаблону имени", () => {
    const v = classify(user({ firstName: "Test Account" }));
    expect(v.classification).toBe("test");
    expect(v.rules_fired).toContain("test_name_pattern");
  });

  it("test: аккаунт по явному списку telegram id", () => {
    const v = classifyUser(user({ telegramId: "555" }), NOW, {
      ...HEALTH_CONFIG,
      test_telegram_ids: ["555"],
    });
    expect(v.classification).toBe("test");
    expect(v.rules_fired).toEqual(["test_known_id"]);
  });

  it("stuck_onboarding: реально общался, но не закончил — с подклассом по шагу", () => {
    const v = classify(
      user({
        status: "onboarding",
        onboardingStep: "conversational",
        verificationStatus: "unverified",
        faceMatchScore: null,
        faceMatchedAt: null,
        photoCount: 0,
        lastMessageAt: new Date(NOW.getTime() - 2 * DAY),
        messageCountIn: 3,
      }),
    );
    expect(v.classification).toBe("stuck_onboarding");
    expect(v.subclass).toBe("conversational");
    expect(v.matchmaking_eligible).toBe(false);
  });

  it("cold_open_unengaged: ни одного сообщения и прошли сутки", () => {
    const v = classify(
      user({
        status: "onboarding",
        onboardingStep: "consent",
        verificationStatus: "unverified",
        faceMatchScore: null,
        faceMatchedAt: null,
        photoCount: 0,
        lastMessageAt: null,
        messageCountIn: 0,
        createdAt: new Date(NOW.getTime() - 3 * DAY),
      }),
    );
    expect(v.classification).toBe("cold_open_unengaged");
  });

  it("cold_open не срабатывает раньше порога — свежая регистрация уходит в other", () => {
    const v = classify(
      user({
        status: "onboarding",
        onboardingStep: "consent",
        verificationStatus: "unverified",
        faceMatchScore: null,
        faceMatchedAt: null,
        photoCount: 0,
        lastMessageAt: null,
        messageCountIn: 0,
        createdAt: new Date(NOW.getTime() - 2 * HOUR),
      }),
    );
    expect(v.classification).toBe("other");
    expect(v.reason).toContain("too early");
  });

  it("inactive: был активен, но молчит дольше порога", () => {
    const v = classify(user({ lastMessageAt: new Date(NOW.getTime() - 45 * DAY) }));
    expect(v.classification).toBe("inactive");
    expect(v.matchmaking_eligible).toBe(false);
  });

  it("other: активен и верифицирован, но без фото — в матчинг не пускаем", () => {
    const v = classify(user({ photoCount: 0 }));
    expect(v.classification).toBe("other");
    expect(v.matchmaking_eligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suspicious — по одному тесту на каждую из четырёх причин
// ---------------------------------------------------------------------------
describe("classifyUser — suspicious по каждой причине", () => {
  it("причина 1: много писал, но верификации нет", () => {
    const v = classify(user({ messageCountIn: 12, verificationStatus: "unverified" }));
    expect(v.classification).toBe("suspicious");
    expect(v.rules_fired).toContain("suspicious_unverified_spoke");
  });

  it("причина 2: фото есть, а сверки лица не было", () => {
    const v = classify(user({ faceMatchScore: null, faceMatchedAt: null, photoCount: 4 }));
    expect(v.classification).toBe("suspicious");
    expect(v.rules_fired).toContain("suspicious_missing_face");
  });

  it("причина 3: отвечает быстрее человека", () => {
    const v = classify(user({ medianResponseSec: 0.4, responseSamples: 14 }));
    expect(v.classification).toBe("suspicious");
    expect(v.rules_fired).toContain("suspicious_instant_replies");
  });

  it("причина 3 не срабатывает на маленькой выборке", () => {
    const v = classify(user({ medianResponseSec: 0.4, responseSamples: 3 }));
    expect(v.classification).toBe("live");
  });

  it("причина 4: зарегистрирован в пачке", () => {
    const v = classify(user({ registrationBurstSize: 5, verificationStatus: "unverified" }));
    expect(v.classification).toBe("suspicious");
    expect(v.rules_fired).toContain("suspicious_batch_registration");
  });

  it("причина 4 не трогает верифицированных — иначе рекламный залив обнулит ликвидность", () => {
    const v = classify(user({ registrationBurstSize: 25 }));
    expect(v.classification).toBe("live");
    expect(v.rules_fired).toEqual([]);
  });

  it("тестовый аккаунт выигрывает у suspicious — тесты не должны шуметь в фроде", () => {
    const v = classify(user({ firstName: "test bot", registrationBurstSize: 9 }));
    expect(v.classification).toBe("test");
  });

  it("suspicious выигрывает у stuck_onboarding — иначе бот-ферма растворится в воронке", () => {
    const v = classify(
      user({
        status: "onboarding",
        onboardingStep: "conversational",
        verificationStatus: "unverified",
        faceMatchScore: null,
        faceMatchedAt: null,
        photoCount: 0,
        lastMessageAt: new Date(NOW.getTime() - 1 * DAY),
        messageCountIn: 12,
      }),
    );
    expect(v.classification).toBe("suspicious");
    expect(v.rules_fired).toEqual(["suspicious_unverified_spoke"]);
  });
});

// ---------------------------------------------------------------------------
// Флаг допуска
// ---------------------------------------------------------------------------
describe("isMatchmakingEligible", () => {
  it("true только для live", () => {
    expect(isMatchmakingEligible("live")).toBe(true);
  });

  it.each(USER_HEALTH_CLASSES.filter((c) => c !== "live"))("false для %s", (cls) => {
    expect(isMatchmakingEligible(cls as UserHealthClass)).toBe(false);
  });

  it("список допущенных классов настраивается", () => {
    expect(
      isMatchmakingEligible("stuck_onboarding", {
        ...HEALTH_CONFIG,
        eligible_classes: ["live", "stuck_onboarding"],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Воронка и конверсии
// ---------------------------------------------------------------------------
function classified(u: HealthUserInput): ClassifiedUser {
  return { ...u, verdict: classify(u) };
}

describe("computeFunnel — тестовые аккаунты исключены из знаменателя", () => {
  // 16 реальных + 1 тестовый = 17 строк. Из реальных 5 активных верифицированных
  // и 9 прошедших consent — та самая ситуация, в которой старый activeRate
  // делил на всех подряд.
  const rows: ClassifiedUser[] = [];
  for (let i = 0; i < 5; i++) rows.push(classified(user()));
  for (let i = 0; i < 4; i++) {
    rows.push(
      classified(
        user({
          status: "onboarding",
          onboardingStep: "conversational",
          verificationStatus: "unverified",
          faceMatchScore: null,
          faceMatchedAt: null,
          photoCount: 0,
          messageCountIn: 2,
        }),
      ),
    );
  }
  for (let i = 0; i < 7; i++) {
    rows.push(
      classified(
        user({
          status: "onboarding",
          onboardingStep: "consent",
          verificationStatus: "unverified",
          faceMatchScore: null,
          faceMatchedAt: null,
          photoCount: 0,
          lastMessageAt: null,
          messageCountIn: 0,
          createdAt: new Date(NOW.getTime() - 5 * DAY),
        }),
      ),
    );
  }
  rows.push(classified(user({ firstName: "Test" })));

  const funnel = computeFunnel(rows);

  it("считает реальных без тестового аккаунта", () => {
    expect(rows).toHaveLength(17);
    expect(funnel.registered_real).toBe(16);
  });

  it("consent считается по шагу онбординга", () => {
    expect(funnel.gave_consent).toBe(9);
  });

  it("конверсия в активных делится на реальных, а не на всех", () => {
    expect(funnel.active_verified).toBe(5);
    // 5/16 = 31.25% → 31.3 при обычном округлении (в ТЗ пример округлён вниз
    // до 31.2). Главное здесь — знаменатель 16, а не 17.
    expect(funnel.conversion_registered_to_active_pct).toBe(31.3);
    expect(funnel.conversion_consent_to_active_pct).toBe(55.6);
  });

  it("activeRate тоже считается от реальных (баг 5/19 → 5/16)", () => {
    expect(rate(funnel.active_verified, funnel.registered_real)).toBe(0.3125);
  });

  it("сумма по классам сходится с общим числом строк", () => {
    const summary = summarizeHealth(rows);
    const sum = Object.values(summary.byClass).reduce((a, b) => a + b, 0);
    expect(sum).toBe(rows.length);
    expect(summary.real).toBe(16);
    expect(summary.matchmaking_eligible).toEqual({ count: 5, of_total: 16 });
  });
});

describe("pct / rate — деления на ноль нет", () => {
  it("pct возвращает null при пустом знаменателе", () => {
    expect(pct(0, 0)).toBeNull();
    expect(pct(3, 4)).toBe(75);
  });

  it("rate возвращает 0 при пустом знаменателе", () => {
    expect(rate(0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Вспомогательные
// ---------------------------------------------------------------------------
describe("computeRegistrationBursts", () => {
  it("считает соседей по окну, включая сам аккаунт", () => {
    const base = new Date("2026-08-01T10:00:00Z").getTime();
    const bursts = computeRegistrationBursts([
      { id: "a", createdAt: new Date(base) },
      { id: "b", createdAt: new Date(base + 2 * 60 * 1000) },
      { id: "c", createdAt: new Date(base + 4 * 60 * 1000) },
      { id: "far", createdAt: new Date(base + 6 * HOUR) },
    ]);
    expect(bursts.get("a")).toBe(3);
    expect(bursts.get("c")).toBe(3);
    expect(bursts.get("far")).toBe(1);
  });
});

describe("median", () => {
  it("null на пустом наборе", () => {
    expect(median([])).toBeNull();
  });

  it("среднее двух центральных при чётной длине", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});
