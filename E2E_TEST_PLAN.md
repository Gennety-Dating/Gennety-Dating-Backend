# Gennety Dating — План E2E-тестирования (pre-prod)

> Назначение: полный прогон всех функций, API и внешних связок на **локальном
> DEP-боте `@gennetytestbot`** перед выкаткой в Production. Документ — рабочий
> чек-лист: отмечай `[x]` по мере прохождения, фиксируй найденные дефекты.
>
> Источник истины — код (`apps/bot/src/handlers`, `services`, `public`,
> `workers`). Этот файл описывает, *что* и *как* проверять, а не реализацию.
>
> **Ревизия 2026-07-27:** приведён в соответствие с текущей архитектурой —
> идентификация мигрировала с Persona на **AWS Rekognition Face Liveness**
> (26.07, нет вебхука/hosted-fallback, mandatory без Skip), онбординг работает
> по **Registration v2** (student email-OTP / general phone-контакт), фото
> `MIN_PHOTOS=4`/`MAX_PHOTOS=10` (бонус за 6+), venue-негоциация — **Venue
> Intent V2** (departure → vibe → чипы → confirm), **Venue Change v2** (платная
> shared-доска сердечек вместо female-only комментария), плюс новые
> платные/бонусные ветки — **Premium, Referral, Promo Codes, Type Radar** —
> уже включены во флагах текущего `.env.local` и должны быть покрыты прогоном.

## Методология прогона (читать первым)

Это **живой ручной E2E** на работающем dev-боте `@gennetytestbot` с **двумя
реальными Telegram-аккаунтами**, которые проходят онбординг **как два новых
пользователя**. Это НЕ симуляция и НЕ «прогон через функцию `ask_user`»: агент
не подменяет реальные действия пользователя опросами и не «разыгрывает» юзера
внутри диалога. Именно живой прогон на двух аккаунтах — самый простой и
наглядный способ увидеть весь функционал от и до.

**Роли:**
- **Оператор (человек)** выполняет ВСЕ реальные действия в Telegram и Mini
  Apps: `/start`, онбординг (язык / согласие / трек регистрации / город /
  тема / AI-memory / фото / видео), Face Liveness Mini App, тапы
  Accept/Decline, оплату (Stars-инвойсы), календарь, departure-origin + vibe +
  чипы, кнопки coordination / emergency / venue-change, фидбэк. Агент за него
  это НЕ делает.
- **Агент (Claude)** поднимает стек, по **команде оператора** триггерит
  серверные стадии через dev-скрипты (свести матч; сдвинуть «часы» матча для
  date-lifecycle) и **после каждого шага сверяет состояние на сервере**
  (`inspect-user.ts`, `db-snapshot.ts`, строка матча, логи бота). Оператор
  ведёт — агент триггерит и проверяет.

**Порядок прогона:**
1. Поднять весь стек (см. «Окружение») и проверить здоровье (Pass 0).
2. **Чистый онбординг:** `pnpm dev:reset-onboarding:apply` → оба аккаунта
   проходят `/start` с нуля, как новые пользователи (A male→women/student-трек,
   B female→men/general-трек, один и тот же город).
3. Оператор проходит онбординг и верификацию вживую; агент сверяет состояние
   (`onboardingStep=completed`, профиль, фото, `verificationStatus`, `status`).
4. По команде оператора агент сводит матч (`pnpm dev:trigger-test-match`) —
   дальше идут реальный питч → решение (Accept/Decline) → тикет-гейт → календарь
   → венью, оператор тапает сам.
5. Date-lifecycle гоняется **по одному гейту**: агент сдвигает `agreedTime`
   (`scripts/dev/advance-match-clock.ts`), реальный тик бота (каждые 2 мин) сам
   отправляет сообщения, а оператор наблюдает и взаимодействует вживую
   (icebreakers, emergency, safety, wingman, coordination, proxy, feedback).
   Агент после каждого гейта подтверждает по серверным маркерам, что он сработал.

**Обязательные операционные правила (без них прогон флапает):**
- Поднять весь стек **заранее** (Docker → dev-БД → бот → webapp → туннель); не
  считать, что он уже запущен.
