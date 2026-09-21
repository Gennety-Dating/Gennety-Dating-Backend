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
