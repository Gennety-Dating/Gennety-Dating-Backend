# Gennety Dating — План поэтапного аудита

> Черновой навигатор для серии отдельных сессий аудита. Каждый блок ниже — это
> одна изолированная, самодостаточная функция/воркфлоу приложения. Для каждого
> описано: **область**, **ключевые файлы**, **замысел** (как оно должно работать),
> **инварианты** (что нельзя ломать) и готовый **промпт**, который можно целиком
> скопировать в новую сессию Claude Code, чтобы проверить механизм end-to-end.
>
> Источники правды: код + тесты + `schema.prisma` > `PRODUCT_SPEC.md` >
> `ARCHITECTURE.md` > `deploy.md`. Если проза и код расходятся — это находка.
>
> **Как пользоваться:** открывай один блок за сессию, вставляй его «Промпт» как
> первое сообщение. Каждый промпт заканчивается требованием выдать findings по
> severity со ссылками `файл:строка` и НЕ чинить без отдельной команды —
> сначала полный отчёт, потом решаем, что править.

## Общие правила для каждой сессии аудита

Вставляй это в начало любой сессии (или полагайся на то, что оно уже в промпте):

```
Это сессия АУДИТА, не разработки. Задача — прочитать код указанного блока
end-to-end и найти баги, гонки, нарушения инвариантов, расхождения кода и
PRODUCT_SPEC/ARCHITECTURE, дыры в trust boundary, мёртвые/недостижимые ветки,
отсутствующее покрытие тестами.

Правила:
- НИЧЕГО не меняй, пока я явно не попрошу фикс. Сначала — полный отчёт.
- Читай реальный код и тесты, а не только доки. Где проза и код расходятся —
  это находка, а код считается источником правды.
- Findings давай списком, отсортированным по severity (Critical/High/Medium/Low),
  каждая с ссылкой файл:строка, конкретным сценарием провала (вход → неверный
  выход/краш) и минимальным предлагаемым направлением фикса.
- Отдельно перечисли, какие ветки/сценарии НЕ покрыты тестами.
- В конце — секция «Проверено и норм», чтобы было видно, что реально осмотрено.
- Не выдумывай пути и функции: если файла нет — скажи об этом, не фантазируй.
```

---

# A. Онбординг и идентичность

## 1. Онбординг Mini App (входной экран)

- **Область:** язык → согласие/ToS → sign-up fork (student/general) → phone one-tap / email OTP gate → город → тема (light/dark) → выбор AI-memory → handoff в бота.
- **Ключевые файлы:** `apps/webapp/src/onboarding.tsx`, `onboarding-route.ts`, `onboarding-i18n.ts`, `onboarding-timing.ts`; `apps/bot/src/public/routes/telegram-onboarding.ts`, `onboarding-state.ts`; `handlers/onboarding-mini-app-gate.ts`, `handlers/onboarding/phone.ts`; `services/contact-verification.ts`.
- **Замысел:** язык выбирается ДО согласия; все записи идут через `initData` HMAC. `POST /track` фиксирует переизбираемый выбор fork (404 при `PHONE_AUTH_ENABLED=off`). `/complete` прогоняет track-aware contact gate (`email-required`/`phone-required`) до проверки города и AI-memory. `undecided` не проходит. `/state` зеркалит `phoneAuthEnabled`, `theme`, `themeChosen`. Никакого web-онбординга (удалён 2026-07-19).
- **Инварианты:** initData проверяется на каждом write; один аккаунт на телефон (`User.phone @unique`); student-бонус тикетов даётся только на верификации uni-email, гейт по track; тема по умолчанию `dark`; `/complete` не завершает онбординг сам по себе.

```
Проведи аудит входного онбординг Mini App (Telegram) end-to-end.
Прочитай: apps/webapp/src/onboarding.tsx, onboarding-route.ts, onboarding-i18n.ts,
onboarding-timing.ts; apps/bot/src/public/routes/telegram-onboarding.ts и
onboarding-state.ts; handlers/onboarding-mini-app-gate.ts; handlers/onboarding/phone.ts;
services/contact-verification.ts. Сверь с PRODUCT_SPEC §1.1–1.2.
Проверь: (1) initData HMAC на КАЖДОМ write-роуте, невозможность подделки track/telegramId;
(2) порядок гейтов язык→согласие→fork→контакт→город→тема→AI-memory и что ни один шаг не
пропускается; (3) track-aware contact gate в /complete (email-required vs phone-required),
что кредит одного track не удовлетворяет другой; (4) уникальность User.phone и гонки при
одновременных /track и message.contact; (5) поведение при PHONE_AUTH_ENABLED=off (404 на
/track); (6) что /complete не помечает онбординг завершённым в обход фото/верификации;
(7) корректность выдачи student-бонуса только по uni-email и его идемпотентность.
Затем выдай отчёт по правилам сессии аудита (severity + файл:строка).
```

## 2. Разговорный fact-collector + vibe-вопросы

- **Область:** серверный сбор фактов после email-гейта; LLM-экстракция явных фактов; детерминированный выбор следующего поля; vibe-вопросы (`friday_vibe`/`vibe_focus`) и их проекция в оси.
- **Ключевые файлы:** `services/onboarding-collector.ts`, `onboarding-agent.ts`, `onboarding-photo-stage.ts`, `vibe-axes.ts`; `handlers/onboarding/conversational.ts`, `prompts.ts`; `public/routes/onboarding.ts`; `packages/db onboarding_progress`.
- **Замысел:** сервер владеет прогрессом, LLM только извлекает явно сказанные факты. Каноничный порядок полей; обязательные поля (`firstName/age/gender/preference/partnerPreferences`) не пропускаются; gender только из прямого ответа, не из имени; несколько явных фактов в одном сообщении — все сохраняются; последняя явная коррекция побеждает. `user_text` ≠ `resume`/`context_dump`/`photos_updated` (синтетику не майнить). Vibe извлекается best-effort и не блокирует finalize.
- **Инварианты:** `revision` optimistic-lock от гонок; ToS+язык обязательны до ответов; `context_dump` до фото; national/ethnicity максимум раз; «нет хобби» — валидный ответ; extraction-fail не блокирует finalize.

```
Проведи аудит серверного fact-collector онбординга (Telegram + /v1/onboarding).
Прочитай: services/onboarding-collector.ts, onboarding-agent.ts, onboarding-photo-stage.ts,
vibe-axes.ts; handlers/onboarding/conversational.ts, prompts.ts; public/routes/onboarding.ts.
Сверь с PRODUCT_SPEC §1.3. Проверь: (1) что прогресс/порядок вопросов детерминирован на
сервере, LLM не владеет финализацией/гейтами фото; (2) обязательные поля никогда не
пропускаются, gender не выводится из имени; (3) экстракция мультифактов из одного сообщения
и «последняя явная коррекция побеждает»; (4) что synthetic-события (resume/context_dump/
photos_updated), assistant-текст и tool-аргументы НЕ попадают в экстракцию фактов;
(5) optimistic concurrency (revision) при одновременных ответах — потеря факта или гонка;
(6) гейты порядка: ToS+язык до ответов, context_dump до фото, national/ethnicity ≤ 1 раз;
(7) vibe-экстракция best-effort и что её падение не блокирует finalize, раздельная запись
energy/orientation/socialRole/anchorTags и вклейка Friday-текста в psychologicalSummary.
Отчёт по правилам сессии аудита.
```

## 3. Загрузка и валидация фото/видео

- **Область:** приём статичных фото/Live Photo/видео; safety-модерация; usable-face; obstruction; дубликаты (file_unique_id + perceptual hash); подсчёт к `MIN_PHOTOS`; бонусы за 6+ фото и видео; коалесценция альбомов.
- **Ключевые файлы:** `services/profile-media-validation/*`, `profile-media-dispatch.ts`, `profile-media-json.ts`, `profile-video.ts`, `telegram-live-photo.ts`, `telegram-profile-media.ts`, `face-match-gate.ts`; `public/routes/me.ts` (`/v1/me/photos`); `aether-profile-tools.ts`.
- **Замысел:** до Persona идентичность НЕ гейтится (упрощено 2026-06-23) — принимается любое фото, прошедшее safety + usable-face (conf ≥ 0.55, area ≥ 0.8%) + obstruction (dark sunglasses ≥0.90 / occlusion ≥0.99) + duplicate. Никакого кластеринга «тот же человек» и self-anchor. Видео display-only, только safety (12 кадров + аудио-транскрипт), не входит в `photos[]`. Отказ объясняется на самом кадре с 🤔.
- **Инварианты:** `photos[i] ↔ photoFaceScores[i] ↔ uploadedPhotoHashes[i]` строго 1:1; отклонённая замена не перетирает валидное; per-user lock на массивные мутации; отклонения в `media_validation_rejections` без биометрии; бонусы идемпотентны (`photoBonusTicketAt`/`videoBonusTicketAt`).

