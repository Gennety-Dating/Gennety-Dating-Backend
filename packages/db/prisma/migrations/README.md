# Миграции

Появились 2026-09-07 по находке аудита «Миграции БД». До этого схема
накатывалась `prisma db push --accept-data-loss`, и отката не существовало:
откат кода при уже применённой схеме — это не деградация, а полный простой
публичного API, который держит iOS-клиент.

## Из чего состоит набор

| Миграция | Что в ней | Откуда взялась |
|---|---|---|
| `0_baseline` | Продовая база **как она есть** на 2026-09-07 | `migrate diff --from-empty --to-schema-datasource`, снято с живой базы |
| `20260907120000_trunk_catchup` | То, что уже в `schema.prisma` ствола, но ещё не выкачено (meme-поля профайлера, `city_waitlist_entries`, `short_video_analyses`, `place_cache`) | `migrate diff` от живой базы к схеме ствола |
| `20260907120100_audit_indexes_and_bot_blocked` | Изменения самого аудита: `users.bot_blocked_at` и восемь индексов | `migrate diff` от схемы ствола к схеме ветки |
| `20260908090000_proxy_chat_delivery` | Колонки прокси-чата, приехавшие со ствола | `migrate diff` |
| `20260908120000_virality_tracking` | Виральность: `referral_events`, `hdyhau_responses`, `virality_days`, `virality_cohorts`. **Чисто аддитивная** — ни одной изменённой или удалённой колонки | Написана вручную и **сверена** с `migrate diff --from-empty --to-schema-datamodel`: колонки, индексы и внешние ключи совпадают дословно (теневая база недоступна — см. оговорку ниже) |
| `20260911120000_date_terminal_and_hub_fallback` | `matches.terminal_invite_sent_at` / `terminal_reminder_sent_at` (два сообщения Date Terminal) и `curated_venues.is_hub_fallback` (опорное место Venue Intent V2). Аддитивная; плюс **одна строка данных** — `UPDATE`, помечающий киевский хаб по `place_id` (ноль строк на базе без каталога, это нормально) | Написана вручную; DDL сверен с `migrate diff --from-empty --to-schema-datamodel` |
| `20260911190000_profile_music_tracks` | Музыка в профиле: `profile_music_tracks` — до трёх треков Spotify на человека, каскадное удаление вместе с `users`. **Чисто аддитивная** | Написана вручную; DDL сверен с `migrate diff --from-empty --to-schema-datamodel` дословно |
| `20260911200000_frequent_places` | Часто посещаемые места: `users.frequent_places_opt_in` (`NOT NULL DEFAULT true` — решение основателя 2026-09-11), таблицы `user_place_visits` (уникальный `(user_id, place_id, visit_day)`, индекс `visit_day`) и `user_hidden_places`. **Чисто аддитивная** — ни одной изменённой или удалённой колонки | Написана вручную; DDL совпадает дословно с `migrate diff --from-schema-datamodel <ствол> --to-schema-datamodel <ветка> --script` |
| `20260913090000_inbox_announcements` | Инбокс, объявления и контекст чата: `messages.context` (JSONB, nullable), таблицы `announcements` и `inbox_items` (уникальный `(user_id, announcement_id)` — защита рассылки от повторного прохода; индексы `(user_id, created_at)` и `(announcement_id, pushed_at)`). **Чисто аддитивная** | Написана вручную; DDL совпадает дословно с `migrate diff --from-schema-datamodel <ствол> --to-schema-datamodel <ветка> --script`; накат на базу из схемы ствола (без vector) и `migrate diff --from-url` → `-- This is an empty migration.` |
| `20260914120000_a13_deletion_retention` | Удаление аккаунта сохраняет нужное закону и безопасности (A13-H14): `user_id` журналов и покупок (`ticket_ledger`, `subscription_ledger`, `rematch_purchases`, `venue_change_purchases`, `prime_time_purchases`) — nullable, `ON DELETE SET NULL`; в `reports` nullable `reporter_id`/`reported_id`/`match_id` с `SET NULL` + `reported_former_id`; в `user_blocks` nullable `blocked_id` с `SET NULL` + `blocked_former_id`; новая таблица `safety_tombstones`; индекс `inbox_items(created_at)` (A13-L29); `matches.ticket_price_cents DEFAULT 849` (A13-L30). Ни одна строка не переписывается; внешние ключи пересоздаются. **Миграция перед рестартом кода, в одном деплое** — старый клиент считает эти связи обязательными | `migrate diff --from-schema-datamodel <ствол> --to-schema-datamodel <ветка> --script`; ВСЕ миграции накачены `migrate deploy` на одноразовую базу в локальном Postgres 16 + pgvector (у `0_baseline` вырезаны только supabase-расширения `pg_stat_statements`/`supabase_vault`), `migrate diff --from-url` → `-- This is an empty migration.` |
| `20260921120000_message_image_urls` | Несколько снимков в одном ходе чата: `messages.image_urls` (`TEXT[] DEFAULT '{}'`). **Чисто аддитивная**, константный дефолт — без переписывания строк. Коммит `b1562471` поменял только `schema.prisma`, миграцию дописали перед сводным выкатом 2026-09-21 | `migrate diff --from-schema-datamodel <a6e902d5> --to-schema-datamodel <b1562471> --script` дословно. Репетиция принятия на одноразовой базе (Postgres 16 без pgvector — из копий вырезаны `vector`, `pg_stat_statements`, `supabase_vault` и колонка `embedding`): baseline накатан как «живая база» → `migrate resolve --applied 0_baseline` → `migrate deploy` применил все 11 → `migrate diff --from-url` → `-- This is an empty migration.`, `migrate status` — up to date |
| `20260922120000_referral_ticket_rewards` | Реферальная программа платит только билетами (решение 2026-09-22): таблицы `referral_qualifications` (одна строка на засчитанного приглашённого; уникальный `invitee_id`, обе ссылки на `users` — `ON DELETE SET NULL`, индексы `(referrer_id, status, created_at)` и `(status, referrer_id)`) и `referral_identities` (ключевые хэши доказанных идентичностей приглашённого, каскад с квалификацией). Поле Prisma `User.referralGiftSeenAt` сидит на существующей колонке `referral_invitee_premium_at` через `@map` — без DDL. **Чисто аддитивная** | `migrate diff --from-schema-datamodel <923d4233> --to-schema-datamodel <ветка> --script` дословно; одноразовая база из схемы ствола (без vector) + `psql -f migration.sql` → `migrate diff --from-url` → `-- This is an empty migration.` |
| `20260922180000_venue_change_activity` | Live Activity смены места на iOS (решение 2026-09-22): таблица `venue_change_activities` — по строке на сторону, пока сервер считает карточку на экране блокировки живой (фаза, хэш последнего содержимого, момент push-to-start). PK `(match_id, user_id)`; `user_id` — `ON DELETE CASCADE`, `match_id` без внешнего ключа (как у `venue_change_purchases`). **Чисто аддитивная** | `migrate diff --from-schema-datamodel <216567d5> --to-schema-datamodel <ветка> --script` дословно; одноразовая база в локальном Postgres 16 из схемы ствола (без vector) + `psql -f migration.sql` → `migrate diff --from-url` → `-- This is an empty migration.` |
| `20260925090000_tempo_sync_life_rhythm` | Tempo Sync (решение 2026-09-24, вариант B): таблица `user_rhythm_profiles` (PK `user_id`, `ON DELETE CASCADE`, индекс `synced_at` для ретеншена) — две грубые метки ритма из Apple Health; `match_score_logs.score_rhythm` (`DEFAULT 1`) и `rhythm_similarity` (nullable); `curated_venues.transit_walk_m` / `pedestrian_nearby` / `osm_enriched_at` (факты OSM для Tier 2 мест); `matches.after_date_place` (JSONB, пост-сценарий). **Чисто аддитивная** | `migrate diff --from-schema-datamodel <741a1c9b> --to-schema-datamodel <ветка> --script` дословно |
| `20260926120000_user_block_reason` | Необязательная причина блокировки, только для модерации (решение 2026-09-26): `user_blocks.reason` (`TEXT`, nullable, без дефолта). Никогда не показывается заблокированному и не отдаётся `GET /v1/me/blocks`. **Чисто аддитивная** — метаданные, ни одна строка не переписывается | `migrate diff --from-schema-datamodel <f59d9d5a> --to-schema-datamodel <ветка> --script` дословно; на базе не прогонялась — локальный `gennety-dev-db` (5434) был выключен |
| `20260926200000_drop_launch_events` | Launch Events вырезаны целиком (решение основателя 2026-09-16): **ДРОПАЕТ** 8 таблиц (`events`, `waitlist_applications`, `event_ticket_tiers`, `event_tickets`, `event_staff_tokens`, `event_rounds`, `event_round_pairings`, `event_feedback`) и колонку `announcements.event_id` с её внешним ключом. **Деструктивная**, но в проде таблицы пусты (`EVENTS_FEATURE_ENABLED` там никогда не включался) — проверка `SELECT count(*)` в шапке миграции и в `pending.md`. **Код ДО миграции**: старый процесс джойнит `events` и выбирает `event_id`. Написана 2026-09-16 как `20260916120000_…`, нигде не применялась; при посадке на ствол 2026-09-26 переименована, чтобы встать после `20260926120000_user_block_reason` | `prisma migrate diff --from-schema-datamodel <ствол> --to-schema-datamodel <ветка> --script` (ветка `7203e338`). При посадке 2026-09-26: весь набор миграций (без `vector`/`pg_stat_statements`/`supabase_vault` и колонки `embedding` в копии) накатан на одноразовую базу в локальном Postgres 16 как теневая, `migrate diff --from-migrations … --to-schema-datamodel …` → `-- This is an empty migration.` (на стволе до посадки — так же пусто) |
| `20260926200100_retire_external_profile_import` | Внешний импорт AI-контекста (Magic Prompt / ai-memory export) удалён (решение основателя 2026-09-24): **ДРОПАЕТ** `users.ai_memory_export_preference`, `users.ai_memory_export_preference_at` и enum `AiMemoryExportPreference`; **переписывает данные** — убирает ключи `ai_memory`/`context_dump` из `onboarding_progress` (`revision + 1`), `awaitingContextDump`/`contextDumpBuffer` из `bot_sessions.data` и обнуляет `users.message_history` только у `status = 'onboarding'`, чья история несёт старые инструкции. Ответы анкеты и фото не трогает. **Деструктивная и необратимая** (без бэкапа переписанное не вернуть); **код ДО миграции** — старый процесс выбирает дропнутые колонки в каждом чтении `user` без `select`. Своё `BEGIN`/`COMMIT` внутри. Написана 2026-09-24 как `20260923120000_…`, нигде не применялась; при посадке на ствол 2026-09-26 переименована, чтобы встать после `20260926200000_drop_launch_events` | Написана вручную (ветка `2d2b42d7`). При посадке 2026-09-26: весь набор миграций (без `vector`/`pg_stat_statements`/`supabase_vault` и колонки `embedding` в копии) накатан на одноразовую базу в локальном Postgres 16 как теневая, `migrate diff --from-migrations … --to-schema-datamodel …` → `-- This is an empty migration.` (на стволе до посадки — так же пусто) |
| `20260926200200_time_agreement_activity` | Live Activity согласования времени на iOS (решение 2026-09-23): таблица `time_agreement_activities` — близнец соседней для §3.6, плюс колонка `partner_hash` (хэш слотов партнёра — единственное изменение, по которому обновление карточки звенит). PK `(match_id, user_id)`; `user_id` — `ON DELETE CASCADE`, `match_id` без внешнего ключа. **Чисто аддитивная** | DDL повторяет `20260922180000_venue_change_activity` с одной лишней колонкой; `prisma generate` на ветке собирает клиент с моделью, типовая проверка бота зелёная. Написана 2026-09-23 как `20260923090000_…`, нигде не применялась; при посадке на ствол 2026-09-26 переименована, чтобы встать последней. При посадке 2026-09-26: весь набор миграций (без `vector`/`pg_stat_statements`/`supabase_vault` и колонки `embedding` в копии) накатан на одноразовую базу в локальном Postgres 16 как теневая, `migrate diff --from-migrations … --to-schema-datamodel …` → `-- This is an empty migration.` (на стволе до посадки — так же пусто) |
| `20260930120000_chat_sessions` | Отдельные чаты агента приложения (решение основателя 2026-09-30, отмена «одного потока» 2026-09-04): таблица `chat_sessions` (заголовок модели/ручной, английское саммари + `summary_embedding vector(1536)`, счётчики для CAS; `user_id` — `ON DELETE CASCADE`, индекс `(user_id, updated_at)`) и `messages.session_id` (nullable, FK `ON DELETE CASCADE`, индекс `(session_id, created_at)`). DDL **чисто аддитивный**; плюс **бэкфилл данных** в той же транзакции (своё `BEGIN`/`COMMIT`): сообщения каждого человека (все роли, порядок `(created_at, id)`) нарезаются на чаты по паузе >6 ч, по чату на кусок (`created_at` = первое, `updated_at` = последнее сообщение, заголовка нет — его допишет воркер `chat-session-digest`), и каждому сообщению ставится `session_id`. **Миграция ДО рестарта кода**: новый код выбирает `messages.session_id` в каждом чтении без `select` (`/v1/chat/history`) и пишет в `chat_sessions` — без миграции чат приложения падает с P2021/P2022 | DDL совпадает дословно с `migrate diff --from-schema-datamodel <c1644d50> --to-schema-datamodel <ветка> --script`. Одноразовая база в Postgres 17 (embedded, без pgvector: из КОПИЙ вырезаны `extensions = [vector]`, колонки `embedding`/`summary_embedding` и строка `vector(1536)` миграции) из схемы ствола + сид (два человека с общей меткой времени, паузы 5 ч 59 мин / 6 ч 01 мин / ровно 6 ч, два сообщения с одинаковым `created_at`, `system`-строка, человек без сообщений) → `migration.sql` → 4 / 2 / 0 чатов, ни одного сообщения без чата, границы чатов = min/max его сообщений, ровно 6 ч — тот же чат; `migrate diff --from-url` → `-- This is an empty migration.` SQL с `vector` (поиск `<=>`, UPDATE саммари с CAS и охраной ручного заголовка, `= ANY(uuid[])`) проверен отдельно на PGlite + pgvector |
| `20261007120000_profiler_quick_answers` | Быстрые ответы и «На потом» вопросов о себе в приложении (решение 2026-10-07): enum `profiler_answer_source` (`tap`/`text`/`both`) и три колонки `profiler_answers` — `option_ids TEXT[] DEFAULT {}` (что нажато), `answer_source` (nullable), `postponed_at` (nullable). **Чисто аддитивная**, константный дефолт — без переписывания строк; старый код колонки не читает, поэтому `db:deploy` до рестарта. `option_ids` без `NOT NULL`, как все списки Prisma: первая редакция (`b94253e0`) объявляла `NOT NULL`, и `db:drift-check` после неё дал бы `DROP NOT NULL` → DRIFT и стоп выката; исправлено 2026-10-07 до применения где-либо | DDL совпадает дословно с `migrate diff --from-schema-datamodel <b94253e0~1> --to-schema-datamodel <b94253e0> --script`. PGlite (Postgres 17 в процессе, без pgvector — из КОПИЙ схем вырезаны `extensions = [vector]` и колонки `vector`): DDL старой схемы с нуля → `migration.sql` против DDL новой схемы с нуля — 812 колонок и enum-ов совпали; контроль: первая редакция с `NOT NULL` даёт ровно одно расхождение `option_ids is_nullable NO/YES` |
| `20261008120000_profile_music_providers` | Музыка в профиле, два провайдера (решение 2026-10-08: Apple Music главный, Spotify — поиск): в `profile_music_tracks` колонки `provider` (`TEXT NOT NULL DEFAULT 'spotify'`), `track_id`, `track_url` (`NOT NULL` после бэкфилла из `spotify_track_id` / `spotify_url`), `storefront`, `isrc` (nullable); `spotify_track_id` / `spotify_url` — `DROP NOT NULL` (больше не читаются, дропнуть позже); уникальный `(user_id, provider, track_id)`. **Аддитивная**, плюс бэкфилл в самой миграции (в проде таблица пуста — флаг не включался). **Миграция ДО рестарта кода**: новый код выбирает `provider`/`track_id`/`track_url` | DDL совпадает с `migrate diff --from-schema-datamodel <6b0a891a> --to-schema-datamodel <ветка> --script`, кроме разбиения на nullable → бэкфилл → `SET NOT NULL`. PGlite (Postgres 17, без pgvector — из КОПИЙ схем вырезаны `extensions = [vector]` и колонки `vector`): DDL старой схемы + строка Spotify → `migration.sql` → строка получила `provider = spotify`, `track_id`, `track_url`; строка Apple без колонок Spotify принимается, повтор `(user, provider, track)` отклонён; против DDL новой схемы с нуля — 978 колонок и индексов совпали |

