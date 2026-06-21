# Gennety Dating — План E2E-тестирования (pre-prod)

> Назначение: полный прогон всех функций, API и внешних связок на **локальном
> DEP-боте `@gennetytestbot`** перед выкаткой в Production. Документ — рабочий
> чек-лист: отмечай `[x]` по мере прохождения, фиксируй найденные дефекты.
>
> Источник истины — код (`apps/bot/src/handlers`, `services`, `public`,
> `workers`). Этот файл описывает, *что* и *как* проверять, а не реализацию.

## Методология прогона (читать первым)

Это **живой ручной E2E** на работающем dev-боте `@gennetytestbot` с **двумя
реальными Telegram-аккаунтами**, которые проходят онбординг **как два новых
пользователя**. Это НЕ симуляция и НЕ «прогон через функцию `ask_user`»: агент
не подменяет реальные действия пользователя опросами и не «разыгрывает» юзера
внутри диалога. Именно живой прогон на двух аккаунтах — самый простой и
наглядный способ увидеть весь функционал от и до.

**Роли:**
- **Оператор (человек)** выполняет ВСЕ реальные действия в Telegram и Mini
  Apps: `/start`, онбординг (язык / согласие / email / город / AI-memory / фото
  / видео), Persona, тапы Accept/Decline, оплату тикетов, календарь,
  departure-origin + vibe, кнопки coordination / emergency, фидбэк. Агент за
  него это НЕ делает.
- **Агент (Claude)** поднимает стек, по **команде оператора** триггерит
  серверные стадии через dev-скрипты (свести матч; сдвинуть «часы» матча для
  date-lifecycle) и **после каждого шага сверяет состояние на сервере**
  (`inspect-user.ts`, `db-snapshot.ts`, строка матча, логи бота). Оператор
  ведёт — агент триггерит и проверяет.

**Порядок прогона:**
1. Поднять весь стек (см. «Окружение») и проверить здоровье (Pass 0).
2. **Чистый онбординг:** `pnpm dev:reset-onboarding:apply` → оба аккаунта
   проходят `/start` с нуля, как новые пользователи (A male→women, B female→men,
   один и тот же город).
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
- Поднять весь стек **заранее** (Docker → dev-БД → бот → webapp → ngrok); не
  считать, что он уже запущен.
- **Бот на время прогона запускать БЕЗ `tsx watch`** (тот же пред-загруз env,
  что в `scripts/dev-bot.mjs`, но `tsx src/index.ts` без `watch`). Любое
  сохранение файла под `tsx watch` перезапускает процесс и **убивает
  выполняющиеся fire-and-forget пайплайны** — например, верификацию (селфи
  подтянулся, но DM «верифицирован» не успевает уйти → юзер «зависает» на
  «Synchronizing»/без ответа).
- **Во время прогона не редактировать файлы репозитория** — по той же причине
  (перезапуск бота рвёт async-стадии).
- Сверять каждый шаг на сервере, **прежде чем** идти дальше.
- `ask_user` / уточняющие вопросы — только для настоящих развилок (например,
  «триггерить эмердженси сейчас или идём дальше»), и НИКОГДА как замена реальных
  действий оператора в Telegram.

## Тестовые аккаунты

| Роль | Аккаунт | Telegram ID | Email | Особенность |
|---|---|---|---|---|
| Главный (A) | `@GN01001` | `782065541` | реальный корпоративный | **Полная** верификация, без пропусков |
| Запасной (B) | `@gennetysupport` | `5986970093` | синтетический `dev+...@gennety.dev` | **Email-шаг пропущен** (в `DEV_OTP_BYPASS_TELEGRAM_IDS`); всё остальное (Persona, Rekognition, фото) — полноценно |

Канонический «второй» аккаунт во всём dev-тулинге = `5986970093` (дефолты
скриптов согласованы). Bypass-лист содержит только `5986970093`.

**Предусловие совместимости пары** (иначе матч-движок не сведёт A и B):
- gender-совместимы (напр. A = male / seeking women, B = female / seeking men);
- **один и тот же город матчинга** (`Profile.homeCityKey`) — задаётся в онбординге;
- разные university-домены матчатся в одном городе (curated-венью требует общий
  домен — для проверки curated-пути выровнять домены через `dev:align-email-bypass`).

## Окружение (dev) — поднять перед прогоном

Компоненты:
- Dev-БД `gennety-dev-db` — `localhost:5434` / `gennety_dev`
- Dev-бот `@gennetytestbot` — публичный API `:3101`, Admin API `:3100`
  (логи: `/tmp/gennety-dev-bot.log`)