```
Проведи аудит загрузки и валидации профильных фото/видео (Telegram + /v1/me/photos + Aether).
Прочитай: services/profile-media-validation/*, profile-media-dispatch.ts, profile-media-json.ts,
profile-video.ts, telegram-live-photo.ts, telegram-profile-media.ts, face-match-gate.ts;
public/routes/me.ts; aether-profile-tools.ts. Сверь с PRODUCT_SPEC §1.3 (медиа-стадия) и
ARCHITECTURE (Storage Buckets). Проверь инвариант выравнивания массивов
photos[i]↔photoFaceScores[i]↔uploadedPhotoHashes[i] на ВСЕХ путях append/delete/replace
(Telegram альбом, mobile, Aether) и при легаси-рассинхроне длин; per-user lock от гонок
между поверхностями; что отклонённая замена не затирает валидное медиа и не выдаёт бонус;
корректность duplicate-детекции (file_unique_id внутри батча + differenceHash ≤ 8);
usable-face и obstruction пороги; что видео не попадает в photos[] и валидируется только
на safety; идемпотентность фото/видео бонусов; что rejection логируется без биометрии и
объясняется на нужном кадре. Отчёт по правилам сессии аудита.
```

## 4. Пайплайн верификации личности (Persona + Rekognition)

- **Область:** CTA верификации; Mini App Persona Embedded / hosted fallback; webhook + pull-fallback; CompareFaces против каждого фото; quorum-правило; rerun на каждом изменении фото; verification-stall nudges; 90-дневный selfie scrub.
- **Ключевые файлы:** `services/verification-pipeline.ts`, `verification-poller.ts`, `persona.ts`, `persona-api.ts`, `face-match.ts`, `verified-identity-reference.ts`, `selfie-retention.ts`, `elo-seed.ts`; `handlers/onboarding/verification.ts`; `public/routes/verification-mini-app.ts`, `verification.ts`, `persona-webhook.ts`.
- **Замысел:** только доверенный терминальный webhook (или REST `approved`) запускает пайплайн. Quorum: `verified` ⇔ pass ≥ `FACE_MATCH_MIN_VERIFIED_PHOTOS` И ноль `fail`; любой `fail` = hard reject; всё прочее → `pending_review`; инфра-сбой → `pending_review`, никогда `rejected`. Rerun при каждом edit фото, стейл-скоры отбрасываются если массив изменился mid-run. Selfie удаляется через 90 дней, статус остаётся `verified`.
- **Инварианты:** только webhook пишет `verified/rejected` (Mini App event — нет); match-pool включает только `verified` + легаси-cohort (`unverified` + `verificationSkippedAt` не null); идемпотентность `(personaInquiryId, faceMatchedAt)`; production-like отказывается стартовать при ослабленном trust boundary.

```
Проведи аудит пайплайна верификации личности end-to-end.
Прочитай: services/verification-pipeline.ts, verification-poller.ts, persona.ts, persona-api.ts,
face-match.ts, verified-identity-reference.ts, selfie-retention.ts, elo-seed.ts;
handlers/onboarding/verification.ts; public/routes/verification-mini-app.ts, verification.ts,
persona-webhook.ts. Сверь с PRODUCT_SPEC §1.4 и ARCHITECTURE (verification). Проверь:
(1) что terminal-статусы verified/rejected пишет ТОЛЬКО HMAC-webhook/REST-approved, а Mini App
event — только pending + триггер pull; (2) HMAC проверка сырого тела webhook до express.json;
(3) quorum-правило точно: pass-квора + ноль fail = verified, любой fail = hard reject,
инфра-сбой → pending_review (не rejected); (4) rerun на каждом изменении фото и отбрасывание
стейл-photoFaceScores если массив фото изменился во время прогона (сохранение выравнивания);
(5) идемпотентность (personaInquiryId, faceMatchedAt) и гонки rerun; (6) корректность
match-pool inclusion (verified + легаси skip-cohort, исключение pending/pending_review/rejected);
(7) selfie-retention: скраб через 90 дней, статус остаётся verified; (8) Elo vision seed
считает среднее по фото и не падает всё при частичной ошибке. Отчёт по правилам сессии.
```

## 5. Цепочка ре-энгейджмента + verification-stall nudges

- **Область:** 5-шаговый retention-loop при дропе онбординга; quiet hours; отдельный sweep для застрявших на верификации; сброс цепочки на любую активность; поведение `/start` для finalized-but-unverified.
- **Ключевые файлы:** `workers/re-engagement.ts`, `re-engagement-schedule.ts`, `run-re-engagement.ts`, `quiet-hours.ts`; `handlers/onboarding/verification.ts` (`sendVerificationGateNotice`); `handlers/start.ts`.
- **Замысел:** шаги на +15м/+2ч/day 19:00/day+1 19:00/day+2 14:00 (Kyiv); quiet 23:00–09:00 → откладывается на 13:00. Любая активность сбрасывает на шаг 0; финиш онбординга обнуляет `reEngagementNextAt`. Verification-stall: `verifyReminderNudge` по затухающей каденции; `pending_review`/`rejected` НЕ нудят. Re-`/start` пока gated показывает реальный статус верификации, не «AI уже ищет».
- **Инварианты:** идемпотентность шагов; дедлок quiet-hours не должен «съедать» шаг навсегда; не нудить уже активных.

```
Проведи аудит цепочки ре-энгейджмента и verification-stall нуджей.
Прочитай: workers/re-engagement.ts, re-engagement-schedule.ts, run-re-engagement.ts,
quiet-hours.ts; handlers/onboarding/verification.ts (sendVerificationGateNotice);
handlers/start.ts. Сверь с PRODUCT_SPEC §1.5. Проверь: (1) точность таймингов шагов и
пересчёт при quiet hours (перенос на 13:00, без потери/дублирования шага); (2) сброс цепочки
на любую активность (consent/язык/ответ/фото) и обнуление на финише; (3) verification-stall
sweep нудит только pending/unverified и НЕ трогает pending_review/rejected; (4) что re-/start
у finalized-but-unverified показывает реальный статус (verifyReminderNudge/outcomePendingReview/
outcomeRejected) и НЕ пинит next-match баннер и не говорит «AI уже ищет»; (5) идемпотентность —
двойной запуск воркера не шлёт дубль DM; (6) mobile-only (отрицательный telegramId) корректно
исключается. Отчёт по правилам сессии.
```

---

# B. Профиль после онбординга

## 6. Profiler (Phase 1b)

- **Область:** гендерные Q&A-батчи после онбординга для icebreakers/hints; окна morning/evening в локальном времени; rush-режим; date-negotiation gate; skip-логика; cross-cycle persistence.
- **Ключевые файлы:** `workers/profiler.ts`, `services/profiler.ts`, `profiler-schedule.ts`; `handlers/profiler/*`; `packages/shared/profiler-questions.ts`; `profiler_answers`.
- **Замысел:** первый вопрос ~10 мин после онбординга; батчи по 3 (rush → 2 если ближайший drop < 48ч); пауза между батчами до 09:00/18:00 в `Profile.timeZone`. Держится тихо во время активного date-planning (`proposed`/`negotiating`/`negotiating_venue`), но `scheduled` НЕ блокирует. Skip: возвращается 1 раз в конце цикла; дважды за цикл — до следующего drop. Отвеченные не переспрашиваются. НЕ вход в матчинг.
- **Инварианты:** одна строка `ProfilerAnswer` на (user, question); гейт применяется и mid-batch; лёгкая сидировка легаси-юзеров; completion молчит.

```
Проведи аудит Profiler (Phase 1b).
Прочитай: workers/profiler.ts, services/profiler.ts, profiler-schedule.ts; handlers/profiler/*;
packages/shared/profiler-questions.ts. Сверь с PRODUCT_SPEC §Phase 1b и ARCHITECTURE
(profiler_answers). Проверь: (1) тайминг entry (~10 мин), окна 09:00/18:00 в Profile.timeZone
и fallback Europe/Kyiv, rush-режим при drop < 48ч; (2) date-negotiation gate — держит батч в
proposed/negotiating/negotiating_venue, пропускает при scheduled, и работает mid-batch
(ответ сохраняется, остаток откладывается); (3) skip-логика (возврат один раз в конце цикла,
дважды → следующий drop, отвеченные не переспрашиваются); (4) cross-cycle persistence и
приоритетная сортировка непротвеченных; (5) идемпотентность строки на (user,question) и
отсутствие гонок при одновременных ответе/скипе; (6) что Profiler НЕ читается матч-движком.
Отчёт по правилам сессии.
```

## 7. Главное меню, My Profile, My Date hub, Freeze/Delete

- **Область:** persistent inline-меню; условная строка My Date; хаб My Date; редактирование профиля; pause/resume CAS; Settings (язык/тема/verify); freeze-fork и GDPR-delete.
- **Ключевые файлы:** `handlers/menu/main.ts`, `my-date.ts`, `my-profile.ts`, `edit-profile.ts`, `pause.ts`, `settings.ts`, `account-action.ts`, `video.ts`, `router.ts`; `services/active-match.ts`, `active-match-priority.ts`, `account-status-transitions.ts`, `account-deletion.ts`, `delete-freeze-video.ts`, `user-status.ts`.
- **Замысел:** My Date видна только при live-матче и только после существования собственного `pitchMessageId`. Pause/resume — атомарный CAS, не может перетереть moderation-состояния. Freeze — soft-delete (сохраняет всё, убирает из пула, отменяет матчи, при `/start` тихо реактивирует). Delete — GDPR hard delete: сначала стирание Supabase-медиа, потом атомарная отмена матчей + purge founder-снапшотов + каскад; уведомление партнёра только после коммита. Nonce-привязка confirm-клавиатур (10 мин, one-use).
- **Инварианты:** blind-decision не раскрывается в хабе (нет icebreakers/wingman); freeze commit + отмена матчей в одной транзакции, партнёрские эффекты после коммита; storage-fail оставляет аккаунт и матчи целыми.

