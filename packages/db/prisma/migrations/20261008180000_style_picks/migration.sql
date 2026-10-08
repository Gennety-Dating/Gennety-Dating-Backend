-- Vibe Check — the Shop's style picks (decision journal 2026-10-08): the
-- product catalog the dedicated agent chooses from, the cached pick set per
-- person, and the outbound-click log.
--
-- Purely additive: three new tables, no existing column touched. Old code never
-- reads them, so `db:deploy` may run before or after the restart; the catalog is
-- filled afterwards by `pnpm seed-style:import --apply`.
-- DDL is `prisma migrate diff --from-schema-datamodel <2f67d0df> --to-schema-datamodel <branch> --script` verbatim.

-- CreateTable
CREATE TABLE "style_products" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "price_tier" INTEGER NOT NULL,
    "price_eur" DOUBLE PRECISION NOT NULL,
    "notes" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "url" TEXT NOT NULL,
    "url_ua" TEXT,
    "image_url" TEXT,
    "sponsored" BOOLEAN NOT NULL DEFAULT false,
    "affiliate_params" JSONB,
    "badges" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "style_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "style_pick_sets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "language" TEXT NOT NULL,
    "profile_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "style_pick_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "style_clicks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "style_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "style_products_active_category_idx" ON "style_products"("active", "category");

-- CreateIndex
CREATE INDEX "style_pick_sets_user_id_generated_at_idx" ON "style_pick_sets"("user_id", "generated_at");

-- CreateIndex
CREATE INDEX "style_clicks_item_id_created_at_idx" ON "style_clicks"("item_id", "created_at");

-- CreateIndex
CREATE INDEX "style_clicks_user_id_created_at_idx" ON "style_clicks"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "style_pick_sets" ADD CONSTRAINT "style_pick_sets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_clicks" ADD CONSTRAINT "style_clicks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