- **Бот на время прогона запускать БЕЗ `tsx watch`** (тот же пред-загруз env,
  что в `scripts/dev-bot.mjs`, но `tsx src/index.ts` без `watch`). Любое
  сохранение файла под `tsx watch` перезапускает процесс и **убивает
  выполняющиеся fire-and-forget пайплайны** — например, верификацию (AWS
  вернул вердикт, но DM «верифицирован» не успевает уйти → юзер «зависает» на
  экране Mini App).
- **Во время прогона не редактировать файлы репозитория** — по той же причине
  (перезапуск бота рвёт async-стадии).
- **Сессия Face Liveness живёт 3 минуты** (создаётся при `/init`, умирает
  вместе со снимком, вебхука нет — вердикт читается синхронно внутри
  `/event`). Не открывать Verification Mini App заранее «про запас» и не
  оставлять её висеть — пройти проверку сразу, иначе сессия истечёт
  (ретраебл-исход `expired`, не `rejected`).
- Сверять каждый шаг на сервере, **прежде чем** идти дальше.
- `ask_user` / уточняющие вопросы — только для настоящих развилок (например,
  «триггерить эмердженси сейчас или идём дальше»), и НИКОГДА как замена реальных
  действий оператора в Telegram.

## Тестовые аккаунты

| Роль | Аккаунт | Telegram ID | Трек регистрации | Контактный рельс | Особенность |
|---|---|---|---|---|---|
| Главный (A) | `@GN01001` | `782065541` | **student** | реальный корпоративный email-OTP | **Полная** верификация Face Liveness, без пропусков |
| Запасной (B) | `@gennetysupport` | `5986970093` | **general** | Telegram one-tap «поделиться контактом» (`message.contact`) | Email-шаг **не существует** на этом треке — телефон одновременно и рельс, и логин; Rekognition/фото/Face Liveness — полноценно |

Bypass-лист `DEV_OTP_BYPASS_TELEGRAM_IDS` содержит только placeholder
`999000999` — оба реальных тестовых аккаунта идут **честными** треками
Registration v2 (не через email-обход). Placeholder существует только затем,
чтобы dev-скрипты, требующие непустой bypass-лист как guard, не отказывались
стартовать.

**Предусловие совместимости пары** (иначе матч-движок не сведёт A и B):
- gender-совместимы (напр. A = male / seeking women, B = female / seeking men);
- **один и тот же город матчинга** (`Profile.homeCityKey`) — задаётся в онбординге;
- треки регистрации могут различаться (matching допускает объединение
  student+email и general+phone когорт — трек партнёра не важен, важен только
  собственный рельс каждого);
- разные university-домены матчатся в одном городе (curated-венью требует общий
  домен — для проверки curated-пути выровнять домены через `dev:align-email-bypass`,
  актуально только для A, у B email-домена нет вовсе).

## Окружение (dev) — поднять перед прогоном

Компоненты:
- Dev-БД `gennety-dev-db` — `localhost:5434` / `gennety_dev`
- Dev-бот `@gennetytestbot` — публичный API `:3101`, Admin API `:3100`
  (логи: `/tmp/gennety-dev-bot.log`)
- Mini App (Vite) `:5173` + HTTPS-туннель на `WEBAPP_URL`
- Флаги ON: `TICKET_FEATURE_ENABLED` (+ `TICKET_STARS_ENABLED`, крошечные
  локальные цены `TICKET_BUNDLE_STARS=1:1,3:1,6:1`), `COORDINATION_FEATURE_ENABLED`,
  `VENUE_CHANGE_FEATURE_ENABLED` (+ `VENUE_CHANGE_STARS=1` локально),
  `DATE_CARD_FEATURE_ENABLED`, `MATCH_CARD_FEATURE_ENABLED`,
  `VENUE_INTENT_V2_ENABLED` (rollout 100% локально — venue-негоциация всегда
  идёт по V2), `ONBOARDING_FACT_COLLECTOR_ENABLED`, `ELO_VISION_SEED_ENABLED`,
  `PHONE_AUTH_ENABLED`, `MANDATORY_VERIFICATION_ENABLED` (Skip-кнопки в CTA
  нет), `FACE_LIVENESS_ENABLED` (AWS Rekognition Face Liveness, реальный,
  ~$0.015/чек), `FACE_MATCH_PROVIDER=rekognition` (реальный CompareFaces),
  Places (реальный), `PREMIUM_FEATURE_ENABLED`, `REFERRAL_FEATURE_ENABLED`,
  `PROMO_FEATURE_ENABLED`, `TYPE_RADAR_ENABLED` (+ `TYPE_PREF_FLOOR=0.7` —
  реальный вес скоринга, не shadow-заглушка как в проде)
