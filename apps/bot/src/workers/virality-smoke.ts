/**
 * Локальная проверка виральности на НАСТОЯЩЕЙ базе.
 *
 * Юнит-тесты проверяют формулы, тесты маршрутов — HTTP и форму ответа, но ни те
 * ни другие не выполняют ни одного SQL: prisma в них замокан. Этот скрипт
 * закрывает оставшийся зазор — что запросы валидны, что `@db.Date` кладётся и
 * читается тем же днём, что транзакция «удалить окно + вставить пачкой»
 * проходит, и что уникальный ключ дедупликации действительно отвергает повтор.
 *
 * Запускается вручную против ПУСТОЙ одноразовой базы, никогда не против прода:
 *
 *   createdb gennety_virality_smoke
 *   DATABASE_URL=postgresql://…/gennety_virality_smoke \
 *     pnpm --filter @gennety/bot exec tsx src/workers/virality-smoke.ts
 *   dropdb gennety_virality_smoke
 *
 * Отказывается работать на базе, в которой уже есть пользователи: перепутанный
 * `DATABASE_URL` — самая дешёвая и самая дорогая ошибка в этом жанре.
 */

import { prisma } from "@gennety/db";
import { recordInviteLinkClicked, recordShareSheetOpened } from "../services/referral-events.js";
import { readViralityCohorts, readViralityDays } from "../admin/utils/virality-source.js";
import { viralityRollupTick } from "./virality-rollup.js";

const DAY_MS = 86_400_000;