```
Проведи аудит меню и его тяжёлых веток: My Date hub, Freeze, GDPR Delete.
Прочитай: handlers/menu/main.ts, my-date.ts, my-profile.ts, edit-profile.ts, pause.ts,
settings.ts, account-action.ts, video.ts, router.ts; services/active-match.ts,
active-match-priority.ts, account-status-transitions.ts, account-deletion.ts,
delete-freeze-video.ts. Сверь с PRODUCT_SPEC §2.1. Проверь: (1) видимость строки My Date
только при live-матче и после собственного pitchMessageId (нет раннего раскрытия партнёра);
(2) выбор текущего матча при нескольких live-строках — по прогрессии scheduled→venue→
negotiating→proposed, не по enum-порядку; (3) pause/resume CAS не перетирает suspended/
pending_investigation/banned/frozen; (4) freeze: транзакционная отмена in-flight матчей +
переход в frozen, партнёрские эффекты (comp/notify) ТОЛЬКО после коммита, тихая реактивация
на /start; (5) GDPR delete: порядок storage-erase → отмена матчей CAS → purge founder-снапшотов
→ каскад → уведомление партнёра после коммита; поведение при storage-fail (503, аккаунт цел);
(6) nonce-токены confirm-клавиатур: одноразовость, привязка к сообщению/стадии, 10-мин expiry,
сжигание на Back/free-text/replay; (7) что хаб НЕ показывает icebreakers/wingman (blind rule).
Отчёт по правилам сессии.
```

## 8. Pinned status banner

- **Область:** закреплённый баннер обратного отсчёта до weekly batch; ежеминутная сверка; self-healing; hourly pin-audit; scheduled-date контекст.
- **Ключевые файлы:** `services/status-banner.ts`, `status-banner-view.ts`; `workers/status-timer.ts`, `status-timer-runner.ts`; `services/next-batch.ts`, `weekly-status.ts`; `public/routes/countdown.ts`.
- **Замысел:** первая синяя кнопка всегда несёт discrete-countdown до next batch и открывает меню; тело повторяет точную дату. Scheduled-date — дополнительный контекст, не замена. Self-healing: null/stale message id → замена, удалённые → пересоздаются в тот же тик, hourly физический re-pin. De-dup рендера в памяти. Leave `active` → снятие пина; resume → пересоздание.
- **Инварианты:** источник каденции = `MATCH_CRON_SCHEDULE`+`CRON_TIMEZONE` (тот же, что `/v1/countdown`); правки баннера exempt от quiet hours (только edit, без нотификаций); unreachable-cooldown, чтобы не спамить `chat not found`.

```
Проведи аудит pinned status banner.
Прочитай: services/status-banner.ts, status-banner-view.ts; workers/status-timer.ts,
status-timer-runner.ts; services/next-batch.ts, weekly-status.ts; public/routes/countdown.ts.
Сверь с PRODUCT_SPEC §2.1 (баннер) и ARCHITECTURE (status-timer). Проверь: (1) единый источник
next-drop каденции с /v1/countdown (MATCH_CRON_SCHEDULE+CRON_TIMEZONE), корректность округления
Xd Yh/Xh Ym/Xm; (2) self-healing: null/stale id → замена, удалённое сообщение → пересоздание в
тот же тик, hourly physical-pin reconciliation; (3) de-dup рендера (text+button) в памяти, чтобы
не слать лишние editMessageText; (4) снятие пина при выходе из active и пересоздание при resume,
корректная очистка при удалении аккаунта и re-registration после Telegram-outage; (5) scheduled-
date как доп-контекст, не замена next-drop; (6) обработка «chat not found»/unreachable без
рестарт-петли и без спама; (7) idempotency при перекрывающихся тиках. Отчёт по правилам сессии.
```

## 9. Свежесть эмбеддингов (M-2)

- **Область:** `embeddingDirty` на всех мутациях psychologicalSummary/partnerPreferences/negativeConstraints/hobbies; немедленный user-scoped refresh с 30-сек дедлайном; cron-ретрай; preflight перед батчем.
- **Ключевые файлы:** `workers/embedding-refresh.ts`; `services/match-engine.ts` (preflight); `packages/shared` prompt-builder; `profiles.embedding*`.
- **Замысел:** любая эмбеддинг-питающая правка → `embeddingDirty=true`. Bio/pref-правки сразу пытаются refresh за 30с; фейл оставляет dirty. Cron каждые 5 мин ≤20 строк. Перед weekly batch матчинг берёт весь dirty-снапшот без cap. Eligibility требует `embeddingDirty=false` (fail-closed). Флаг чистится только если `embeddingDirtyAt` совпадает (конкуррентная правка ретраится).
- **Инварианты:** dirty-юзер не получает stale-матч и НЕ штрафуется по standby; initial embedding fail тоже оставляет dirty для ретрая.

```
Проведи аудит свежести эмбеддингов (M-2).
Прочитай: workers/embedding-refresh.ts; секцию preflight в services/match-engine.ts
(match-engine-preflight.test.ts как ориентир); prompt-builder.ts. Сверь с PRODUCT_SPEC
(Embedding freshness) и ARCHITECTURE (match_score_logs / freshness). Проверь: (1) что ВСЕ пути,
мутирующие psychologicalSummary/partnerPreferences/negativeConstraints/hobbies, ставят
embeddingDirty=true; (2) 30-сек user-scoped refresh на bio/pref-правках и что фейл оставляет
dirty; (3) preflight перед батчем обрабатывает ПОЛНЫЙ dirty-снапшот без 20-строчного cap;
(4) fail-closed: dirty-профиль исключается из eligibility и в Prisma-, и в raw-vector путях,
не получает stale-матч и не набирает ложный standby; (5) очистка флага только при совпадении
embeddingDirtyAt И captured source-полей (конкуррентная правка в ту же миллисекунду не
затирается); (6) что initial embedding fail (AI-memory или fallback finalize) оставляет dirty
для ретрая. Отчёт по правилам сессии.
```

---

# C. Матчинг

## 10. Матч-движок (скоринг + фильтры)

- **Область:** гибрид SQL+Node; формула `((w1·V_explicit)+(w2·V_research))·V_league·V_agePref − w3·V_penalty + starvation`; hard SQL-фильтры; league/Elo (+male reach); age-band; lifetime ban; single-live-match; лог в `match_score_logs`.
- **Ключевые файлы:** `services/match-engine.ts` + `match-engine-batch/eligibility/preflight.test.ts`, `match-engine.integration.test.ts`; `services/geo.ts`, `elo-seed.ts`.
- **Замысел:** веса V_explicit 0.65 / V_research 0.35; sub-факторы research (vibe quadrant 0.40 PRIMARY, age gradient 0.20, height 0.20, homogamy 0.20). V_league — assortative gate, decay после tolerance 60, floor 0.05; male upward reach асимметричен для hetero. V_agePref — soft (floor 0.6), neutral при отсутствии band. Hard-фильтры: active+completed, embedding present, mutual gender, track-valid rail, same city, lifetime-ban anti-join, cooldown 24ч, single-live-match с блокировкой строк.
- **Инварианты:** ни разу тот же партнёр (canonical-pair index); single-live-match ре-чек внутри транзакции; starvation < penalty; union student/general cohort без заимствования rail.

```
Проведи аудит матч-движка (скоринг + жёсткие фильтры).
Прочитай: services/match-engine.ts и его тесты (match-engine-batch/eligibility/preflight,
integration); services/geo.ts, elo-seed.ts. Сверь с PRODUCT_SPEC §3.2 и ARCHITECTURE (matches
индексы). Проверь: (1) точность формулы и что explicit/research re-split внутри позитивной
скобки не меняет роль V_league; (2) V_league: decay/floor, и корректность одностороннего
male-reach ТОЛЬКО для hetero (matching down и same-gender не тронуты); (3) V_agePref soft,
neutral при отсутствии band, симметричная оценка обеих сторон; (4) hard-фильтры SQL: mutual
gender, track-valid rail (union без заимствования email/phone между track), same homeCityKey,
lifetime-ban anti-join через canonical-pair index, cooldown 24ч; (5) single-live-match: блокировка
обеих user-строк в каноническом порядке и ре-чек внутри транзакции — что перекрывающиеся батчи
не аллоцируют юзера дважды; (6) starvation cap 0.25 строго ниже penalty; (7) полнота записи
match_score_logs (включая scoreAgePref, дефолт 1 на старых строках). Отчёт по правилам сессии.
```

## 11. Еженедельная каденция (teaser / batch / no-match)

