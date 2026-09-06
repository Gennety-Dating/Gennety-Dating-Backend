<!-- WHEN_TO_READ: HISTORICAL POINTER ONLY. Its content was merged into docs/operations/hermes-agent-prompt.md. Kept because the 2026-08-15 decision entry links to it. -->
<!-- SOURCE: HERMES_MATCH_CONVERSION_ADDENDUM.md (moved unchanged) — migrated 2026-09-01 -->

# Hermes — дополнение про Match → Ticket (слито в основной промпт)

> **Этот файл больше не источник правды.** Всё, что в нём было —
> `conversion` в `/admin/stats`, `derived` в `/admin/dashboard`, `genderRatio`,
> выведенные поля матча, явка, правило про расходы на трафик и две поправки
> (`telegramId < 0` ≠ тестовый аккаунт; платёжные эндпоинты существуют) —
> перенесено в **[HERMES_AGENT_PROMPT.md](../operations/hermes-agent-prompt.md)**.

Файл оставлен указателем, а не удалён: на него ссылается запись от 2026-08-15 в
[DECISIONS.md](../architecture/decisions/INDEX.md), и битая ссылка в журнале решений хуже, чем лишний
файл в три строки.

**Почему слито.** Он был написан как дельта, чтобы не переписывать канонический
промпт посреди задачи, с оговоркой «два описания одного эндпоинта разъезжаются».
Разъехались — но не эти два файла, а канонический промпт и сам продукт:
сверка 2026-08-15 нашла в нём десять протухших утверждений (каденс матчинга,
статус гейта верификации, минимум фото, шаг `ethnicity`, провайдер liveness,
`sources.timeline`) и восемь эндпоинтов, о которых Hermes не знал вовсе.
Один файл — одно описание; разъезжаться нечему.