Разбиение по авторству намеренное. Слить всё в одну миграцию было бы проще, но
тогда ветка аудита стала бы той, что выкатывает чужую невыкаченную работу, — а
это ровно тот вид неявного владения, из-за которого потом никто не может
сказать, что и когда поехало.

## Как это принять (одноразово, на проде)

**Уже принято: 2026-09-08 02:18 UTC.** Таблица `_prisma_migrations` в проде (снята
бэкапом 2026-09-21) показывает `0_baseline` помеченным применённым и три следующие
миграции (`trunk_catchup`, `audit_indexes_and_bot_blocked`, `proxy_chat_delivery`)
накатанными без ошибок. Шаги ниже — история: повторный `resolve --applied 0_baseline`
упадёт с P3008. Деплой — только `db:deploy`.

Ни один шаг ниже эта ветка не выполняла: они трогают продовую базу.

1. **Проверить набор на теневой базе** — обязательный первый шаг:
   ```sh
   cd packages/db
   npx prisma migrate diff --from-migrations ./prisma/migrations \
     --to-schema-datamodel prisma/schema.prisma \
     --shadow-database-url "postgresql://…/shadow" --exit-code
   ```
   Пустой вывод и код 0 означают, что набор воспроизводит `schema.prisma`.
   Теневой базе нужны те же расширения, что и проду, — в первую очередь
   `vector`. **Здесь этот шаг не выполнялся:** единственный локальный Postgres
   на машине сборки без `pgvector`, а его установка потребовала бы смены прав
   на системные каталоги.