- Флаг OFF (не в scope этого прогона): `REMATCH_FEATURE_ENABLED` — не задан
  локально → `false`. Если нужно покрыть Rematch, включить отдельно и
  перезапустить бота **до** старта прогона, не посреди него.
- `FOUNDER_NOTIFY_ENABLED=false` — обязательно, dev и prod делят один founder-бот
  и чат; включение здесь шлёт тестовые регистрации в реальный founder DM.

Поднятие стека (не считать, что уже запущено — проверять):
1. Docker: `open -a Docker`, дождаться демона (`docker info`).
2. Dev-БД: `pnpm dev:db:up`, затем `pnpm dev:db:push` (схема в синхроне).
3. **Бот без `tsx watch`** (стабильно для async-стадий): пред-загрузить env как
   в `scripts/dev-bot.mjs`, но запустить `tsx src/index.ts` без `watch`
   (например, минимальный лаунчер, спавнящий
   `pnpm --filter @gennety/bot exec tsx src/index.ts`). Дождаться строк
   `/v1/* API listening on :3101` и `Bot @gennetytestbot started`.
4. Webapp: `pnpm dev:webapp` (`:5173`).
5. HTTPS-туннель (ngrok на зарезервированном домене или cloudflared quick-tunnel)
   → `:5173`, проверить, что Mini App страницы отдаются `200` через `WEBAPP_URL`.
   Предпочесть **зарезервированный** домен (ngrok reserved / именной cloudflared
   tunnel) — quick-туннели эфемерны и могут упасть посреди многочасового
   прогона, унеся с собой Face Liveness и все Mini Apps разом.
6. `pnpm probe-liveness` — дешёвая (не биллится как реальный чек) проверка всех
   трёх AWS-разрешений (`CreateFaceLivenessSession` → `AssumeRole` →
   `GetFaceLivenessSessionResults`) до старта прогона.

> `pnpm dev:bot` запускает `tsx watch` — для длинного E2E это опасно (правки
> файлов перезапускают бота и рвут fire-and-forget пайплайны). На время прогона
> используем no-watch вариант выше и **не редактируем репозиторий**.
> После правок `.env.local` (флаги) — **полный** рестарт бота (не tsx-reload).

---

## Точки входа в сервис

| # | Путь | Механизм | Используется в тесте |
|---|---|---|---|
| 1 | Telegram `/start` (чистый) | Создаёт `User`, открывает Onboarding Mini App | ⭐ A и B |
| 2 | `/start referral_<id>` | Реферал-атрибуция `referral:<referrerId>` (Referral, §3.9) | опц. |
| 3 | `/start promo_<CODE>` | Промо-атрибуция `promo:<CODE>` (Promo Codes, §3.10); взаимоисключимо с referral | опц. |
| 4 | Track-aware `/start` | Registration v2 fork: student → email-OTP CTA, general → phone one-tap CTA | ⭐ A (student) / B (general) |
| 5 | Mobile `/v1/auth/otp/*` + `/v1/auth/phone/*` → `/v1/onboarding/*` | Синтетический отрицательный telegramId | опц. |
| 6 | Verification Mini App → `/v1/verification/mini-app/init` + `/event` | AWS Face Liveness сессия минтится и завершается синхронно внутри запроса; **вебхука нет** | через Pass 2 |
| 7 | Mini Apps (onboarding/calendar/verification/ticket/tickets/venue-change/location/feedback/premium/referral/radar) | `web_app` + initData HMAC | через профильные passes |

---

## Каталог функций (что должно быть покрыто)