- **Область:** pre-match teaser (Wed 18:00), weekly batch (Thu 18:00), no-match notice (Thu 18:15); тиры famine; famine-скидка (tier ≥ 2).
- **Ключевые файлы:** `workers/pre-match-announce.ts`; `services/match-engine.ts` (`runWeeklyBatch`); `services/no-match-notifier.ts`, `dispatch-queue.ts`, `next-batch.ts`; `ticket-discount.ts`; `no_match_notices`.
- **Замысел:** teaser активным неанонсированным за цикл; batch — full dirty preflight → greedy allocation → dispatch через rate-limited очередь. No-match DM эмпатичный, тиры 1/2/3+ по consecutive famine, идемпотентен `(userId, dropDate)`, стримится rich (короткий 2-chunk), Telegram-only. При tier ≥ 2 и `TICKET_FEATURE_ENABLED` — famine-скидка на 1 тикет.
- **Инварианты:** дедуп анонсов/нотисов; mobile-only исключаются из Telegram-only DM; famine-скидка USD-only.

```
Проведи аудит еженедельной каденции матчинга.
Прочитай: workers/pre-match-announce.ts; runWeeklyBatch в services/match-engine.ts;
services/no-match-notifier.ts, dispatch-queue.ts, next-batch.ts; services/ticket-discount.ts.
Сверь с PRODUCT_SPEC §3.1 и §3.5b (famine discount) + ARCHITECTURE (no_match_notices, cron).
Проверь: (1) идемпотентность teaser (lastPreMatchAnnounceAt) и no-match (unique userId+dropDate,
dropDate truncate к UTC-дню) — двойной запуск cron не дублирует DM; (2) правильность тиров
famine по consecutive-count и старвейшн-компенсация при peer-declined; (3) что dispatch-queue
rate-limit (≈2с) и welcome-gift preroll pause не ломают порядок; (4) rich-стрим no-match падает
в classic при отсутствии rich-drafts, финал — plain sendMessage; (5) Telegram-only: mobile/
отрицательный telegramId пропускается; (6) выдача famine-скидки только tier ≥ 2 при флаге,
USD-only, one-time, TTL 30д. Отчёт по правилам сессии.
```

## 12. Питч + Synergy + стриминг + Match Card

- **Область:** генерация питча + Synergy (70..99); rich AI-compose стрим; финальное plain-сообщение с Accept keyboard/Report; Match Card collage (feature-flag); protected media; preroll welcome-gift.
- **Ключевые файлы:** `handlers/matching/pitch.ts` + `pitch.test.ts`; `services/pitch-generator.ts`, `ai-stream.ts`, `telegram-rich.ts`, `match-card/*`, `dispatch-queue.ts`, `welcome-gift.ts`, `profile-media-dispatch.ts`.
- **Замысел:** питч стримится rich (`streamRichDraftsToChat`) но ФИНАЛ — plain `sendMessage`, чтобы countdown-воркер мог `editMessageText`. Synergy clamped 70..99. Match card set рендерится (satori/resvg/canvas) в теме получателя; любой fail → fallback на plain protected media group. Welcome-gift preroll идёт первым, затем `MATCH_PREROLL_DELAY_MS` пауза.
- **Инварианты:** партнёрские фото `protect_content` везде с чётким лицом; финал питча — не rich-сообщение; никакой fail рендера не должен блокировать доставку.

```
Проведи аудит доставки питча (стрим + Match Card).
Прочитай: handlers/matching/pitch.ts (+ pitch.test.ts); services/pitch-generator.ts,
ai-stream.ts, telegram-rich.ts, match-card/*, dispatch-queue.ts, welcome-gift.ts,
profile-media-dispatch.ts. Сверь с PRODUCT_SPEC §3.3. Проверь: (1) что ФИНАЛЬНОЕ сообщение
питча — plain sendMessage (не rich), несёт pitchMessageId{A,B} и совместимо с editMessageText
countdown-воркера; (2) rich-стрим деградирует в classic edited-stream корректно; (3) Synergy
всегда clamped 70..99; (4) Match Card: рендер в теме получателя, seeded jitter, и что ЛЮБОЙ
fail (copy/render/send) падает в plain protected media group без wedging питча; (5) protect_content
на всех партнёрских фото/видео с чётким лицом; (6) welcome-gift preroll-первым + preroll-delay,
идемпотентность gift (welcome_gift ledger row), отсутствие ре-gift на ретраях; (7) motion-only
доставка после card album не дублирует статичные фото. Отчёт по правилам сессии.
```

## 13. Blind-decision + текстовое решение

- **Область:** инвариант слепого решения; peer-nudge; conversational decision (без постоянной Accept-кнопки); классификация текста; TTL-expiry asymmetry; forgive-once; сбор reason после decline.
- **Ключевые файлы:** `handlers/matching/decision.ts`, `decision-text.ts`, `decline-feedback.ts`, `negative-constraints.ts`; `services/decision-intent.ts`, `match-decision-claim.ts`, `match-decision-shared.ts`, `match-events.ts`, `expiry-notify.ts`.
- **Замысел:** пользователь не узнаёт выбор партнёра до собственного коммита. Первый коммит — строка остаётся `proposed`, peer получает нейтральный `matchPeerDecided` (идентичный для accept/decline). Mutual accept → `negotiating`. Текст НИКОГДА не коммитит — коммит только тап по surfaced-кнопке. `match:accept:`/`match:decline:` живы для легаси. TTL-expiry: если молчун сгостил принявшего — доп-строка «missed a date»; иначе нейтрально.
- **Инварианты:** терминальный `proposed→cancelled` CAS — единственная точка side-effects (Elo/priority/reveal); классификатор не перехватывает active sub-flows; reveal-copy ничего не раскрывает досрочно.

```
Проведи аудит blind-decision и текстового решения.
Прочитай: handlers/matching/decision.ts, decision-text.ts, decline-feedback.ts,
negative-constraints.ts; services/decision-intent.ts, match-decision-claim.ts,
match-decision-shared.ts, match-events.ts, expiry-notify.ts. Сверь с PRODUCT_SPEC §3.3–3.4.
Проверь: (1) что до собственного коммита пользователь не может узнать выбор партнёра ни в
одном сообщении (nudge идентичен для accept/decline); (2) что ТЕКСТ никогда не коммитит —
коммит только callback по surfaced-карточке, и что классификатор decision-text не перехватывает
активные matchFlow/menuState sub-flows и unrelated-сообщения; (3) терминальный proposed→cancelled
CAS как единственный владелец side-effects (Elo/priority/reveal) при гонке двух решений;
(4) mixed/both-declined reveal-последовательность и компенсация принявшему-но-отклонённому;
(5) TTL-expiry asymmetry (missed-date только если сгостили принявшего, иначе нейтрально);
(6) forgive-once на silence (первый инкремент — warning, со второго Elo как decline);
(7) сбор reason после decline и аппенд в negativeConstraints деклайнера. Отчёт по правилам сессии.
```

## 14. Match-нуджи + countdown + expiry

- **Область:** нуджи proposal (3ч/10ч) и scheduling (6ч/12ч); live «⏳ Xh left» плашка; 24ч TTL expiry.
- **Ключевые файлы:** `workers/match-nudge.ts`, `proposal-countdown.ts`; `services/match-expiry.ts` + `match-expiry.test.ts`, `expiry-notify.ts`; `quiet-hours.ts`.
- **Замысел:** отдельные пары timestamp-колонок на каждую каденцию, чтобы proposal-нудж не съедал scheduling-каденцию. Countdown live-редактит плашку каждые 5 мин (hourly первые 23ч, per-5-min последний час) через `editMessageText` по `pitchMessageId`. Нуджи чтят quiet hours.
- **Инварианты:** quiet-hours defer, а не level-drift; countdown правит именно plain-финал питча; expiry идемпотентен.

```
Проведи аудит match-нуджей, countdown-плашки и TTL-expiry.
Прочитай: workers/match-nudge.ts, proposal-countdown.ts; services/match-expiry.ts (+ тест),
expiry-notify.ts; workers/quiet-hours.ts. Сверь с PRODUCT_SPEC §3.5 и ARCHITECTURE (cron).
Проверь: (1) раздельные timestamp-колонки proposalNudge1/2 vs schedNudge1/2 — что строка,
получившая proposal-нудж, не дед-леттерит scheduling-каденцию; (2) пороги 3ч/10ч и 6ч/12ч
считаются от правильных полей (dispatchedAt vs last update); (3) quiet-hours defer на next
allowed window без потери/дрейфа; (4) countdown-воркер редактит именно plain-финал питча по
pitchMessageId, каденция hourly→per-5-min в последний час, и не падает если сообщение удалено;
(5) idempotent 24ч expiry и корректный expiry-notify. Отчёт по правилам сессии.
```

---

# D. Монетизация

## 15. Date Ticket gate + wallet + store + welcome gift + famine

