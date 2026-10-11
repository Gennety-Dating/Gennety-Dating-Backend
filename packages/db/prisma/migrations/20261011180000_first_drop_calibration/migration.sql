-- First-drop calibration window (founder decision 2026-10-11). Purely additive:
-- nullable, no default, no row rewritten. Null = no window.
ALTER TABLE "profiles" ADD COLUMN "calibration_until" TIMESTAMP(3);