- **Онбординг:** `/start`, Onboarding Mini App (интро/язык/согласие/**трек
  регистрации**/город/тема/AI-memory), conversational fact-collector
  (имя+возраст→пол→предпочтение→рост→хобби→требования→нац/этнос→**vibe
  (friday_vibe/vibe_focus)**→**Type Radar (опц., скипаемо)**→AI-memory→фото),
  голосовой ввод (Whisper), ветки AI-memory `accepted`/`declined`/`undecided`,
  фото `MIN_PHOTOS=4`/`MAX_PHOTOS=10` + дедуп + usable-face/obstruction гейт +
  альбомы, Live Photos + видео, тикет-бонусы (6+ фото, видео), студенческий
  бонус (+2 тикета при верификации email), re-engagement.
- **Верификация (AWS Rekognition Face Liveness):** Verification Mini App —
  Amplify `FaceLivenessDetectorCore` стримит селфи-видео **device → AWS**
  напрямую внутри Telegram WebView, сессия живёт 3 минуты, вердикт читается
  сервером синхронно в `/event` (**вебхука и hosted-fallback нет**). Pipeline
  (AWS вердикт → Rekognition CompareFaces → quorum verified/rejected/pending_review),
  AI-vision Elo seed, тикет-бонуса за верификацию больше нет (retired), авто-rerun
  при правке фото, match-pool exclusion, 90-дневный selfie-retention.
  **`MANDATORY_VERIFICATION_ENABLED=true` → кнопки Skip нет вообще** (soft-skip
  — retired production-путь, недоступен в этой конфигурации).
- **Profiler:** батчи Q&A, rush-режим, skip-логика, локальные окна.
- **Меню:** My Profile, Edit Profile (фикс identity), Pause/Resume, Settings
  (язык, тема), My Tickets (кошелёк + store), **Gennety Premium** (хаб +
  in-chat отмена подписки), status-banner countdown.
- **Матчинг:** pre-match teaser, weekly batch, no-match notice, scoring
  (embedding/research/V_league/V_agePref/V_type/penalty/starvation + male
  reach), hard SQL-фильтры, питч + Synergy + стриминг + **Match Card**
  (коллаж вместо простого альбома фото), welcome-gift, blind decision (все
  ветки), nudges (+ deadline heads-up), причина отказа → constraints.
- **Ticket gate:** Ticket Mini App, **Telegram Stars оплата** (реальный
  инвойс, крошечная локальная цена), use-ticket, pay-for-both (male),
  partner-paid, famine-discount, refund/expiry.
- **Calendar:** 6×14 сетка (13:00–19:30 каждые 30 мин), multi-pick, live
  peer-visibility, 0/1/>1 overlap, first-mover DMs.
- **Venue (Venue Intent V2):** departure-origin **первым** (Location Mini
  App) → free-text vibe → редактируемые канонические чипы (Experience /
  Atmosphere / Format / Must-haves) → одно явное подтверждение; curated-first
  → Places fallback; grounded-blurb; `date_time` entity; **Date Card** (PNG +
  shine + protect + Share-blur).
- **Venue Change v2 (платная shared-доска):** кнопка у ОБЕИХ сторон,
  каталог в 3 км, сердечки с live-sync (~4с), overlap = согласие (calendar-
  механика), payer-матрица (hetero: платит мужчина/инициатор; same-sex —
  инициатор), Stars-оплата (локально 1⭐), female express unilateral-swap,
  «Keep this place» way-back, lapse НЕ отменяет матч, Premium-инфраструктура
  (locked premium-венью + fee waiver для подписчиков).
- **Premium:** ✨-хаб в меню, Stars recurring-подписка (`subscription_period`),
  premium-венью в Venue Change, in-chat отмена через menu-агент
  (`offer_cancel_premium`).
- **Referral:** ladder-прогресс, share-card, welcome Premium-месяц инвайти,
  milestone-тикеты рефереру при верификации друга.
- **Promo Codes:** независимая кампания (`pnpm promo:create`), богатый wow-экран
  (1 тикет + 3 месяца Premium), взаимоисключимо с Referral.
- **Type Radar:** скипаемый визуальный шаг «выбери свой тип» перед Magic
  Prompt, `Profile.appearanceTags`/`typePrefTags`, реальный вес в скоринге
  (`TYPE_PREF_FLOOR=0.7` локально).
- **Date lifecycle:** wingman, icebreakers (T-5ч), emergency window, safety
  brief (T-1.5ч), wingman reveal, coordination offer (T-1ч), proxy chat
  (T-30м/T+2ч), feedback (T+24ч) + Feedback Mini App + голос.