- Mini App (Vite) `:5173` + ngrok `WEBAPP_URL`
- Флаги ON: `TICKET_FEATURE_ENABLED`, `COORDINATION_FEATURE_ENABLED`,
  `VENUE_CHANGE_FEATURE_ENABLED`, `DATE_CARD_FEATURE_ENABLED`,
  `RICH_THINKING_ENABLED`, `ONBOARDING_FACT_COLLECTOR_ENABLED`,
  `ELO_VISION_SEED_ENABLED`, Persona (sandbox), Rekognition (реальный),
  Places (реальный), `TICKET_PAYMENT_MODE=mock`

Поднятие стека (не считать, что уже запущено — проверять):
1. Docker: `open -a Docker`, дождаться демона (`docker info`).
2. Dev-БД: `pnpm dev:db:up`, затем `pnpm dev:db:push` (схема в синхроне).
3. **Бот без `tsx watch`** (стабильно для async-стадий): пред-загрузить env как
   в `scripts/dev-bot.mjs`, но запустить `tsx src/index.ts` без `watch`
   (например, минимальный лаунчер, спавнящий
   `pnpm --filter @gennety/bot exec tsx src/index.ts`). Дождаться строк
   `/v1/* API listening on :3101` и `Bot @gennetytestbot started`.
4. Webapp: `pnpm dev:webapp` (`:5173`).
5. ngrok на зарезервированный домен → `:5173`
   (`ngrok http 5173 --domain=<host из WEBAPP_URL>`), проверить, что Mini App
   страницы отдаются `200` через `WEBAPP_URL`.

> `pnpm dev:bot` запускает `tsx watch` — для длинного E2E это опасно (правки
> файлов перезапускают бота и рвут fire-and-forget пайплайны). На время прогона
> используем no-watch вариант выше и **не редактируем репозиторий**.
> После правок `.env.local` (bypass-лист, флаги) — **полный** рестарт бота
> (не tsx-reload). Bypass-лист содержит `5986970093`.

---

## Точки входа в сервис

| # | Путь | Механизм | Используется в тесте |
|---|---|---|---|
| 1 | Telegram `/start` (чистый) | Создаёт `User`, открывает Onboarding Mini App | ⭐ A |
| 2 | `/start <param>` | Реферал-атрибуция `tg:<param>` | опц. |
| 3 | `/start auth_<token>` (legacy `web_<token>`) | Web-registration handoff, email pre-verified | опц. |
| 4 | `/start verify_done` | Контрольный сигнал после hosted Persona | опц. |
| 5 | Dev-bypass `/start` | ID в `DEV_OTP_BYPASS_TELEGRAM_IDS` → синтетический verified email | ⭐ B |
| 6 | Mobile/Expo `/v1/auth/otp/*` → `/v1/onboarding/*` | Синтетический отрицательный telegramId | опц. |
| 7 | Website pre-reg `/v1/web-registration/*` | Выдаёт deep-link `/start auth_<token>` | опц. |
| 8 | Persona webhook `/v1/webhooks/persona` | HMAC terminal inquiry → pipeline | через Pass 2 |
| 9 | Mini Apps (onboarding/calendar/verification/ticket/tickets/venue-change/feedback/location) | `web_app` + initData HMAC | через профильные passes |

---

## Каталог функций (что должно быть покрыто)

