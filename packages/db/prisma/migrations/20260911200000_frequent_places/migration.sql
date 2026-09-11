-- Frequently visited places (docs/product/domains/frequent-places.md).
-- Purely additive: one column, two tables, no existing row rewritten.
-- `frequent_places_opt_in` defaults to TRUE by founder decision 2026-09-11
-- (decision journal) — every existing account is opted in and can switch off.
-- Written by hand; DDL checked against
-- `prisma migrate diff --from-schema-datamodel <trunk> --to-schema-datamodel <branch> --script`.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "frequent_places_opt_in" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "user_place_visits" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "place_id" TEXT NOT NULL,
    "visit_day" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_place_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_hidden_places" (
    "user_id" UUID NOT NULL,
    "place_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_hidden_places_pkey" PRIMARY KEY ("user_id","place_id")
);

-- CreateIndex
CREATE INDEX "user_place_visits_visit_day_idx" ON "user_place_visits"("visit_day");

-- CreateIndex
CREATE UNIQUE INDEX "user_place_visits_user_id_place_id_visit_day_key" ON "user_place_visits"("user_id", "place_id", "visit_day");

-- AddForeignKey
ALTER TABLE "user_place_visits" ADD CONSTRAINT "user_place_visits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_hidden_places" ADD CONSTRAINT "user_hidden_places_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