- **Trust & Safety:** reports tier 1/2/3 (категория репорта задаёт
  floor/ceiling для LLM-триажа), strikes/suspend/ban, auto-unsuspend,
  emergency-cancel.
- **Cross-cutting:** quiet hours, starvation, embedding refresh, GDPR
  delete/selfie scrub/data-retention sweep, 5 языков.
- **API:** публичный `/v1/*` (JWT + initData HMAC), admin `/admin/*` (Bearer);
  **у Face Liveness вебхука нет** — только `/v1/verification/mini-app/*`.

---

## Dev-инструментарий (гард-защищён: только dev-БД + непустой bypass-лист)

| Команда | Назначение |
|---|---|
| `pnpm --filter @gennety/bot exec tsx scripts/dev/db-snapshot.ts` | Снимок users/matches |
| `pnpm --filter @gennety/bot exec tsx scripts/dev/inspect-user.ts <tgId>` | Глубокое состояние пользователя |
| `pnpm --filter @gennety/bot exec tsx scripts/dev/check-eligibility.ts <id> <id>` | Почему пара матчится/нет |
| `pnpm --filter @gennety/bot exec tsx scripts/dev/reset-accounts.ts --apply <id> [<id>]` | Полный wipe аккаунтов |
| `pnpm --filter @gennety/bot exec tsx scripts/dev/advance-match-clock.ts <matchId> agreed -3h` | Сдвиг тайм-якорей матча (lifecycle/expiry) |
| `pnpm --filter @gennety/bot exec tsx scripts/dev/force-match-batch.ts` | Запустить реальный weekly-батч сейчас |
| `pnpm dev:reset-onboarding:apply` | Чистый онбординг для A+B |
| `pnpm dev:trigger-test-match` | Форс `proposed` + dispatch (реальный питч) |
| `pnpm dev:watch-and-match` | Авто-матч, как только оба завершат онбординг |
| `pnpm dev:e2e-full-flow` | Авто-прогон всей пост-онбординг цепочки (требует ticket-flag OFF) |
| `pnpm --filter @gennety/bot exec tsx ../../scripts/dev-continue-date.mjs` | Провести текущий матч через все стадии (ticket-aware) |
| `pnpm --filter @gennety/bot exec tsx ../../scripts/dev-trigger-scheduling.mjs` | Матч → mutual-accept → calendar (дальше люди сами) |
| `pnpm --filter @gennety/bot exec tsx ../../scripts/dev-send-verification-cta.mjs --tg=<id>` | Переотправить verification CTA напрямую (Face Liveness Mini App, не Persona) |
| `pnpm dev:align-email-bypass --apply` | Выровнять email-домен A (для curated-венью); у B (general-трек) email-домена нет |
| `pnpm dev:db:studio` | Prisma Studio |
| `pnpm probe-liveness` | Проверка 3 AWS-разрешений Face Liveness (не биллится) |
| `pnpm face-eval-user` / `scripts/face-eval.ts` | Оценка качества Rekognition face-match |
| `pnpm promo:create --code=... --tickets=1 --months=3` | Создать промокод для Pass Promo (нужен ДО теста атрибуции) |

---

## Проходы (passes)

### Pass 0 — Подготовка
- [ ] `db-snapshot.ts` — зафиксировать стартовое состояние
- [ ] (при переигрывании) `pnpm dev:reset-onboarding:apply`
- [ ] Health: `curl -s localhost:3101/v1/ping` → `{"ok":true}`; туннель-URL
      открывается; `curl -sI localhost:3100` → 401
- [ ] `pnpm probe-liveness` → все три AWS-разрешения зелёные
- [ ] (если планируется Pass Promo) заранее создать код: `pnpm promo:create --code=E2ETEST --tickets=1 --months=3`

### Pass 1 — Онбординг
- [ ] A (`@GN01001`, **student-трек**): полный email-OTP (реальный
      корпоративный), Mini App все экраны, город, тема, **AI-memory =
      accepted** (Magic Prompt → анимация анализа), фото 4..10