- **Онбординг:** `/start`, Onboarding Mini App (интро/язык/согласие/email-OTP/город/AI-memory), conversational fact-collector (имя+возраст→пол→предпочтение→рост→хобби→требования→нац/этнос→AI-memory→фото), голосовой ввод (Whisper), ветки AI-memory `accepted`/`declined`/`undecided`, фото MIN2/MAX6 + дедуп + single-face/face-match гейт + альбомы, Live Photos + видео, тикет-бонусы (4+ фото, видео), re-engagement.
- **Верификация:** Verification Mini App (Persona Embedded), hosted-fallback, two-step soft-skip (голосовое note + Elo-штраф), pipeline (Persona pull → Rekognition CompareFaces → quorum verified/rejected/pending_review), AI-vision Elo seed, тикет-бонус, авто-rerun при правке фото, match-pool exclusion, selfie-retention.
- **Profiler:** батчи Q&A, rush-режим, skip-логика, локальные окна.
- **Меню:** My Profile, Edit Profile (фикс identity), Pause/Resume, Settings (язык), My Tickets (кошелёк + store), status-banner countdown.
- **Матчинг:** pre-match teaser, weekly batch, no-match notice, scoring (embedding/research/V_league/penalty/starvation + male reach), hard SQL-фильтры, питч + Synergy + стриминг, welcome-gift, blind decision (все ветки), nudges, причина отказа → constraints.
- **Ticket gate:** Ticket Mini App, mock-pay, pay-for-both (male), use-ticket, partner-paid, refund/expiry.
- **Calendar:** 6×5 сетка, multi-pick, live peer-visibility, 0/1/>1 overlap, first-mover DMs.
- **Venue:** location-first (4 режима), vibe parsing, curated-first → Places fallback, blurb, `date_time` entity, **Date Card** (PNG + shine + protect + Share-blur), **Venue Change** (female one-shot).
- **Date lifecycle:** wingman, icebreakers (T-5ч), emergency window, safety brief (T-1.5ч), wingman reveal, coordination offer (T-1ч), proxy chat (T-30м/T+2ч), feedback (T+24ч) + Feedback Mini App + голос.
- **Trust & Safety:** reports tier 1/2/3, strikes/suspend/ban, auto-unsuspend, emergency-cancel.
- **Cross-cutting:** quiet hours, starvation, embedding refresh, GDPR delete/selfie scrub, 5 языков.
- **API:** публичный `/v1/*` (JWT + initData HMAC), admin `/admin/*` (Bearer), Persona webhook.

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
| `pnpm --filter @gennety/bot exec tsx ../../scripts/dev-send-verification-cta.mjs --tg=<id>` | Переотправить Persona CTA напрямую |
| `pnpm dev:align-email-bypass --apply` | Выровнять домены A↔B (для curated-венью) |
| `pnpm dev:db:studio` | Prisma Studio |
| `pnpm face-eval-user` / `scripts/face-eval.ts` | Оценка качества Rekognition face-match |

---

## Проходы (passes)

### Pass 0 — Подготовка
- [ ] `db-snapshot.ts` — зафиксировать стартовое состояние
- [ ] (при переигрывании) `pnpm dev:reset-onboarding:apply`
- [ ] Health: `curl -s localhost:3101/v1/ping` → `{"ok":true}`; ngrok-URL открывается; `curl -sI localhost:3100` → 401
- [ ] В логах при `/start` запасного: `[dev-bypass] ...5986970093...`

### Pass 1 — Онбординг
- [ ] A (`@GN01001`): полный email-OTP (реальный корпоративный), Mini App все экраны, город, **AI-memory = accepted** (Magic Prompt → анимация анализа), фото 2..6
- [ ] A: дедуп — отправить копию/скрин/кроп → отклонение с объяснением
- [ ] A: тикет-бонус за 4+ фото; добавить видео → второй бонус
- [ ] B (`@gennetysupport`): email-экран **пропущен**, **AI-memory = declined** (fallback-summary + эмбеддинг), фото, видео
- [ ] Серверная проверка: `inspect-user.ts` для каждого (onboardingStep, профиль, фото, verificationStatus)
- [ ] Profiler: первый батч (`~10 мин` после finalize); проверить `profilerNextAt`, Skip-кнопку
- [ ] Все 5 языков: переключить Settings, проверить i18n

### Pass 2 — Верификация (Persona sandbox + Rekognition реальный)
- [ ] A и B: CTA → Verification Mini App → Persona **sandbox** (selfie совпадает с фото)
- [ ] Webhook доходит → pipeline → Rekognition CompareFaces
- [ ] `inspect-user.ts`: `verificationStatus=verified`, `photoFaceScores` (1:1 с photos), `eloSeedDetails`
- [ ] `face-eval-user` — разумность скоров (пороги 0.85 / 0.75)
- [ ] Negative-path: selfie ≠ фото → `rejected`; групповое фото → `no_face`/`pending_review`
- [ ] На одном аккаунте: **soft-skip** (голосовое note → Skip anyway → Elo-штраф 150) → затем re-verify
- [ ] Правка фото после verified → авто-rerun pipeline

### Pass 3 — Меню / профиль / кошелёк
- [ ] My Profile, Edit Profile (убедиться: `firstName/age/email/domain` неизменяемы)
- [ ] Settings — смена языка; Pause/Resume (статус → paused/active)
- [ ] My Tickets — баланс из бонусов; store Mini App: mock-покупка bundle 1/3/6 → баланс растёт, `TicketLedger`
- [ ] Status-banner — live countdown к следующему батчу