2. **Объявить baseline применённым** — база уже в этом состоянии, применять
   его повторно нельзя:
   ```sh
   npx prisma migrate resolve --applied 0_baseline
   ```

3. **Накатить остальное:**
   ```sh
   pnpm --filter @gennety/db db:deploy
   ```

4. С этого момента деплой идёт через `db:deploy`, а не `db:push`. Раннбук —
   [docs/operations/deployment-runbook.md](../../../../docs/operations/deployment-runbook.md).

## Чего это не чинит

`pg_dump` на дроплете по-прежнему нет (раннбук признаёт это прямо). Миграции
дают воспроизводимый ПОРЯДОК изменений, но не резервную копию: снимок перед
рискованным изменением всё ещё берётся вручную из панели Supabase.

## Проверка против живой базы — 2026-09-07

Прогон на shadow-БД здесь не только упирается в отсутствие `pgvector` локально, но и
отвечает не на тот вопрос: `0_baseline` снят с Supabase (схема `extensions`, `vector`
0.8.2) и на проде НЕ проигрывается — он помечается применённым через
`migrate resolve --applied`, а исполняются только догоняющие шаги.

Поэтому проверено то, что действительно исполнится. `prisma migrate diff` от ЖИВОЙ
базы к `schema.prisma` этой ветки (только чтение, пароль не попадает в командную
строку — `--from-schema-datasource`, не `--from-url`) выдаёт 20 инструкций. Они
статемент в статемент совпадают с объединением
`20260907120000_trunk_catchup` и `20260907120100_audit_indexes_and_bot_blocked`:
ни одной лишней, ни одной недостающей.

Отдельно `pnpm db:drift-check` на проде отвечает `OK` — живая база совпадает с
развёрнутой схемой, то есть baseline действительно является её слепком.

Изменения только добавляющие: `CREATE TYPE` / `CREATE TABLE` / `CREATE INDEX` и
`ADD COLUMN` с nullable-типом. Ни удалений, ни смен типа — старый код переживает эту
схему, поэтому порядок «схема раньше кода» безопасен.