- [ ] A: дедуп — отправить копию/скрин/кроп → отклонение с объяснением
- [ ] A: тикет-бонус за 6+ фото; добавить видео → второй бонус
- [ ] B (`@gennetysupport`, **general-трек**): вместо email — Telegram
      one-tap «поделиться контактом» (`message.contact`, трастед Telegram),
      **AI-memory = declined** (fallback-summary + эмбеддинг), фото, видео
- [ ] Type Radar: на одном из аккаунтов пройти шаг «выбери свой тип» (24
      портрета, `radar.html`), на другом — Skip; проверить
      `Profile.typeRadarCompletedAt`/`appearanceTags`
- [ ] Серверная проверка: `inspect-user.ts` для каждого (onboardingStep,
      registrationTrack, профиль, фото, verificationStatus)
- [ ] Profiler: первый батч (`~10 мин` после finalize); проверить
      `profilerNextAt`, Skip-кнопку
- [ ] Все 5 языков: переключить Settings, проверить i18n

### Pass 2 — Верификация (AWS Rekognition Face Liveness + CompareFaces, оба реальные)
- [ ] A и B: CTA (**без кнопки Skip** — `MANDATORY_VERIFICATION_ENABLED=true`)
      → Verification Mini App → Face Liveness детектор внутри Telegram
      WebView (селфи стримится device → AWS напрямую, сессия 3 минуты)
- [ ] Терминальное событие детектора → `POST /v1/verification/mini-app/event`
      → сервер синхронно читает `GetFaceLivenessSessionResults` (**вебхука
      нет**) → на pass запускается CompareFaces pipeline
- [ ] `inspect-user.ts`: `verificationStatus=verified`, `photoFaceScores`
      (1:1 с photos), `eloSeedDetails`; `personaInquiryId` в БД теперь
      хранит AWS session id (историческое имя колонки)
- [ ] `face-eval-user` — разумность скоров (пороги `FACE_MATCH_THRESHOLD_VERIFY`
      0.85 / `_REVIEW` 0.75)
- [ ] Negative-path: подставное лицо/чужое фото → `rejected` (по крайней мере
      один `fail`-скор); групповое фото → `no_face`/`pending_review`
- [ ] Retryable-исход (не rejected!): не пройденная проверка живости →
      `pending` + одна из трёх честных nudge-копий (`not_live` /
      `expired`/`in_progress` / `no_reference`) с кнопкой Verify
- [ ] Правка фото после verified → авто-rerun pipeline (без повторного
      Liveness-прохода, если референс-селфи ещё не скраблен)
- [ ] Soft-skip **не тестируется в этой конфигурации** —
      `MANDATORY_VERIFICATION_ENABLED=true` убирает Skip-кнопку из CTA и
      отказывает легаси skip-колбэкам. Если нужно явно покрыть этот путь,
      временно выставить флаг `false` и **полностью перезапустить бота** до
      начала отдельного прогона (не посреди текущего).

### Pass 3 — Меню / профиль / кошелёк
- [ ] My Profile, Edit Profile (убедиться: `firstName/age/email/domain` неизменяемы)
- [ ] Settings — смена языка и темы; Pause/Resume (статус → paused/active)
- [ ] My Tickets — баланс из бонусов; store Mini App: покупка bundle 1/3/6 через
      Telegram Stars-инвойс (`TICKET_STARS_ENABLED=true`, локальная цена
      1⭐/бандл) → баланс растёт, `TicketLedger` с `externalPaymentId`
- [ ] Status-banner — live countdown к следующему батчу

### Pass 4 — Матчинг + питч
- [ ] `check-eligibility.ts A B` → подтвердить совместимость; затем
      `pnpm dev:trigger-test-match` (или `force-match-batch.ts`, или
      `pnpm dev:watch-and-match`)
- [ ] Питч: стриминг (rich `<tg-thinking>` draft, финальное сообщение —
      обычный `sendMessage`), **Match Card** коллаж (card 1 = фото + панель
      имя/vibe/абзац, следующие — full-bleed фото) вместо простого альбома,
      **Synergy 70–99** + per-side rationale на языке каждой стороны
- [ ] **Welcome gift**: видео-кружок + тикет на ПЕРВОМ питче (идемпотентно —
      на втором не повторяется)