### Pass 4 — Матчинг + питч
- [ ] `check-eligibility.ts A B` → подтвердить совместимость; затем `pnpm dev:trigger-test-match` (или `force-match-batch.ts`, или `pnpm dev:watch-and-match`)
- [ ] Питч: стриминг (`sendMessageDraft`/rich draft), **Synergy 70–99**, rationale
- [ ] **Welcome gift**: видео-кружок + тикет на ПЕРВОМ питче (идемпотентно — на втором не повторяется)
- [ ] Countdown-плита на питче (`proposal-countdown`)
- [ ] Blind decision — прогнать ветки: accept/accept; accept/decline; decline/decline
- [ ] TTL expiry: `advance-match-clock.ts <matchId> dispatched -25h` → expiry cron → корректные сообщения (asymmetry «missed a date»)
- [ ] Причина отказа → `negativeConstraints` (проверить `inspect-user`)

### Pass 5 — Ticket gate (flag ON)
- [ ] На mutual-accept приходит Ticket-карточка обоим
- [ ] «Use a ticket» (списание из кошелька); male «Pay for both» (mock $13.98); female «Pay my ticket»
- [ ] Partner-paid screen у второй стороны
- [ ] Hard gate: Calendar НЕ открывается, пока оба тикета не оплачены
- [ ] Expiry/refund: backdate `ticketExpiresAt` → `ticket-expiry` cron открывает Calendar бесплатно

### Pass 6 — Calendar
- [ ] Оба открывают Calendar Mini App; 4 состояния слотов (empty/mine/peer-only/overlap)
- [ ] Live peer-visibility (polling ~4с) — метки партнёра появляются
- [ ] 0 overlap → first-mover DMs; 1 overlap → auto-lock; >1 overlap → confirm-card
- [ ] Замена calendar-карточки при новом предложении (не накапливаются)

### Pass 7 — Venue + Date Card + Venue Change
- [ ] Departure-origin **первым** (Location Mini App: геолокация / автокомплит / тап-на-карте / drag), затем vibe
- [ ] Vibe вне whitelist → override + аудит `parsedCategory`
- [ ] Venue: Places fallback (реальное место, открывается в Maps, blurb по фактам, `date_time` entity); для curated — `dev:align-email-bypass --apply` → общий домен
- [ ] **Date Card**: PNG (фото партнёра + венью), «shine» прогресс держится до готовности, `protect_content`
- [ ] **Share** → re-render с blur лица, без protect; fail-safe (blur не вышел → share отменён)
- [ ] **Venue Change**: кнопка только у female; disclaimer; 3км каталог; комментарий ≥10 → male accept (новая карточка) / decline (отмена матча, без Elo-штрафа) с confirmation guard

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
- [ ] Report tier 3 (safety) → pending_investigation + cancel in-flight
- [ ] Дубль-репорт `(reporterId, matchId)` → `reportDuplicate`
- [ ] Auto-unsuspend по истечении

### Pass 10 — API + внешние связки
- [ ] Публичный: `/v1/ping`, `/v1/auth/otp/*`, `/v1/me*`, `/v1/matches/*`, `/v1/calendar/*`, `/v1/tickets/*`, `/v1/venue-change/*`, `/v1/verification/mini-app/*` — 401 без auth
- [ ] Admin: `localhost:3100` без Bearer → 401; с ключом — роутеры audience/algorithm/gender/retention/dates/verification
- [ ] **Persona** (sandbox): webhook → pipeline стартует (логи)
- [ ] **Rekognition** (реальный): корректные `photoFaceScores`
- [ ] **Google Places** (реальный): реальные венью, quality-gate отсекает мусор
- [ ] **OpenAI**: питч/эмбеддинг/Whisper/moderation/vision — нет ошибок ключа в логах
- [ ] **Supabase Storage**: selfie/фото загружены

### Pass 11 — Edge cases
- [ ] Re-engagement: бросить онбординг → проверить decay-шаги
- [ ] Quiet hours: нудж в 23:00–09:00 Kyiv откладывается до 13:00
- [ ] No-match notice (Чт 18:15) для непарного eligible
- [ ] Embedding refresh: правка профиля → `embeddingDirty` → cron сбрасывает
- [ ] GDPR delete: `DELETE /v1/me` (или `reset-accounts.ts`) → cascade

---

## Реестр дефектов

| # | Pass | Описание | Severity | Файл/лог | Статус |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## Критерий готовности к Production
- [ ] Все passes 1–11 пройдены без блокеров
- [ ] Внешние связки (Persona / Rekognition / Places / OpenAI / Supabase) дают корректные результаты
- [ ] Найденные дефекты закрыты или осознанно отложены (с записью в реестре)
- [ ] Перед выкаткой: `DEV_OTP_BYPASS_TELEGRAM_IDS` **пуст** в проде; `BOT_TOKEN` прод ≠ dev; feature-флаги выставлены под прод-стратегию
