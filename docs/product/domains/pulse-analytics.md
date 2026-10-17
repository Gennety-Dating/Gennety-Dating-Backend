<!-- WHEN_TO_READ: You are touching product analytics — the analytics consent, client events (/v1/client/events), screen/tap tracking on iOS or the Mini App, the nightly pulse rollup, metric_days / insights, the /admin/pulse/* endpoints, or the gennety-app-audit agent playbook. -->

# Pulse — поведенческая аналитика без токенов

Решение основателя 2026-10-15 (журнал решений, запись того же дня). Исследование,
из которого выросла спека: артефакт «Пульс Gennety».

Цель: админ-панель и агент понимают, где человек застревает, сколько думает,
куда тыкает и что пропускает, — без LLM на этапе анализа. Анализ — детерминированный
SQL ночной работы; LLM (агент) читает только готовые выводы.

## 1. Принципы

1. Клиент шлёт только то, чего сервер не видит (правило 2026-08-20 сохраняется):
   экраны, время на экране, касания, видимость карточек. Регистрация, матч,
   оплата и прочие вызовы API в клиентские события не дублируются.
2. Никаких сторонних SDK. Приём — наш `POST /v1/client/events`, хранение — наш Postgres.
3. Согласие обязательно и отдельно.
   - Новая колонка `users.analytics_opt_in` (по умолчанию `false`) и
     `users.analytics_opt_in_at` (момент последнего изменения).
   - Это НЕ `research_opt_in`: тот разрешает исследовательское использование уже
     имеющихся данных, а этот — сбор нового класса данных (как `biometricConsentAt`).
   - Основание: §25 TDDDG (Германия), App Store 5.1.1(ii). ATT не нужен — данные
     никому не передаются.
4. Все клиентские события, включая старые десять типов, идут только с согласия.
5. Никаких PII в событиях. Строковые значения — короткий `snake_case`
   (`^[a-z0-9_]{1,32}$`), числа — в объявленных границах. Свободного текста нет.
6. Слежение за взглядом (ARKit/камера) запрещено правилом App Store 5.1.2(vi) и не
   делается. «Внимание» = видимость карточки ≥50% площади ≥1 с.
7. Демо-режим: демо-бот и синтетические аккаунты (`users.synthetic_at`) в аналитике
   исключаются везде одним фильтром; галочка согласия в демо-боте не показывается,
   события из демо-контура не собираются.

## 2. Согласие

1. Где человек его даёт.
   - iOS: галочка на существующем экране согласия (`ConsentView`), не отмечена по
     умолчанию, текст «Помогать улучшать Gennety: статистика экранов и нажатий, без
     переписок и фото». Слово «анонимная» не используется: события опознанного
     человека привязаны к аккаунту. Отдельного экрана-предупреждения нет.
   - iOS: переключатель в Настройках (раздел приватности) — включить и отозвать.
   - Mini App: такая же галочка на фазе `consent` онбординга.
2. API.
   - `POST /v1/onboarding/consent` и `POST /v1/telegram-onboarding/consent`
     принимают необязательный булев `analyticsOptIn`. Отсутствует — значение не меняется.
   - `PUT /v1/me/analytics-consent` (JWT), тело `{ "optIn": boolean }`, ответ
     `{ "analyticsOptIn": boolean }`. Отзыв (`false`) удаляет все `client_events`
     этого пользователя.
   - `GET /v1/me` отдаёт `user.analyticsOptIn`.
   - Состояние Telegram-онбординга (`/v1/telegram-onboarding/state`) отдаёт `analyticsOptIn`.
3. Поведение клиента до решения.
   - До ответа на экране согласия события копятся только в памяти и на диск не пишутся.
   - Согласие дано — очередь отправляется. Отказ или нет ответа — очередь стирается.
   - После входа клиент берёт значение из `GET /v1/me` (источник правды — сервер).
4. Поведение сервера: если батч опознан (JWT или `tma`) и у пользователя
   `analytics_opt_in = false`, ни одно событие не записывается, ответ
   `{ ok: true, accepted: 0, dropped: N, consent: false }`. Неопознанный батч
   (до входа) принимается — за него отвечает клиент по п. 3.

## 3. Контракт событий v2

1. Батч: `installId` (как раньше), `platform` (`ios` | `miniapp`, по умолчанию `ios`),
   `app { version, build, os, locale }`, `events[]`.
   - С авторизацией `tma` (Mini App) платформа принудительно `miniapp`.
2. Событие: `id` (UUID), `type`, `at` (ISO-время устройства), `props`,
   необязательный `session` (UUID сессии переднего плана; новая сессия после 30 мин в фоне).
3. Старые типы (`onboarding_step_left`, `permission_*`, `liveness_finished`,
   `paywall_*`, `ticket_gate_*`, `fatal_client_error`, `tempo_sync`) — прежняя
   форма, один строковый ключ.
4. Новые типы и их `props`.
   - `screen_view`: `screen` (строка, обяз.), `from` (строка, необяз.).
   - `screen_left`: `screen` (обяз.), `exit` (`next` | `back` | `background` |
     `dismiss`, обяз.), `dwell_ms` (целое 0…86 400 000, обяз., только время на
     переднем плане), `first_action_ms` (целое, необяз.; от появления до первого касания).
   - `tap`: `screen`, `element` (строки, обяз.), `x`, `y` (числа 0…1 от размеров
     экрана, обяз.). Только на ключевых экранах (п. 5) и только по элементам из перечня.
   - `dead_tap`: `screen` (обяз.), `x`, `y` (обяз.). Касание, которое не попало ни в
     один интерактивный элемент.
   - `seen`: `screen`, `item` (строки, обяз.), `visible_ms` (целое, обяз.).
     Отправляется, когда карточка ушла из видимости после ≥1 с при ≥50% площади.
5. Ключевые экраны, на которых пишутся `tap` и `dead_tap`: шаги онбординга,
   `today_pitch`, `today_ticket_gate`, `ticket_store`, `paywall`, `premium`,
   `today_calendar`, `today_venue_intent`, `prime_time`, `mini_onb_*`.
6. Сервер проверяет форму, а не перечень значений (новое приложение может прийти
   раньше деплоя). Неизвестный тип или битое событие отбрасывается поштучно.
   Числа округляются: координаты — до 3 знаков, миллисекунды — до целого.
7. Хранение: `client_events` получает колонки `platform` (`TEXT NOT NULL DEFAULT 'ios'`),
   `session_id` (UUID, null), `screen` (TEXT, null; копия `props.screen` для индекса),
   индекс `(screen, occurred_at)`. Ретеншен прежний — 90 дней; ночная работа успевает
   свернуть всё раньше.

## 4. Перечень экранов

Закрытый перечень живёт в `packages/shared/src/pulse-screens.ts`: ключ экрана →
платформа, русское название, путь к файлу (`codeHint`). Клиенты обязаны слать ключи
из него; сервер принимает и незнакомые (п. 3.6), админка показывает их как есть.

1. iOS, до оболочки (`GennetyApp.rootStep`): `language`, `phone_login`, `promo`,
   `consent`, `city`, `interview_basics`, `interview_chat`, `photos`, `verification`,
   `push_prompt`, `update_required`, `offline`.
2. iOS, оболочка (`RootView`): `map`, `today`, `tickets_wallet`, `chat`, `chat_hub`,
   `proxy_chat`, `profile`, `settings`, `premium`, `paywall`, `referral`.
3. iOS, путь свидания (`TodayModel.scene`): `today_pitch`, `today_awaiting_peer`,
   `today_calendar`, `today_planning`, `today_ticket_gate`, `today_venue_intent`,
   `today_scheduled`, `today_waiting`, `today_famine`, `today_paused`, `today_frozen`.
4. iOS, листы: `ticket_store`, `prime_time`, `venue_change`, `feedback`, `date_mode`.
5. Mini App: фазы онбординга `mini_onb_<phase>` (`visual`, `detail`, `syncing`,
   `consent`, `language`, `path`, `email`, `otp`, `phone`, `city`, `waitlist`, `theme`,
   `promo_gift`, `referral_gift`, `basics`, `loading`, `done`); страницы `mini_calendar`,
   `mini_verification`, `mini_location`, `mini_ticket`, `mini_tickets`,
   `mini_venue_change`, `mini_premium`, `mini_radar`, `mini_referral`, `mini_canvas`,
   `mini_date_terminal`, `mini_feedback`.

## 5. Ночная работа и выводы

1. `workers/pulse-rollup.ts`, расписание `PULSE_ROLLUP_CRON_SCHEDULE`
   (по умолчанию `10 1 * * *`, UTC), тот же каркас, что `virality-rollup`
   (`guardedTick`, идемпотентно, пересчёт хвоста в 35 дней).
2. Каталог метрик — `apps/bot/src/services/pulse/metrics-catalog.ts`: имя, описание по-русски,
   единица, зерно, порог, минимальная выборка. Тот же каталог отдаёт `GET /admin/pulse/catalog`.
3. `metric_days`: `(day, metric, dim)` → `value`, `n`, `computed_at`. Примеры метрик:
   `screen_views{screen}`, `screen_dwell_p50{screen}`, `screen_dwell_p90{screen}`,
   `screen_exit_back_fast{screen}`, `screen_dead_taps{screen}`, `screen_rage_taps{screen}`,
   `screen_first_action_p50{screen}`, `onboarding_step_reached{platform:step}`,
   `onboarding_completed{platform}`, `date_funnel{stage}`, `dau{platform}`,
   `analytics_opt_in_share`.
4. Детекторы (каждый пишет строки `insights`).
   - `stuck_people`: начал онбординг или путь свидания, нет движения >48 ч; группировка по последнему экрану.
   - `funnel_drop`: шаг с наибольшей потерей за 7 дней против 4 прошлых недель.
   - `screen_friction`: `0.35·rage + 0.25·dead + 0.2·quick_back + 0.2·exit` на 100 показов; топ экранов.
   - `slow_decision`: медиана `first_action_ms` выше базовой ×2.
   - `anomaly`: дневная метрика вне медианы ± 3·MAD за 28 дней (с учётом дня недели).
   - `unseen`: блок показан, но у >70% виден <1 с.
   - Ярость: ≥3 касания за 1 с в радиусе 0,06 по нормированным координатам. Быстрый
     уход: `exit = back` при `dwell_ms < 2000`.
5. Защита от шума: при `n < 30` находка формулируется абсолютными числами
   («6 из 11») и помечается `smallSample: true`; проценты не показываются.
6. `insights`: `id`, `key` (уникальный: `kind:scope`), `kind`, `severity` (1–3),
   `scope` (экран/шаг/метрика), `title` (шаблонный русский текст), `value`, `baseline`,
   `n`, `small_sample`, `evidence` (JSON: числа, id людей без PII), `code_hint`,
   `first_seen_at`, `last_seen_at`, `resolved_at`. Находка, которая не повторилась
   при пересчёте, получает `resolved_at`.

## 6. Чтение

1. Эндпоинты (админ-API, только GET).
   - `GET /admin/pulse/brief` — свежесть данных, 4 KPI недели против прошлой, открытые
     находки по весу, подсказки следующих запросов. Цель — 3–5 тыс. токенов.
   - `GET /admin/pulse/screens` — все экраны с трением, временем, выходами за 7/28 дней.
   - `GET /admin/pulse/screens/:screen` — один экран: метрики по дням, точки касаний
     (нормированные координаты, до 2000), разбивка по версиям приложения, `codeHint`.
   - `GET /admin/pulse/journeys?stuck=1&limit=20` — сжатые ленты пути людей (экраны,
     паузы, серверные вехи), без имён и текстов. `GET /admin/pulse/journeys/:userId` — одна лента.
   - `GET /admin/pulse/catalog` — каталог метрик.
   - `GET /admin/pulse/funnels` — онбординг по платформам и путь свидания.
2. Ключ только для чтения `ADMIN_READ_KEY`: пропускается ТОЛЬКО на `GET` и только на
   `/admin/pulse/*` и `/admin/analytics/*`. Основной `ADMIN_API_KEY` работает как раньше.
3. Плейбук агента — `docs/operations/agent-app-audit.md` (и скилл `gennety-app-audit`).

## 7. Порядок выката

1. Миграция `20261015120000_pulse_analytics` — чисто аддитивная, до рестарта кода.
2. Включить `CLIENT_EVENTS_ENABLED=true` и задать `ADMIN_READ_KEY`.
3. Выпустить iOS-сборку и задеплоить Mini App.