- [ ] Countdown-плита на питче (`proposal-countdown`, обновляется каждую
      минуту)
- [ ] Blind decision — прогнать ветки: accept/accept; accept/decline; decline/decline
- [ ] TTL expiry: `advance-match-clock.ts <matchId> dispatched -25h` → expiry
      cron → корректные сообщения (asymmetry «missed a date»); отдельно
      проверить deadline-heads-up нудж (~2ч до истечения)
- [ ] Причина отказа → `negativeConstraints` (проверить `inspect-user`)

### Pass 5 — Ticket gate (flag ON, Telegram Stars)
- [ ] На mutual-accept приходит Ticket-карточка обоим
- [ ] «Use a ticket» (списание из кошелька); male «Pay for both» через Stars
      (локальная крошечная цена); female «Pay my ticket» через Stars
- [ ] Partner-paid screen у второй стороны + read-receipt DM инициатору
      («she saw it ❤️»)
- [ ] Hard gate: Calendar НЕ открывается, пока оба тикета не оплачены
- [ ] Expiry/refund: backdate `ticketExpiresAt` → `ticket-expiry` cron
      возвращает Stars/восстанавливает кошелёк и открывает Calendar бесплатно

### Pass 6 — Calendar
- [ ] Оба открывают Calendar Mini App; 4 состояния слотов (empty/mine/peer-only/overlap)
- [ ] Live peer-visibility (polling ~4с) — метки партнёра появляются
- [ ] 0 overlap → first-mover DMs; 1 overlap → auto-lock; >1 overlap → confirm-card
- [ ] Замена calendar-карточки при новом предложении (не накапливаются)

### Pass 7 — Venue Intent V2 + Date Card
- [ ] Departure-origin **первым** (Location Mini App: геолокация / автокомплит
      / тап-на-карте / drag)
- [ ] Free-text vibe + редактируемые канонические чипы (Experience /
      Atmosphere / Format / Must-haves) → одно явное Confirm
- [ ] Venue: curated-first → Places fallback (реальное место, открывается в
      Maps, grounded-blurb по фактам, `date_time` entity); для curated-пути —
      `dev:align-email-bypass --apply` (только домен A)
- [ ] **Date Card**: PNG (фото партнёра + венью), «shine» прогресс держится
      до готовности, `protect_content`
- [ ] **Share** → re-render с blur лица, без protect; fail-safe (blur не
      вышел → share отменён)

### Pass 7b — Venue Change v2 (платная shared-доска)
- [ ] Кнопка «Change venue» доступна ОБЕИМ сторонам на scheduled-карточке
      (без предупреждающего диалога)
- [ ] Доска: каталог в 3 км от текущей венью, curated-first; сердечки с
      live-sync (~4с); overlap → согласие (single = auto, multi = confirm-card)
- [ ] Payer-матрица: hetero — платит мужчина/инициатор (Stars, локально 1⭐);
      его финальное «not this time» ЗАКРЫВАЕТ сессию без списания у неё
- [ ] Female express unilateral-swap (мгновенный платный свап без согласования)
- [ ] «Keep this place» way-back до оплаты — откатывает к исходной венью
- [ ] Lapse (по TTL) — исходная венью остаётся, матч НЕ отменяется, без Elo-штрафа
- [ ] С `PREMIUM_FEATURE_ENABLED=true`: premium-венью показаны locked, апсел
      подписки; активная подписка делает смену бесплатной

### Pass 8 — Date lifecycle
- [ ] `dev-continue-date.mjs` (ticket-aware) ИЛИ вручную `advance-match-clock.ts`
- [ ] Icebreakers (T-5ч, 3 на сторону) + emergency window
- [ ] Female safety brief (T-1.5ч) + wingman reveal
- [ ] Coordination offer (T-1ч): Variant A (share self) / B (request partner + consent) / C (proxy)
- [ ] Proxy chat open (T-30м): relay text-only, media отклоняется, Report-кнопка, `ProxyMessage`-лог; close (T+2ч)
- [ ] Emergency protocol: confirmation guard → verbatim relay (blockquote) → cancel + peer Elo-bump
- [ ] Feedback (T+24ч): Feedback Mini App (slider/segmented/textarea) + голосовой fallback → `feedbackByA/B` + LLM-анализ → constraints