function log(label: string, value: unknown): void {
  console.log(`  ${label}:`, typeof value === "object" ? JSON.stringify(value) : value);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ПРОВАЛ: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function main(): Promise<void> {
  const existing = await prisma.user.count();
  if (existing > 0) {
    throw new Error(
      `база не пустая (${existing} пользователей) — это не одноразовая база, останавливаюсь`,
    );
  }

  const now = new Date();
  const day = (offset: number): Date => new Date(now.getTime() - offset * DAY_MS);

  console.log("\n1. Сеем когорту: 4 реферера 20 дней назад, из них двое привели друзей");
  const cohortAt = day(20);
  const referrers = await Promise.all(
    [1, 2, 3, 4].map((n) =>
      prisma.user.create({
        data: {
          telegramId: BigInt(1000 + n),
          createdAt: new Date(cohortAt.getTime() + n * 3_600_000),
          profile: { create: { homeCityKey: "kyiv", homeCity: "Kyiv" } },
        },
        select: { id: true },
      }),
    ),
  );

  // Двое приглашённых, оба дошли до верификации внутри окна наблюдения.
  await prisma.user.create({
    data: {
      telegramId: BigInt(2001),
      createdAt: day(19),
      referralSource: `referral:${referrers[0].id}`,
      referralCountedAt: day(18),
      profile: { create: { homeCityKey: "kyiv", homeCity: "Kyiv" } },
    },
  });
  await prisma.user.create({
    data: {
      telegramId: BigInt(2002),
      createdAt: day(18),
      referralSource: `referral:${referrers[1].id}`,
      referralCountedAt: day(17),
      profile: { create: { homeCityKey: "kyiv", homeCity: "Kyiv" } },
    },
  });

  console.log("\n2. Сеем органику и платный приток, чтобы у K_wom был и прирост, и семя");
  // Ровный органический фон, затем всплеск — база должна его заметить.
  let tg = 3000n;
  for (let offset = 40; offset >= 1; offset -= 1) {
    const organicToday = offset === 5 ? 9 : 2;
    for (let i = 0; i < organicToday; i += 1) {
      await prisma.user.create({ data: { telegramId: tg++, createdAt: day(offset) } });
    }
    if (offset <= 10) {
      await prisma.user.create({
        data: { telegramId: tg++, createdAt: day(offset), referralSource: "tg:ig_story" },
      });
    }
  }

  console.log("\n3. Воронка шеринга + проверка идемпотентности");
  const firstWrite = await recordShareSheetOpened({
    referrerId: referrers[0].id,
    preparedMessageId: "pm-smoke-1",
    surface: "tg-mini",
  });
  const secondWrite = await recordShareSheetOpened({
    referrerId: referrers[0].id,
    preparedMessageId: "pm-smoke-1",
    surface: "tg-mini",
  });
  assert(firstWrite, "первая запись шеринга легла");
  assert(!secondWrite, "повтор того же шеринга отвергнут уникальным ключом");

  const clickAt = day(19);
  await recordInviteLinkClicked({
    referrerId: referrers[0].id,
    clickerKey: "555",
    surface: "tg",
    at: clickAt,
  });
  const sameDayClick = await recordInviteLinkClicked({
    referrerId: referrers[0].id,
    clickerKey: "555",
    surface: "tg",
    at: new Date(clickAt.getTime() + 3_600_000),
  });
  assert(!sameDayClick, "повторный клик того же человека за те же сутки схлопнут");

  console.log("\n4. Прогон пересчёта (настоящий SQL, настоящая транзакция)");
  const first = await viralityRollupTick(now);
  log("результат", first);
  assert(first.dayRows > 0, "дневные строки записаны");
  assert(first.cohortRows > 0, "когортные строки записаны");
  assert(first.scopes >= 2, "кластерный срез (city:kyiv) выделен отдельно");

  console.log("\n5. Повторный прогон обязан быть идемпотентным");
  const second = await viralityRollupTick(now);
  assert(
    second.dayRows === first.dayRows && second.cohortRows === first.cohortRows,
    "второй прогон дал ровно столько же строк, сколько первый",
  );

  console.log("\n6. Чтение предагрегата обратно");
  const from = new Date(day(40).setUTCHours(0, 0, 0, 0));
  const to = new Date(now.setUTCHours(0, 0, 0, 0));
  const days = await readViralityDays(from, to, "global");
  const cohorts = await readViralityCohorts(from, to, { scope: "city:kyiv", maturityDay: 7 });

  const spikeDay = days.find((d) => d.organicSignups === 9);
  assert(spikeDay !== undefined, "день всплеска органики прочитан обратно");
  log("день всплеска", {
    day: spikeDay?.day,
    organic: spikeDay?.organicSignups,
    baseline: spikeDay?.baselineOrganic,
    uplift: spikeDay?.organicUplift,
    kWom: spikeDay?.kWom,
    womStatus: spikeDay?.womStatus,
  });
  assert(
    (spikeDay?.baselineOrganic ?? 0) > 1 && (spikeDay?.baselineOrganic ?? 0) < 3,
    "базовая линия ≈ 2, то есть посчитана по предыдущим дням, а не по этому",
  );
  assert((spikeDay?.organicUplift ?? 0) > 6, "прирост над базой посчитан");
  assert(spikeDay?.womStatus === "ok" && spikeDay?.kWom !== null, "K_wom вычислим при семени");

  const seeded = cohorts.find((c) => c.cohortSize === 4);
  assert(seeded !== undefined, "когорта из 4 рефереров прочитана в срезе города");
  log("когорта D7", {
    date: seeded?.cohortDate,
    size: seeded?.cohortSize,
    activations: seeded?.activations,
    kDirect: seeded?.kDirect,
    kTotal: seeded?.kTotal,
    cycleHours: seeded?.cycleTimeMedianHours,
    mature: seeded?.mature,
  });
  assert(seeded?.activations === 2, "обе активации отнесены к когорте рефереров");
  assert(seeded?.kDirect === 0.5, "K_direct = 2 активации / 4 человека = 0.5");
  assert(seeded?.mature === true, "когорта 20-дневной давности зрелая на D7");
  assert(
    (seeded?.cycleTimeMedianHours ?? 0) > 0,
    "время цикла посчитано от регистрации реферера",
  );

  console.log("\n7. Дата хранится и читается тем же днём (UTC, без сдвига)");
  const raw = await prisma.viralityDay.findFirst({
    where: { scope: "global" },
    orderBy: { day: "asc" },
  });
  assert(
    raw !== null && raw.day.toISOString().endsWith("T00:00:00.000Z"),
    "колонка @db.Date возвращается полночью UTC",
  );

  console.log("\nВСЁ ПРОШЛО.\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
