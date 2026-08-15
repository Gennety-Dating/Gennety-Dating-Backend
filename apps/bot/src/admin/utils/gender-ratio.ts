/**
 * Пол пользователей — с явной долей тех, кто до вопроса не дошёл.
 *
 * Почему `unknown` отдельным числом, а не выброшен из знаменателя: пол
 * спрашивается на одном из первых экранов онбординга, и человек, бросивший
 * регистрацию раньше, остаётся `null`. На момент написания это **16 из 24**
 * реальных аккаунтов — то есть доминирующая корзина. Соотношение «7 мужчин к
 * 1 женщине», посчитанное по 8 заполнившим и поданное как расклад базы, врёт о
 * ней втрое; поэтому здесь две дроби рядом: среди ответивших и от всех.
 *
 * Для матчинга это не косметика: пул строго двусторонний, и перекос по полу —
 * первое, что упирается в потолок числа пар за дроп.
 */

import type { ClassifiedUser } from "./user-health.js";

export interface GenderRatio {
  male: number;
  female: number;
  /** Не дошли до вопроса о поле. */
  unknown: number;
  /** Всего реальных аккаунтов (тестовые исключены). */
  total: number;
  /** Доля мужчин СРЕДИ ответивших. `null`, если не ответил никто. */
  malePctOfKnown: number | null;
  femalePctOfKnown: number | null;
  /** Какая часть базы вообще не назвала пол. */
  unknownPctOfTotal: number | null;
}

function pct(num: number, den: number): number | null {
  if (den <= 0) return null;
  return +((num / den) * 100).toFixed(1);
}

export function computeGenderRatio(users: readonly ClassifiedUser[]): GenderRatio {
  let male = 0;
  let female = 0;
  let unknown = 0;

  for (const u of users) {
    if (u.verdict.classification === "test") continue;
    if (u.gender === "male") male++;
    else if (u.gender === "female") female++;
    else unknown++;
  }

  const known = male + female;
  const total = known + unknown;

  return {
    male,
    female,
    unknown,
    total,
    malePctOfKnown: pct(male, known),
    femalePctOfKnown: pct(female, known),
    unknownPctOfTotal: pct(unknown, total),
  };
}
