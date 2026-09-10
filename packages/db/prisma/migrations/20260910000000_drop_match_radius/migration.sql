-- Снос `profiles.match_radius` и типа `MatchRadius`.
--
-- ЭТО РАЗРУШАЮЩАЯ МИГРАЦИЯ. Порядок выката ОБРАТНЫЙ обычному:
-- сначала код, потом эта миграция. Код до этого релиза выбирает
-- `match_radius` в `serializeProfile` и в админской аудитории; если
-- уронить колонку раньше выката кода, оба маршрута начнут падать.
--
-- Данные не теряются в осмысленном смысле: колонку писала ровно одна
-- ручка (`PATCH /v1/me/preferences`), которую не вызывал ни один клиент
-- — ни iOS, ни вебап, ни Telegram. Значит в каждой строке лежит
-- `@default('campus_only')`, то есть значение, которое никто не выбирал.
--
-- Откат: значение восстанавливается дефолтом, выбора пользователя
-- в нём никогда не было.
--   CREATE TYPE "public"."MatchRadius" AS ENUM ('campus_only', 'citywide');
--   ALTER TABLE "profiles" ADD COLUMN "match_radius" "public"."MatchRadius"
--     NOT NULL DEFAULT 'campus_only';

-- AlterTable
ALTER TABLE "profiles" DROP COLUMN "match_radius";

-- DropEnum
DROP TYPE "public"."MatchRadius";
