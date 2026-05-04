/**
 * Global test setup for @gennety/bot unit tests.
 *
 * Loaded by vitest.config.ts `setupFiles` BEFORE every test file.
 * Sets harmless env defaults so `config.ts` never throws and
 * `@gennety/db` never touches a real database.
 *
 * Individual tests can still `vi.mock("@gennety/db", ...)` to override
 * — Vitest hoists `vi.mock` calls above imports, so per-file mocks win.
 */

// ---------------------------------------------------------------------------
// 1. Env defaults — prevents `required()` from throwing in config.ts
// ---------------------------------------------------------------------------

process.env.BOT_TOKEN ??= "test:unit-token";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.SMTP_HOST ??= "localhost";
process.env.SMTP_PORT ??= "587";
process.env.SMTP_USER ??= "test";
process.env.SMTP_PASS ??= "test";
process.env.SMTP_FROM ??= "test@test.invalid";
process.env.OPENAI_API_KEY ??= "sk-test";
process.env.ADMIN_API_KEY ??= "test-admin-key";
process.env.ADMIN_PORT ??= "3100";
process.env.ADMIN_DASHBOARD_ORIGIN ??= "*";
process.env.WEBAPP_URL ??= "https://test.invalid/calendar";

// Clear secrets that, if present in `.env`, would leak into tests and either
// hit live services or change branching behaviour. Tests that need these
// should set them explicitly via `vi.mock("../config.js", ...)`.
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_REGION;
