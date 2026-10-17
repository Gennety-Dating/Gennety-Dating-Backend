<!-- WHEN_TO_READ: You are an agent auditing how people actually use the Gennety apps (iOS, Mini App, bot) — where they get stuck, think long, tap in vain or drop off — through the read-only /admin/pulse/* endpoints, and turning that into ranked, code-level change proposals. Also the reference for the /admin/pulse/* JSON shapes. -->

# Аудит приложения по поведению людей (Pulse)

Плейбук агента `gennety-app-audit`. Спека — `docs/product/domains/pulse-analytics.md`.
Анализ уже сделан ночной работой (детерминированный SQL, без LLM); твоя работа — прочитать
готовые выводы, найти общий паттерн, открыть код и предложить конкретную правку.

## Доступ

```
Base URL: https://api-admin.gennety.com
Header:   Authorization: Bearer $ADMIN_READ_KEY
```

1. `ADMIN_READ_KEY` — ключ только для чтения. Он пропускает только `GET /admin/pulse/*` и
   `GET /admin/analytics/*`; всё остальное — `403`. Неверный ключ — `401`.
2. Лимит — 60 запросов в минуту с одного IP на весь админ-API. Полный прогон плейбука —
   около 15–25 запросов; не обходи экраны циклом по всему перечню.
3. Ответы кэшируются на 5 минут. Заголовки `X-Data-Generated-At` и `X-Data-Cache: hit|miss`;
   `?fresh=1` пересчитывает. Числа всё равно из ночного предагрегата — `fresh` не сделает их
   «сегодняшними».

```bash
curl -s -H "Authorization: Bearer $ADMIN_READ_KEY" https://api-admin.gennety.com/admin/pulse/brief
curl -s -H "Authorization: Bearer $ADMIN_READ_KEY" https://api-admin.gennety.com/admin/pulse/funnels
curl -s -H "Authorization: Bearer $ADMIN_READ_KEY" https://api-admin.gennety.com/admin/pulse/screens
curl -s -H "Authorization: Bearer $ADMIN_READ_KEY" https://api-admin.gennety.com/admin/pulse/screens/city
curl -s -H "Authorization: Bearer $ADMIN_READ_KEY" "https://api-admin.gennety.com/admin/pulse/journeys?stuck=1&limit=5"
curl -s -H "Authorization: Bearer $ADMIN_READ_KEY" https://api-admin.gennety.com/admin/pulse/journeys/<userId>
curl -s -H "Authorization: Bearer $ADMIN_READ_KEY" "https://api-admin.gennety.com/admin/pulse/insights?status=open"
curl -s -H "Authorization: Bearer $ADMIN_READ_KEY" https://api-admin.gennety.com/admin/pulse/catalog
```

## Endpoints

Источник истины для форм — `apps/bot/src/admin/utils/pulse-types.ts`. Время — ISO UTC,
дни — `YYYY-MM-DD` UTC. `asOf` — последний ЗАВЕРШЁННЫЙ день; «7 дней» = 7 дней по `asOf`
включительно, «28 дней» — аналогично. В каждом ответе есть общий конверт:

```jsonc
{
  "generatedAt": "2026-10-15T09:00:00.000Z",
  "dataFreshness": {
    "lastEventAt": "2026-10-15T08:58:12.000Z",   // последнее клиентское событие (received_at) или null
    "lastRollupAt": "2026-10-15T01:10:03.000Z",  // последний ночной пересчёт или null
    "rollupStale": false,                        // true — пересчёту > 36 ч или его не было
    "clientEventsEnabled": true,                 // false — экранных данных быть не может
    "optInShare": 0.41,                          // доля настоящих аккаунтов с согласием, 0..1
    "optInN": 34
  }
}
```

1. `GET /admin/pulse/brief` — с него начинается каждый прогон. Компактный (3–5 тыс. токенов).

   ```jsonc
   {
     "...": "конверт",
     "asOf": "2026-10-14",
     "thisWeek": { "from": "2026-10-08", "to": "2026-10-14" },
     "lastWeek": { "from": "2026-10-01", "to": "2026-10-07" },
     "kpis": [
       { "key": "new_users", "label": "Новые аккаунты", "thisWeek": 9, "lastWeek": 6, "unit": "people", "smallSample": true },
       { "key": "onboarding_completed", "label": "Закончили анкету (сервер: бот + iOS)", "thisWeek": 5, "lastWeek": 4, "unit": "people", "smallSample": true },
       { "key": "dates_scheduled", "label": "Пары, согласовавшие время (по дню создания пары)", "thisWeek": 1, "lastWeek": 2, "unit": "matches", "smallSample": true },
       { "key": "revenue_usd", "label": "Выручка, $ (оценка, Stars по курсу)", "thisWeek": 16.98, "lastWeek": 8.49, "unit": "usd", "smallSample": false }
     ],
     "insights": [
       { "id": "uuid", "kind": "stuck_people", "severity": 3, "scope": "city", "title": "6 человек без движения больше 48 ч: «Город»", "n": 6, "smallSample": true, "codeHint": "ios:App/Features/Onboarding/CityView.swift", "weight": 18 }
     ],
     "openInsights": 7,
     "next": [ { "endpoint": "/admin/pulse/funnels", "why": "Онбординг по платформам и путь свидания — где теряем людей" } ]
   }
   ```

2. `GET /admin/pulse/screens` — все экраны, где что-то было за 28 дней, по убыванию трения за 7 дней.

   ```jsonc
   {
     "...": "конверт", "asOf": "2026-10-14",
     "screens": [{
       "screen": "paywall", "title": "Пейвол", "platform": "ios", "known": true,
       "codeHint": "ios:App/Features/Premium/Paywall/PaywallView.swift",
       "d7":  { "views": 20, "viewerDays": 14, "left": 19, "dwellP50Ms": 4200, "dwellP90Ms": 15000,
                "firstActionP50Ms": 2600, "quickBack": 2, "deadTaps": 4, "rageTaps": 2, "exits": 2,
                "exitShare": null, "friction": 12.5, "smallSample": true },
       "d28": { "...": "та же форма" }
     }]
   }
   ```

   `friction` = `0.35·ярость + 0.25·мимо + 0.2·быстрый_уход + 0.2·сворачивание` на 100 показов.
   `exitShare` = null при n < 30 — смотри счётчики. `viewerDays` — сумма дневных уникальных установок.

3. `GET /admin/pulse/screens/:screen` — один экран за 28 дней.

   ```jsonc
   {
     "...": "конверт",
     "screen": "city", "title": "Город", "platform": "ios", "tracksTaps": true,
     "codeHint": "ios:App/Features/Onboarding/CityView.swift",
     "d7": { "...": "как в /screens" }, "d28": { "...": "как в /screens" },
     "days": [ { "day": "2026-10-14", "views": 5, "left": 5, "dwellP50Ms": 3100, "dwellP90Ms": 9000,
                 "firstActionP50Ms": 1800, "quickBack": 1, "exits": 0, "taps": 7, "deadTaps": 2, "rageTaps": 0 } ],
     "taps": { "points": [[0.51, 0.82], [0.49, 0.80]], "dead": [[0.12, 0.40]], "rage": [], "total": 2, "truncated": false },
     "elements": [ { "element": "city_kyiv", "taps": 5 } ],
     "versions": [ { "appVersion": "6.4", "views": 9, "quickBack": 1, "deadTaps": 2 } ],
     "items":    [ { "item": "waitlist_hint", "seen": 1, "viewerDays": 9 } ]
   }
   ```

   Координаты нормированы к размеру экрана (0..1, `[x, y]`, начало — левый верхний угол), новые первыми,
   не больше 2000 точек.

4. `GET /admin/pulse/journeys?stuck=1&limit=5` — пути людей (без `stuck=1` — недавно активных).
   `limit` ≤ 50, по умолчанию 20; у каждого ≤ 40 последних пунктов.
   `GET /admin/pulse/journeys/:userId` — один путь, ≤ 200 пунктов за 35 дней; `404`, если такого
   настоящего аккаунта нет.

   ```jsonc
   {
     "...": "конверт", "stuckOnly": true,
     "journeys": [{
       "userId": "0b8f…", "platform": "ios", "signupDate": "2026-10-09",
       "stuck": { "since": "2026-10-11T19:02:00.000Z", "where": "city", "whereTitle": "Город", "phase": "onboarding" },
       "items": [
         { "at": "2026-10-09T00:00:00.000Z", "kind": "server_milestone", "label": "Регистрация (день)" },
         { "at": "2026-10-11T19:00:10.000Z", "kind": "screen", "screen": "city", "dwellMs": 112000, "label": "Город — 2 мин, выход: background" },
         { "at": "2026-10-11T19:00:40.000Z", "kind": "tap_cluster", "screen": "city", "label": "4 касания, мимо: 3, ярость: 1" }
       ],
       "truncated": false
     }]
   }
   ```

   `/journeys/:userId` отдаёт `{ "...": "конверт", "journey": { …та же форма… } }`.

5. `GET /admin/pulse/funnels` — онбординг по трекам и путь свидания.

   ```jsonc
   {
     "...": "конверт", "asOf": "2026-10-14",
     "funnels": [{
       "id": "onboarding_ios", "title": "Онбординг iOS", "enteredD7": 11, "enteredD28": 40, "smallSample": false,
       "steps": [ { "step": "consent", "title": "Согласие", "d7": 11, "d28": 40, "conversionD7": null, "conversionD28": 0.9 } ]
     }],
     "money": [ { "dim": "paywall:today", "shown": 12, "dismissed": 10 } ]
   }
   ```

   Треки: `onboarding_ios` и `onboarding_miniapp` — экраны клиента (только люди с согласием),
   `onboarding_bot` и `onboarding_ios_server` — серверная анкета (все люди), `date` — путь свидания
   по дню создания пары (молодые когорты ещё дозревают). Человек считается в шаге один раз — в
   день первого достижения. `conversion*` = прошли ÷ вошли с предыдущего шага; null при n < 30.
   Шаг, который пары обходят (билет при бесплатно открытом календаре), сравнивается насквозь.

6. `GET /admin/pulse/insights?status=open|all` — находки целиком.

   ```jsonc
   {
     "...": "конверт", "status": "open",
     "insights": [{
       "id": "uuid", "key": "funnel_drop:onboarding_ios:city", "kind": "funnel_drop", "severity": 3,
       "scope": "onboarding_ios:city",
       "title": "Онбординг iOS: после «Город» до «Анкета: основное» дошли 6 из 11 за 7 дней; за 4 недели до этого — 18 из 20",
       "value": 0.4545, "baseline": 0.1, "n": 11, "smallSample": true,
       "evidence": { "funnel": "onboarding_ios", "from": "city", "to": "interview_basics", "entered": 11, "passed": 6 },
       "codeHint": "ios:App/Features/Onboarding/CityView.swift",
       "firstSeenAt": "…", "lastSeenAt": "…", "resolvedAt": null, "weight": 33
     }]
   }
   ```

   Виды: `stuck_people` (нет движения > 48 ч, по месту остановки), `funnel_drop` (шаг с наибольшей
   потерей за 7 дней против 4 прошлых недель), `screen_friction`, `slow_decision` (медиана времени
   до первого касания ≥ 2× базовой), `anomaly` (дневная метрика вне медиана ± 3·MAD за 28 дней,
   с учётом дня недели), `unseen` (блок ≥1 с видели ≤ 30% открывших экран). Находка, которая не
   повторилась при пересчёте, получает `resolvedAt`.

7. `GET /admin/pulse/catalog` — каталог метрик (`metrics[]`: `name`, `description`, `unit`, `dims`,
   `nMeans`, `minSample`, `thresholds`), все пороги (`thresholds`) и перечень экранов (`screens[]`:
   `screen`, `title`, `platform`, `codeHint`, `tracksTaps`, `onboardingOrder`).

## Правила

1. n < 30 — только абсолютные числа («6 из 11») и пометка «история, не статистика». Процентов не
   пиши, даже если очень хочется; API их в этом случае и не даёт.
2. Тестовые и синтетические аккаунты уже исключены сервером (`ADMIN_TEST_TELEGRAM_IDS`,
   `users.synthetic_at`, и все их установки). Не «чисти» данные сам — если видишь подозрительного
   человека, назови id и спроси.
3. В отчёте — никаких имён, телефонов, почт, текстов чатов и ответов анкеты. Людей называй только id
   (и то в приложении к отчёту, не в тексте находки). API этого и не отдаёт; не добывай это из
   других эндпоинтов.
4. Экранные данные есть только у людей с согласием на аналитику (`optInShare`). Если доля мала —
   экранные выводы описывают меньшинство; скажи это рядом с выводом. Серверные воронки
   (`onboarding_bot`, `onboarding_ios_server`, `date`) — про всех.
5. Визуальные правки — только предложения. Решает основатель; ничего не меняй в коде по итогам
   аудита без его «да».
6. Не путай «нет данных» и «ноль»: смотри `dataFreshness` раньше чисел.

## Плейбук

0. Свежесть. `GET /admin/pulse/brief` → `dataFreshness`.
   - `rollupStale: true` — ночной пересчёт не прошёл. Первой строкой отчёта: «данные на
     <lastRollupAt>», дальше осторожно; не объясняй продуктом то, что объясняется кроном.
   - `clientEventsEnabled: false` или `lastEventAt` старше суток — экранов нет, работай только с
     серверными воронками (шаги 2, 5, 6) и застрявшими.
   - Запиши `optInShare` — он понадобится в каждом экранном выводе.
1. Неделя. Из того же `/brief` — четыре KPI «эта неделя против прошлой». При `smallSample` — без
   процентов роста: «9 против 6».
2. Онбординг по платформам. `GET /admin/pulse/funnels` → `onboarding_ios`, `onboarding_miniapp`,
   `onboarding_bot` (и `onboarding_ios_server`). Для каждого трека — шаг с наибольшей потерей за 7 и
   за 28 дней; сравни треки между собой: один и тот же шаг тонет везде (вопрос анкеты) или только на
   одной платформе (экран).
3. Трение. `GET /admin/pulse/screens` → топ-5 по `d7.friction` (при `views` ≥ 5). Для каждого —
   `GET /admin/pulse/screens/:screen`: где лежат мёртвые касания и ярость (координаты: верх/низ,
   центр/край, рядом ли с кнопкой), какой элемент жмут, стало ли лучше с новой версией (`versions`),
   какие блоки не видят (`items`).
4. Застрявшие. `GET /admin/pulse/journeys?stuck=1&limit=5`. Прочитай пять путей целиком и найди
   общий паттерн: на каком экране, после какого действия, сколько сидели, чем закончилось
   (сворачивание, назад, ничего). Одна история — не паттерн; три из пяти — уже да.
5. Путь свидания. `/funnels` → `date`: показана → да → оба да → билеты → время → место → свидание →
   отзыв. Молодые пары ещё идут — смотри 28 дней рядом с 7.
6. Деньги. `/funnels` → `money` (пейвол и билет: показан против закрыт) + экраны `paywall`,
   `ticket_store`, `today_ticket_gate` из шага 3. Сколько раз показали, сколько закрыли, сколько
   думали до первого касания.
7. Эксперименты. Механизма A/B пока нет — так и напиши одной строкой; сравнения «до/после» делай
   только по `versions` экрана и по датам выката.
8. Код. Для трёх главных находок открой `codeHint`:
   - `ios:` — репозиторий `~/Developer/Gennety-iOS` (путь от его корня);
   - `backend:` — этот репозиторий (Mini App — `apps/webapp/src/…`, серверная анкета —
     `apps/bot/src/services/onboarding-collector.ts`).
   Назови конкретный элемент (вью, кнопку, условие) и конкретную правку. Не нашёл элемент —
   так и скажи; не выдумывай.
9. Отчёт. Находки по убыванию «затронуто людей × тяжесть». Каждая находка — четыре части:
   - факт с числами и n («6 из 11 за 7 дней, n = 11 — история, не статистика»);
   - гипотеза — почему так (одна, проверяемая);
   - правка — файл, элемент, что поменять (визуальное — как предложение основателю);
   - как измерим — какая метрика из `/catalog`, на каком экране/шаге, через сколько дней
     (обычно 7–14; при n < 30 — «смотрим истории в journeys», а не процент).
   В конце — одна строка про свежесть данных и `optInShare`.