### Pass 9 — Trust & Safety
- [ ] Report tier 1 (preference) → constraints, без штрафа
- [ ] Report tier 2 (ethical) → strike 1 warning, strike 2 suspend 14д, strike ≥3 ban
- [ ] Report tier 3 (safety) — доступен только через категории
      `wrong_person`/`unsafe_red_flag`/`spam_or_fraud` → pending_investigation
      + cancel in-flight
- [ ] Дубль-репорт `(reporterId, matchId)` → `reportDuplicate`
- [ ] Auto-unsuspend по истечении

### Pass 10 — Premium / Referral / Promo (новые монетизационные ветки)
- [ ] **Premium**: ✨-хаб в меню → Premium Mini App → Stars recurring-инвойс;
      после оплаты в Venue Change открываются premium-венью
- [ ] Premium: in-chat отмена через диалог с menu-агентом
      (`offer_cancel_premium` tool) → nonce-bound confirm card → подписка
      лапсит на `premiumUntil` без досрочного отзыва
- [ ] **Referral** (опц., один из двух аккаунтов на чистом онбординге):
      `/start referral_<id>` → онбординг → wow-экран с welcome Premium-месяцем
      у инвайти; после верификации инвайти — ladder-прогресс/тикет у реферера
- [ ] **Promo** (опц., взаимоисключимо с Referral на одном аккаунте):
      предварительно созданный код → `/start promo_<CODE>` → богатый wow-экран
      (тикет + 3 месяца Premium) → `PromoRedemption` строка

### Pass 11 — API + внешние связки
- [ ] Публичный: `/v1/ping`, `/v1/auth/otp/*`, `/v1/auth/phone/*`, `/v1/me*`,
      `/v1/matches/*`, `/v1/calendar/*`, `/v1/tickets/*`, `/v1/venue-change/*`,
      `/v1/premium/*`, `/v1/referral/*`, `/v1/verification/mini-app/*` — 401
      без auth
- [ ] Admin: `localhost:3100` без Bearer → 401; с ключом — роутеры
      audience/algorithm/gender/retention/dates/verification/onboarding-funnel
- [ ] **AWS Face Liveness** (реальный): `CreateFaceLivenessSession` →
      `GetFaceLivenessSessionResults` в логах, без вебхука
- [ ] **Rekognition CompareFaces** (реальный): корректные `photoFaceScores`
- [ ] **Google Places** (реальный): реальные венью, quality-gate отсекает мусор
- [ ] **OpenAI**: питч/эмбеддинг/Whisper/moderation/vision — нет ошибок ключа в логах
- [ ] **Supabase Storage**: селфи/фото загружены в **dev-бакеты**
      (`selfies-dev`/`profile-photos-dev`/`chat-attachments-dev`), не в prod

### Pass 12 — Edge cases
- [ ] Re-engagement: бросить онбординг → проверить decay-шаги
- [ ] Quiet hours: нудж в 23:00–09:00 Kyiv откладывается до 13:00
- [ ] No-match notice (Чт 18:15) для непарного eligible; famine-discount на
      2-й подряд неделе
- [ ] Embedding refresh: правка профиля → `embeddingDirty` → cron сбрасывает
- [ ] GDPR delete: `DELETE /v1/me` (или `reset-accounts.ts`) → cascade;
      сверить, что founder-report снапшоты с этим userId тоже удалены

---

## Реестр дефектов

| # | Pass | Описание | Severity | Файл/лог | Статус |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## Критерий готовности к Production
- [ ] Все passes 1–12 пройдены без блокеров
- [ ] Внешние связки (AWS Face Liveness / Rekognition CompareFaces / Places /
      OpenAI / Supabase) дают корректные результаты
- [ ] Найденные дефекты закрыты или осознанно отложены (с записью в реестре)
- [ ] Перед выкаткой: `DEV_OTP_BYPASS_TELEGRAM_IDS` **пуст** в проде;
      `BOT_TOKEN` прод ≠ dev; `SUPABASE_*_BUCKET` прод ≠ dev; feature-флаги
      выставлены под прод-стратегию (Rematch/Premium/Referral/Promo/Type
      Radar — каждый по отдельному founder-решению, не автоматом из dev)