- **Область:** премиум-шаг между mutual-accept и календарём; кошелёк тикетов; store; бонусы; welcome gift; famine-скидка; goodwill-cover read-receipt; lifecycle `ticketStatus`.
- **Ключевые файлы:** `handlers/matching/ticket-gate.ts` + тест; `services/ticket-wallet.ts`, `ticket-payment.ts`, `ticket-discount.ts`, `ticket-reward.ts`, `ticket-analytics.ts`, `welcome-gift.ts`; `workers/ticket-expiry.ts`; `public/routes/ticket.ts`, `tickets.ts`; `apps/webapp/src/ticket/*`, `tickets/*`.
- **Замысел:** гейт работает пока `status=negotiating`, `ticketStatus` — под-стейт. Ticket-card standalone и НЕ редактируется (исключение из one-card-правила); календарь приходит ОТДЕЛЬНЫМ сообщением после обоих оплат. Male «pay for both» settl'ит оба слота. «Use a ticket» — атомарный spend, refund при непримениении слота. Goodwill read-receipt: 3 бита (confirm DM → seen-stamp → guaranteed nudge). Lifecycle pending→partial→completed / refund_pending→refunded/expired.
- **Инварианты:** каждое изменение баланса = атомарная строка `TicketLedger` (running-sum = balance); spend не уходит в минус; famine USD-only и one-time; бонусы идемпотентны; accepted-матч не убивается payment-stall.

```
Проведи аудит Date Ticket gate + кошелька + store + welcome gift + famine.
Прочитай: handlers/matching/ticket-gate.ts (+ тест); services/ticket-wallet.ts,
ticket-payment.ts, ticket-discount.ts, ticket-reward.ts, welcome-gift.ts;
workers/ticket-expiry.ts; public/routes/ticket.ts, tickets.ts. Сверь с PRODUCT_SPEC §3.5b.
Проверь: (1) что каждое движение баланса пишет атомарную TicketLedger-строку и running-sum
delta == User.ticketBalance; spend не уходит в минус и refund'ится если match-slot claim не
применился; (2) standalone ticket-card НЕ редактируется, календарь — отдельное сообщение после
обоих оплат (startScheduling), scheduling/venue не трогают ticket-card; (3) male pay-for-both
male-only (сервер ре-валидирует), корректный partner-paid surprise; (4) goodwill read-receipt:
confirm DM → CAS partnerPaidSeenAt на первом реальном open → guaranteed completion nudge (что
nudge НЕ ставит seen-stamp); (5) lifecycle ticketStatus, refund_pending как durable retry,
что accepted-матч не убивается payment-stall и refund открывает календарь бесплатно;
(6) famine-скидка: USD-only, self-scope + store «1 ticket», consume CAS one-time; (7) бонусы
идемпотентны (photo/video/student/welcome ledger-claims). Отчёт по правилам сессии.
```

## 16. Платёжный trust boundary (Telegram Stars + StoreKit + webhooks)

- **Область:** `successful_payment`/`pre_checkout_query` как точка доверия; exactly-once через unique `externalPaymentId`; Stars-инвойсы (store/gate/venue-change/premium); StoreKit re-fetch; App Store webhooks.
- **Ключевые файлы:** `handlers/payments.ts` + `payments.test.ts`; `services/ticket-payment.ts`, `appstore.ts`, `appstore-tickets.ts`, `appstore-premium.ts`; `public/routes/appstore-webhook.ts`, `tickets-appstore.ts`, `premium-appstore.ts`, `ticket.ts`, `tickets.ts`, `venue-change.ts`, `premium.ts`.
- **Замысел:** клиентский JWS/payload — только указатель; авторитетное состояние re-fetch из App Store Server API. `pre_checkout_query` ре-валидирует payload+сумму в 10-сек окне. Charge id → exactly-once (store credit, gate settle, venue-change settle, premium renew). Gate: charge сначала как zero-delta audit row, settlement атомарно с slot CAS. Parallel-pay race → `refundStarPayment` проигравшему. REFUND/REVOKE клоуback exactly-once (баланс может уйти в минус — честный учёт).
- **Инварианты:** unique `externalPaymentId` предотвращает redelivery-дубли; forged webhook в худшем случае триггерит безвредный lookup; mock-роуты 404 при `TICKET_STARS_ENABLED`.

```
Проведи аудит платёжного trust boundary (Stars + StoreKit + webhooks).
Прочитай: handlers/payments.ts (+ тест); services/ticket-payment.ts, appstore.ts,
appstore-tickets.ts, appstore-premium.ts; public/routes/appstore-webhook.ts,
tickets-appstore.ts, premium-appstore.ts, а также *-invoice роуты в ticket.ts/tickets.ts/
venue-change.ts/premium.ts. Сверь с PRODUCT_SPEC §3.5b/§3.8 и ARCHITECTURE (ticket_ledger,
subscription_ledger). Проверь: (1) exactly-once по unique externalPaymentId на ВСЕХ рельсах
(store credit, gate settle, venue-change settle, premium first+renew) — что redelivery того же
charge id не дублирует эффект; (2) pre_checkout_query ре-валидирует payload+сумму+актуальность
свопа/слота в 10-сек окне, отклоняет стейл reusable invoice links; (3) gate: zero-delta audit
row до settle, settlement атомарно со slot CAS, surplus/overpay как durable pending; (4) StoreKit:
клиентский JWS используется ТОЛЬКО для transactionId, состояние re-fetch из App Store Server API;
webhook применяет эффект только после authoritative lookup (forged webhook безвреден), 500 на
lookup-outage для ретрая Apple; REFUND/REVOKE клоуback exactly-once (минус допустим); (5) что
mock intent/confirm роуты 404 (PAY-1) при TICKET_STARS_ENABLED; (6) parallel-pay race →
refundStarPayment проигравшему. Отчёт по правилам сессии.
```

## 17. Gennety Premium (подписка)

- **Область:** per-user entitlement; Stars recurring (2592000) + StoreKit auto-renew; venue-change premium-tier (either-party unlock, fee waiver, counterfactual).
- **Ключевые файлы:** `services/premium.ts` + тест, `appstore-premium.ts`; `handlers/menu/premium.ts`; `public/routes/premium.ts`, `premium-appstore.ts`; `apps/webapp/src/premium.ts`; `subscription_ledger`.
- **Замысел:** active ⇔ `premiumUntil > now`; ledger — источник правды, exactly-once. `premiumExternalId` — recurring anchor, чтобы renewal-webhook (без userId) нашёл владельца. Premium-венью показываются locked, selectable только если `pairPremiumActive` (either-party); гейт сервер-сайд на likes/overlap/express. Fee waiver: premium-венью всегда free; base-венью free если settling actor premium; non-premium payer видит counterfactual.
- **Инварианты:** entitlement переживает выключение флага; auto-assign picker остаётся base-only (дефолт не ломает price cap); premium-венью проходят все non-price гейты.

```
Проведи аудит Gennety Premium (подписка + premium-венью).
Прочитай: services/premium.ts (+ тест), appstore-premium.ts; handlers/menu/premium.ts;
public/routes/premium.ts, premium-appstore.ts; apps/webapp/src/premium.ts. Сверь с
PRODUCT_SPEC §3.8 и ARCHITECTURE (subscription_ledger). Проверь: (1) active ⇔ premiumUntil>now,
ledger exactly-once (unique externalPaymentId) на первый charge И каждый auto-renew;
(2) premiumExternalId как recurring anchor — renewal-webhook без userId находит владельца
(Stars charge id / originalTransactionId); (3) entitlement, уже оплаченный, honored даже при
PREMIUM_FEATURE_ENABLED=off; (4) premium-tier venue-change: сервер-сайд ре-резолв tier из
каталога (клиент не доверенный) на likes/multi-overlap confirm/express, 402 premium-locked;
either-party unlock (pairPremiumActive); (5) fee waiver + counterfactual: premium-венью всегда
free, base-венью free только если settling actor premium, non-premium payer видит premiumWouldWaive
и всё ещё платит; (6) что auto-assign concierge picker остаётся base-only и premium-венью проходят
все non-price гейты. Отчёт по правилам сессии.
```

---

# E. Планирование и дата

## 18. Календарь (scheduling)

- **Область:** серверная сетка слотов (6 дат × 14 слотов, 13:00–19:30 /30м); multi-pick с live peer-видимостью; initiator-offers/responder-decides; auto-lock; first-mover DM; one-card-per-side.
- **Ключевые файлы:** `handlers/matching/scheduler.ts` + тест, `post-accept-message.ts`; `public/routes/calendar.ts` + `calendar.test.ts`; `apps/webapp/src/calendar-selection.ts`, `slots.ts`, `state-render.ts`.
- **Замысел:** обе стороны видят один allowlist; API отклоняет ISO не из сетки. Пересечение `availableTimesA∩B`: 0 → ничего, DM; 1 → auto-lock + `startVenueNegotiation`; >1 → `overlapCandidates`, actor подтверждает (asymmetry «initiator offers, responder decides»). No-overlap ping gated на реальном изменении набора (re-save = no-op). One live post-accept card per side (`calendarMessageIdA/B`), редактируется in-place.
- **Инварианты:** `initData` HMAC на state/pick; multi-overlap не auto-lock'ается; редундантный Save не пингует peer повторно.

