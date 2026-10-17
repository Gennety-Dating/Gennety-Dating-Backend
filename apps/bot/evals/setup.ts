import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Env for the live evals: the real OpenAI key and feature flags come from the
 * repo's `.env` (or `EVAL_ENV_FILE`), so the agent sees the product as
 * production configures it. The database is never touched — every eval mocks
 * `@gennety/db` — but `config.ts` insists on the usual variables, so harmless
 * defaults fill what the file lacks.
 */
const envFile = process.env.EVAL_ENV_FILE ?? resolve(__dirname, "../../../.env");
if (existsSync(envFile)) config({ path: envFile });

process.env.BOT_TOKEN ??= "eval:token";
process.env.DATABASE_URL ??= "postgresql://eval:eval@localhost:5432/eval";
process.env.SMTP_HOST ??= "localhost";
process.env.SMTP_PORT ??= "587";
process.env.SMTP_USER ??= "eval";
process.env.SMTP_PASS ??= "eval";
process.env.SMTP_FROM ??= "eval@eval.invalid";
process.env.ADMIN_API_KEY ??= "eval-admin-key";
process.env.ADMIN_PORT ??= "3100";
process.env.ADMIN_DASHBOARD_ORIGIN ??= "*";
process.env.WEBAPP_URL ??= "https://eval.invalid/calendar";

if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.startsWith("sk-test")) {
  throw new Error(
    `Live evals need a real OPENAI_API_KEY — none in ${envFile}. Set EVAL_ENV_FILE to the .env that has it.`,
  );
}