```
Проведи аудит календарного scheduling.
Прочитай: handlers/matching/scheduler.ts (+ тест), post-accept-message.ts; public/routes/
calendar.ts (+ тест); apps/webapp/src/calendar-selection.ts, slots.ts, state-render.ts. Сверь
с PRODUCT_SPEC §3.6. Проверь: (1) генерацию сетки (6 дат × 14 слотов, 13:00–19:30 /30м) и что
API отклоняет любой ISO вне allowlist; (2) резолвинг пересечения: 0→DM, 1→auto-lock+
startVenueNegotiation, >1→overlapCandidates без auto-lock (initiator-offers/responder-decides);
(3) что multi-overlap confirm требует iso, лайкнутый обеими сторонами, и коллапс до size-1
попадает на lock-путь; (4) first-mover DMs и что no-overlap ping gated на реальном изменении
набора (re-save = no-op, не пингует peer снова); (5) initData HMAC на /calendar/state и /pick;
(6) one live card per side (calendarMessageIdA/B): edit in-place, fallback на replacement если
сообщение исчезло, снятие обеих карт при lock; (7) легаси sched:pick:* graceful fallback.
Отчёт по правилам сессии.
```

## 19. Concierge venue negotiation + Venue Intent V2

- **Область:** departure origin → vibe → (V2: canonical chips + confirm); curated-first ranking (fairness-aware max-min); Google Places fallback + quality gate; open-at-slot; blurb; V2 shadow-rollout.
- **Ключевые файлы:** `handlers/matching/venue-negotiation.ts` + тест; `services/venue.ts`, `curated-venue.ts`, `venue-intent-v2.ts`, `initial-venue-policy.ts`, `vibe-parser.ts`, `venue-blurb.ts`, `venue-finalization-flight.ts`, `venue-revalidation.ts`, `geo.ts`; `packages/shared/src/venue-intent.ts`; `public/routes/location.ts`, `city-search.ts`.
- **Замысел:** departure спрашивается ПЕРВЫМ и отдельно; vibe — только после origin; текст до pin не банкается как vibe (redirect). Curated — PRIMARY когда есть; ранжирование минимизирует `max(distA,distB)`, вес priority + vibe bonus, discard если worse-commute > 8км. Places-fallback strict gate (OPERATIONAL, deny-list типов, ≥30 reviews, ≥4.0, price tier для food). Closed-at-slot skip (missing hours = open). V2: два шага, canonical IDs soft, hard только confirmed dietary/alcohol-free/step-free/setting/commute; bridge lane; никогда не коллапс в café; provider-outage → curated/retry, никогда placeholder. Shadow пишет только лог.
- **Инварианты:** confirmed V2 intent — единственный вход в finalize, ordinary Telegram-сообщения не перетирают; каждый venue реальный/operational/open-at-slot с provenance; unknown evidence/hours fail closed.

```
Проведи аудит venue negotiation + Venue Intent V2.
Прочитай: handlers/matching/venue-negotiation.ts (+ тест); services/venue.ts, curated-venue.ts,
venue-intent-v2.ts, initial-venue-policy.ts, vibe-parser.ts, venue-blurb.ts,
venue-finalization-flight.ts, venue-revalidation.ts, geo.ts; packages/shared/src/venue-intent.ts;
public/routes/location.ts, city-search.ts. Сверь с PRODUCT_SPEC §3.7 и секцию «Venue Intent V2».
Проверь: (1) порядок departure→vibe, что текст до pin не банкается как vibe (redirect
venueLocationFirst), per-side ACK для трёх путей; (2) curated-first ранжирование fairness-aware
(min max(distA,distB), priority-вес, vibe-bonus, discard > 8км) и open-at-slot (missing hours =
open); (3) Places strict quality gate во ВСЕХ tier (включая searchText fallback: deny-list типов,
OPERATIONAL строгий, ≥30/≥4.0, price для food) — что petrol-station с кофе не протекает;
(4) V2: confirmed intent как ЕДИНСТВЕННЫЙ вход в finalize (ordinary сообщения не перетирают,
сервер не ре-парсит), hard-constraints только для confirmed dietary/alcohol-free/step-free/
setting/commute, bridge lane и что нет коллапса в café; (5) provider-outage → eligible curated
или durable 1/5/15-мин ретраи, НИКОГДА placeholder; unknown evidence/hours fail closed;
(6) shadow-режим пишет только append-only VenueSelectionLog и не мутирует матч/не нотифает;
(7) venue-finalization-flight от гонок финализации. Отчёт по правилам сессии.
```

## 20. Date Card (PNG-рендер)

- **Область:** серверный рендер PNG в теме получателя (satori→resvg, canvas duotone/grain); protected private-копия; Share с blurred-лицом; live render progress hold.
- **Ключевые файлы:** `services/date-card/*`, `handlers/date/date-card.ts` + тест; `services/analysis-status.ts`, `ai-stream.ts`; шрифты/бренд-ассеты.
- **Замысел:** каждая сторона видит ПАРТНЁРА; рендер в `User.theme`; venue duotone hero + tilted polaroid; карта опускает дату/время (оно в caption). Private-копия `protect_content:true` + Share-кнопка. Share ре-рендерит с blurred-лицом (Rekognition DetectFaces + пикселизация) и шлёт БЕЗ protect. Privacy fail-safe: если blur не сделать — share aborted, никогда не fallback на чистый оригинал. Любой fail рендера → plain-text scheduled DM.
- **Инварианты:** blurred share — реальная privacy-гарантия (protect не блокирует скриншоты); render-fail деградирует per-side, не блокирует другую сторону; кэш `dateCardFileIdA/B` инвалидируется на смене темы/языка.

```
Проведи аудит Date Card (PNG-рендер + share-blur).
Прочитай: services/date-card/*; handlers/date/date-card.ts (+ тест); services/analysis-status.ts,
ai-stream.ts. Сверь с PRODUCT_SPEC §3.7a. Проверь: (1) что каждая сторона видит ПАРТНЁРА и рендер
в User.theme получателя; (2) privacy fail-safe: если blur не удаётся — share ABORTED, никогда не
отправляется чистый оригинал без protect; (3) private-копия protect_content:true, share-копия без
protect но с blurred-лицом (DetectFaces boxes + пикселизация); (4) что ЛЮБОЙ fail рендера/сенда
деградирует per-side в plain-text scheduled DM и не блокирует вторую сторону; (5) held render
progress (until: <render promise>) — тир-даун статуса до отправки, без зависшего чата; (6) кэш
dateCardFileIdA/B: инвалидация на смене темы/языка, что конкуррентный стейл-рендер не перезапишет
кэш (сверка language/theme со снапшотом); (7) venue-photo: curated first, иначе Places cover
(fetch на рендере, не персистится). Отчёт по правилам сессии.
```

## 21. Venue Change v2 (платный board)

- **Область:** shared likes board на `scheduled`-матче; 3км радиус; agreement-механика (calendar-подобная); payer matrix (hetero: мужчина/инициатор); express (hers alone); wish card; keep-original; lapse (никогда не отменяет матч).
- **Ключевые файлы:** `handlers/matching/venue-change.ts` + тест; `services/venue-change.ts` + тест, `venue-wish-card.ts`; `public/routes/venue-change.ts` + `venue-change-api.test.ts`; `apps/webapp/src/venue-change.ts`.
- **Замысел:** статус null→liking→agreed→settled/lapsed. Лайки server-resolved (клиент-данные не доверяются). Первый лайк claim'ит инициатора + один board-invite DM. Agreement instant при single overlap, multi → confirm. Payment 150⭐ только на settle; browsing/liking free → refund-путь не нужен (кроме parallel-pay race). His decline — single/final, ENDS change (сессия закрывается, оригинал стоит). Express — unilateral, invisible пока не оплачено, abandoned mint reverts ~30 мин. Lapse на date-lifecycle тике — оригинал стоит, матч не тронут.
- **Инварианты:** settle CAS agreed→settled копирует snapshot на канонические venue-поля; sticky offer/decline не сбрасывается пока сессия жива (нельзя re-nag); никакой free-text (no chat carve-out не нужен).

```
Проведи аудит Venue Change v2 (платный likes-board).
Прочитай: handlers/matching/venue-change.ts (+ тест); services/venue-change.ts (+ тест),
venue-wish-card.ts; public/routes/venue-change.ts (+ тест); apps/webapp/src/venue-change.ts.
Сверь с PRODUCT_SPEC §3.7b. Проверь: (1) server-resolve лайков против каталога (client venue
data не доверяется), первый лайк claim'ит инициатора + ровно один board-invite DM (guard);
(2) agreement: single-overlap instant, multi → overlapCandidates confirm (initiator-offers/
responder-decides); (3) payer matrix (hetero мужчина/инициатор; same-sex инициатор), express
female-only hetero; (4) his decline single/final — ENDS change, закрывает сессию на оригинал,
нейтральный venueDeclinedKeepDm без цены (её не пушат платить); parallel-pay race → settle CAS
first-wins + refundStarPayment; (5) express: invisible пока не оплачено, abandoned mint reverts
~30 мин, surprise card на оплате; (6) keep-original как «путь назад» — снимает marks, зовёт off
agreement, оригинал не тронут; sticky offer/decline НЕ сбрасывается пока сессия жива (нельзя
re-nag wish-card); (7) lapse на date-lifecycle тике НИКОГДА не отменяет матч; settle копирует
snapshot на канонические venue*-поля (+ фото для re-render). Отчёт по правилам сессии.
```

## 22. Date lifecycle + coordination + emergency + feedback

- **Область:** тик каждые 2 мин; wingman hints (на activation); icebreakers + emergency window (T-5ч); safety brief (T-1.5ч); coordination offer (T-60м); proxy open/close (T-30м/T+2ч); feedback (T+24ч); emergency protocol; pre-date coordination (варианты A/B/C).
- **Ключевые файлы:** `services/date-lifecycle.ts`, `pre-date-safety.ts`, `coordination.ts` + тест, `wingman-hint.ts`; `handlers/date/emergency.ts`, `feedback.ts`, `coordination.ts` + тест, `router.ts`; `public/routes/feedback.ts`; `proxy_messages`.
- **Замысел:** все действия идемпотентны через timestamp-колонки. Icebreakers стримятся rich, финал plain. Safety brief — female-only Telegram DM (mobile → push). Coordination (feature-flag): инициатор — female (или first-tap в same-sex); username-aware меню (A/B/C); C открывается unconditionally на T-30м (offline-партнёр не должен застрять); media в proxy отклоняется, всё в `ProxyMessage` + Report. Emergency: confirmation guard (Keep first/success, Cancel danger), verbatim reason блок-цитатой, peer +5 Elo, canceller не штрафуется. Feedback: форма Mini App или voice, общий `recordPostDateFeedback`.
- **Инварианты:** идемпотентность каждого гейта; blind rule (icebreakers/wingman не durable в хабе); proxy media-reject закрывает face/metadata-leak; emergency cancel не инкрементит eloMatchesPlayed.

```
Проведи аудит date lifecycle + coordination + emergency + feedback.
Прочитай: services/date-lifecycle.ts, pre-date-safety.ts, coordination.ts (+ тест),
wingman-hint.ts; handlers/date/emergency.ts, feedback.ts, coordination.ts (+ тест), router.ts;
public/routes/feedback.ts. Сверь с PRODUCT_SPEC §Phase 4 (+ Emergency, Coordination). Проверь:
(1) идемпотентность КАЖДОГО гейта через timestamp-колонки (icebreakersSentAt/safetyNoteSentAt/
coordOfferSentAt/proxyOpened/Closed/feedbackPromptedAt) — двойной тик не дублирует; (2) тайминги
T-5ч/T-1.5ч/T-60м/T-30м/T+2ч/T+24ч и что safety brief female-only Telegram (mobile→push),
skip если у female нет Telegram; (3) coordination: инициатор female / first-tap same-sex,
username-aware A/B/C, вариант C открывается unconditionally T-30м, proxy media-reject + запись в
ProxyMessage + inline Report, re-check окна на каждое сообщение (self-heal после close); (4) что
proxy/coordination НЕ перехватывает обычное использование бота (/menu, фото); (5) emergency:
confirmation guard (Keep first/success, Cancel danger), no-op на stray tap, verbatim reason
блок-цитатой без AI-rewrite, peer +5 Elo, canceller не штрафуется и eloMatchesPlayed не растёт;
(6) feedback: форма и voice-путь идут через общий recordPostDateFeedback, апдейт negativeConstraints.
Отчёт по правилам сессии.
```

---

# F. Кросс-каттинг и платформа

## 23. Trust & Safety (reports + strikes + moderation)

- **Область:** post-match report; LLM-триаж в tier 1/2/3; strike-эскалация; auto-unsuspend; MatchEvent-телеметрия.
- **Ключевые файлы:** `handlers/matching/report.ts` + тест; `services/moderation.ts` + тест, `match-events.ts`, `cancel-in-flight-matches.ts`; `public/routes/matches.ts` (report); `reports`.
- **Замысел:** tier 1 → аппенд в negativeConstraints репортёра, без штрафа. tier 2 → strike++ (1: warning, 2: suspended 14д + отмена матчей, ≥3: banned). tier 3 → pending_investigation немедленно + отмена матчей, ряд остаётся `adminReviewed=false`. `(reporterId, matchId)` unique. auto-unsuspend hourly.
- **Инварианты:** tier 2/3 status-change + отмена матчей в одной транзакции, партнёрская компенсация/нотификации после коммита и не ослабляют cancellation gate; дубль-репорт отклоняется на write.

```
Проведи аудит Trust & Safety (reports + strikes + moderation).
Прочитай: handlers/matching/report.ts (+ тест); services/moderation.ts (+ тест), match-events.ts,
cancel-in-flight-matches.ts; report-часть public/routes/matches.ts. Сверь с PRODUCT_SPEC §5 и
ARCHITECTURE (reports). Проверь: (1) корректность LLM-триажа в tier и действий: t1 аппенд в
negativeConstraints репортёра без штрафа reported; t2 strike-эскалация (warning/suspended 14д/
banned) с отменой матчей при strike≥2; t3 pending_investigation немедленно + отмена + adminReviewed
false; (2) что tier2/3 status-change + cancel in-flight в ОДНОЙ транзакции, а партнёрская
компенсация/нотификации только после коммита и не ослабляют cancellation gate; (3) unique
(reporterId, matchId) отклоняет дубль на write (reportDuplicate); (4) autoUnsuspendElapsed hourly
реактивирует истёкшую t2-suspension; (5) корректность MatchEvent-логов и Elo-эффектов. Отчёт по
правилам сессии.
```

## 24. Mobile /v1 API + auth (JWT / OTP / phone)

- **Область:** JWT bearer + refresh-rotation; email OTP; phone rail (Twilio primary / Telegram Gateway secondary); `/v1/app/config` kill-switch; `/v1/me/*`; live-activity; OpenAPI parity.
- **Ключевые файлы:** `public/routes/jwt.ts`, `auth.ts`, `auth-middleware.ts`, `otp.ts`, `phone-auth.ts`, `me.ts`, `account-status.ts`, `home-location.ts`, `live-activity.ts`, `app-config.ts`, `serializers.ts`, `ui-hints.ts`; `services/phone-verification.ts`, `email.ts`; `openapi/gennety-v1.yaml`.
- **Замысел:** access-JWT pinned HS256, issuer `gennety-public-api`, audience `gennety-mobile`, UUID subject; refresh хешируется в `user_sessions` для ротации/ревокейта. Email OTP bcrypt-хеш, advisory-lock на per-email creation. Phone: provider-fork env-driven (default twilio), per-phone advisory-lock + daily cap, find-or-create по unique phone. `/v1/app/config` pre-auth (kill-switch). Любое изменение shape `/v1/*` → обновить OpenAPI в том же коммите.
- **Инварианты:** public API отказывается стартовать при JWT_SECRET < 32 байт; `void`-возврат advisory-lock через `$executeRawUnsafe` (P2010 gotcha); mobile-only юзеры не duplicate-аккаунтятся по phone.

```
Проведи аудит mobile /v1 API + auth (JWT/OTP/phone).
Прочитай: public/routes/jwt.ts, auth.ts, auth-middleware.ts, otp.ts, phone-auth.ts, me.ts,
account-status.ts, home-location.ts, live-activity.ts, app-config.ts, serializers.ts, ui-hints.ts;
services/phone-verification.ts, email.ts. Сверь с ARCHITECTURE (Public API) и openapi/gennety-v1.yaml.
Проверь: (1) JWT pinned HS256 + issuer/audience/UUID-subject, отказ старта при JWT_SECRET < 32 байт,
refresh-token хеширование и ротация/ревокейт в user_sessions; (2) email OTP: bcrypt-хеш, replay
(attempts/consumedAt), advisory-lock per-email creation (и что это $executeRawUnsafe, не queryRaw —
P2010); (3) phone rail: provider-fork (twilio primary/gateway secondary, channel:sms форсит Twilio),
per-phone advisory-lock + durable daily cap, find-or-create по unique phone (Telegram и mobile не
дублируют аккаунт), 404 при PHONE_AUTH_ENABLED off, 503 без провайдера; (4) /v1/app/config pre-auth
kill-switch (minSupportedIosVersion) и feature-flags; (5) PUBLIC_CORS_ORIGIN: пустой = deny cross-
origin, native без Origin не задет; (6) что изменения shape /v1/* синхронны с openapi/gennety-v1.yaml
(pnpm openapi:lint), additive-only. Отчёт по правилам сессии.
```

## 25. Aether concierge (mobile-чат)

- **Область:** мультимодальный AI-чат с фоновым сбором фактов (`update_profile`/`attach_profile_photo`); персист per-turn `Message`; image-attach → тот же upload-safety путь.
- **Ключевые файлы:** `services/aether-agent.ts`, `aether-profile-tools.ts` + тест; `public/routes/chat.ts`, `assistant.ts`; `services/storage.ts`.
- **Замысел:** отличается от онбординг-агента: пишет `Message`-строки, поддерживает image-attach. Post-onboarding fixed identity (age и т.п.) нельзя менять через tool. Прикрепление chat-image к профилю ре-прогоняет весь upload-safety/face/identity/duplicate/verification-rerun путь. Токен-бюджет через usageGuard.
- **Инварианты:** fixed-поля не меняются; attach проходит те же гейты, что и обычная загрузка; verification-rerun триггерится.

```
Проведи аудит Aether concierge (mobile-чат).
Прочитай: services/aether-agent.ts, aether-profile-tools.ts (+ тест); public/routes/chat.ts,
assistant.ts; services/storage.ts. Сверь с PRODUCT_SPEC §2.2 (Aether) и ARCHITECTURE (messages).
Проверь: (1) что update_profile НЕ меняет post-onboarding fixed identity (age/firstName/email/
universityDomain); (2) что attach_profile_photo ре-использует ПОЛНЫЙ upload-safety/face-presence/
identity/duplicate-hash/profile-bucket copy/metadata/verification-rerun путь (тот же, что /v1/me/
photos), сохраняя выравнивание массивов; (3) персист per-turn Message (роль/imageUrl как opaque
Supabase-путь, signed URL на рендере); (4) usageGuard токен-бюджет на /v1/chat; (5) валидация
image-upload (content-sniff) и очистка storage при фейле пост-коммита. Отчёт по правилам сессии.
```

## 26. Admin analytics + Founder notifications

- **Область:** admin `/admin/*` (bearer, helmet, rate-limit); analytics-роутеры; conversation viewer + media proxy; founder ops-feed (new-user/weekly-report/date-card/delete) + tokenized report page.
- **Ключевые файлы:** `admin/server.ts` + тест, `admin/routes/*`, `admin/utils/*`; `services/founder-notify.ts` + тест, `weekly-matches-report.ts`; `public/routes/founder-report.ts`; `founder_reports`.
- **Замысел:** admin bearer timing-safe compare, per-IP rate-limit, media proxy никогда не принимает ключ в query. Founder: отдельный бот, DM'ит 4 события; tokenized report page (unguessable token = единственная авторизация, `noindex`); снапшот НЕ содержит psychologicalSummary/AI-memory. Delete-путь снапшотит перед каскадом; account-deletion явно чистит founder-снапшоты с этим userId.
- **Инварианты:** token — единственная авторизация и не логируется; media proxy scoped только к refs данного отчёта; PII живёт только в снапшоте.

```
Проведи аудит admin analytics + founder notifications.
Прочитай: admin/server.ts (+ тест), admin/routes/*, admin/utils/*; services/founder-notify.ts
(+ тест), weekly-matches-report.ts; public/routes/founder-report.ts. Сверь с ARCHITECTURE (Admin
API, founder_reports) и deploy.md (FOUNDER_NOTIFY_ENABLED). Проверь: (1) admin auth: timing-safe
bearer compare, helmet, per-IP rate-limit, media proxy НЕ принимает ключ в query и валидирует
Supabase-ref от path-traversal; (2) founder report page: unguessable token = единственная
авторизация, noindex, token не логируется, media proxy scoped только к refs ИМЕННО этого отчёта;
(3) что снапшот НЕ содержит psychologicalSummary/AI-memory dump; (4) delete-путь снапшотит перед
каскадом и account-deletion явно удаляет founder-снапшоты с departing userId (нет FK-каскада в
JSON); (5) корректность агрегаций (onboarding-funnel/cities/growth/founder-digest), кеширование,
BigInt-сериализация. Отчёт по правилам сессии.
```

## 27. GDPR / удаление аккаунта (общий сервис)

- **Область:** единый deletion-сервис для Telegram и mobile; порядок storage-erase → cancel matches → purge founder → cascade → partner-notify; freeze как soft-delete; selfie-retention; researchOptIn.
- **Ключевые файлы:** `services/account-deletion.ts` + тест, `account-status-transitions.ts`, `cancel-in-flight-matches.ts`, `selfie-retention.ts`; `public/routes/me.ts` (DELETE), `account-status.ts`, `handlers/menu/account-action.ts`.
- **Замысел:** Telegram и mobile делят один сервис. Строгое стирание owned Supabase-медиа ПЕРВЫМ, потом атомарная CAS-отмена матчей, purge founder-снапшотов, каскад Prisma; уведомление/компенсация партнёра ТОЛЬКО после коммита. Storage-fail → 503, аккаунт и матчи целы (безопасный ретрай, не half-deleted). Freeze сохраняет всё и убирает из пула.
- **Инварианты:** GDPR-delete доступен независимо от статуса; каскад `onDelete: Cascade` на всех связях; founder получает только анонимный lifecycle-event.

```
Проведи аудит GDPR-удаления и freeze (общий deletion-сервис).
Прочитай: services/account-deletion.ts (+ тест), account-status-transitions.ts,
cancel-in-flight-matches.ts, selfie-retention.ts; public/routes/me.ts (DELETE), account-status.ts;
handlers/menu/account-action.ts. Сверь с PRODUCT_SPEC §2.1 (freeze/delete) и ARCHITECTURE (GDPR).
Проверь: (1) строгий порядок delete: storage-erase owned-media ПЕРВЫМ → CAS-отмена всех in-flight
матчей → purge founder-снапшотов с userId → Prisma cascade → partner-notify/comp ТОЛЬКО после
коммита; (2) storage-fail → 503, аккаунт+матчи целы (нет half-deleted с реальными партнёрскими
эффектами); (3) что Telegram и mobile делят ОДИН сервис; (4) freeze: транзакционный soft-delete
(сохраняет profile/embedding/verification/photos), убирает из пула (движок матчит только active),
отмена in-flight + comp, тихая реактивация frozen→active; concurrent moderation wins; (5) selfie-
retention 90д (статус остаётся verified); (6) что founder получает только анонимный lifecycle-event,
а delete не создаёт свежую копию контактов/фото. Отчёт по правилам сессии.
```

## 28. Кросс-каттинг: rate-limit, i18n, rich-стриминг

- **Область:** anti-spam/token-budget (bot + /v1 LLM-роутеры); usage attribution через AsyncLocalStorage; i18n 5 языков (запрет English enum-injection); rich AI-compose стрим (`<tg-thinking>` + AI Actions) с деградацией.
- **Ключевые файлы:** `services/usage-limiter.ts` + тест, `usage-context.ts`, `openai-fetch.ts` + тест, `public/usage-middleware.ts`, `bot-rate-limit.ts`; `packages/shared/src/i18n.ts` (+ de/pl модули); `services/ai-stream.ts`, `analysis-status.ts`, `telegram-rich.ts`, `ai-emoji.ts`.
- **Замысел:** одна in-memory sliding-window механика (single PM2). Bot метрит text/voice (callbacks не throttl'ятся); token-budget через `usageGuard` на `/v1/chat|assistant|onboarding`; учёт из точного `usage.total_tokens` через `openaiFetch` + ambient key + process-wide hourly breaker. i18n: 5 языков, `en` fallback, агенты автодетектят язык и запрещают инъекцию English enum-слов в non-English. Rich-стрим hard-coded per call-site (`rich:true`), НЕ глобальный toggle; деградирует в classic edited-stream; content-стримы (pitch/no-match/icebreaker) финалят plain sendMessage.
- **Инварианты:** пороги loose (нормальное использование не триггерит); Whisper по длительности, не токенам; никакого `RICH_THINKING_ENABLED` глобального флага; финал content-стрима — plain, не rich.

```
Проведи аудит кросс-каттинга: rate-limit/token-budget, i18n, rich-стриминг.
Прочитай: services/usage-limiter.ts (+ тест), usage-context.ts, openai-fetch.ts (+ тест),
public/usage-middleware.ts, bot-rate-limit.ts; packages/shared/src/i18n.ts (+ de/pl); services/
ai-stream.ts, analysis-status.ts, telegram-rich.ts, ai-emoji.ts. Сверь с ARCHITECTURE (Rate
Limiting) и deploy.md (chat streams). Проверь: (1) token-attribution: openaiFetch читает точный
usage.total_tokens и заряжает ambient AAsyncLocalStorage-ключу + process-wide hourly breaker; что
все OpenAI call-sites используют openaiFetch (иначе утечка учёта); (2) bot-rate-limit метрит
text/voice, НЕ throttl'ит inline-callbacks, дропает флуд ДО хендлера; usageGuard на /v1/chat|
assistant|onboarding даёт 429 над бюджетом; Whisper под voice-лимитером, не token-budget;
(3) i18n: 5 языков + en fallback, что server-темплейты/агенты не инъектят English enum-слова
(male/female/men/women) в non-English ответы; (4) rich-стрим: hard-coded rich:true per call-site
(НЕТ глобального RICH_THINKING_ENABLED), корректная деградация в classic при отсутствии rich-drafts;
(5) что финал content-стримов (pitch/no-match/icebreaker) — plain sendMessage, а не rich (иначе
editMessageText countdown-воркера сломается). Отчёт по правилам сессии.
```

---

## Порядок прохождения (рекомендация)

Иди по критичности для «денег и доверия», затем по пользовательскому пути:

1. **Сначала trust/деньги:** 4 (верификация) → 10 (матч-движок) → 13 (blind-decision) → 16 (платежи) → 15 (тикеты) → 27 (GDPR).
2. **Потом основной путь:** 1–3 (онбординг) → 12 (питч) → 18–19 (календарь/venue) → 22 (date lifecycle).
3. **Затем периферия:** 5–9, 11, 14, 17, 20–21, 23–26, 28.

Каждая сессия — один блок. После сессии, если находки требуют фиксов, запускай
отдельную сессию «фикс по findings блока N» — не смешивай аудит и правки, чтобы
git-журнал оставался атрибутируемым.
```
