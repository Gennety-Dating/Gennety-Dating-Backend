#!/usr/bin/env node
/**
 * Run the DEMO bot locally (DEMO_MODE.md).
 *
 * Mirrors `dev-bot.mjs`, with one difference that is the whole point: it loads
 * `.env.demo` with override priority, so the demo's bot token, database and
 * ports win over both `.env.local` and `.env`. Env has to be applied before
 * Node evaluates the import graph — Prisma's singleton is constructed while
 * modules load, earlier than config.ts can call dotenv.
 *
 * `.env` is still loaded last as a fallback, so shared stateless credentials
 * (OpenAI, AWS, Places, the Supabase project URL/key) do not have to be
 * duplicated into `.env.demo`. Anything the demo must NOT inherit — the bot
 * token, the database, the ports, the storage buckets, the founder feed — is
 * listed explicitly in `.env.demo`, and `assertDemoIsolation()` refuses to boot
 * if a production-shaped setting slipped through.
 *
 * `.env.local` is deliberately NOT loaded: it points at the dev bot and dev
 * database, and silently mixing the two would be exactly the confusion this
 * separation exists to prevent.
 *
 * Usage:
 *   pnpm demo:dev
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function loadEnv(path, override) {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim().replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

if (!loadEnv(resolve(root, ".env.demo"), true)) {
  console.error(
    "\n✖ .env.demo not found.\n" +
      "  The demo bot needs its own token, database and ports — see DEMO_MODE.md → Setup.\n",
  );
  process.exit(1);
}
loadEnv(resolve(root, ".env"), false);

if (process.env.DEMO_MODE_ENABLED !== "true") {
  console.error(
    "\n✖ .env.demo does not set DEMO_MODE_ENABLED=true.\n" +
      "  Without it this would start an ordinary bot against the demo token.\n",
  );
  process.exit(1);
}

/**
 * Same guard as the dev launcher: two processes long-polling one token fight
 * over updates (409 Conflict), and the stale one keeps answering the Mini App
 * API with an outdated Prisma client.
 */
function isPortFree(port) {
  return new Promise((res) => {
    const tester = createServer()
      .once("error", (err) => res(err.code !== "EADDRINUSE"))
      .once("listening", () => tester.close(() => res(true)))
      .listen(port, "127.0.0.1");
  });
}

const publicPort = Number(process.env.PUBLIC_PORT ?? "3102");
if (!(await isPortFree(publicPort))) {
  console.error(
    `\n✖ Port ${publicPort} is already in use — a demo bot is probably already running.\n` +
      `  Stop it first:\n\n    pkill -f demo-bot.mjs\n`,
  );
  process.exit(1);
}

const child = spawn("pnpm", ["--filter", "@gennety/bot", "dev"], {
  cwd: root,
  env: {
    ...process.env,
    // NOT "development": that runtime, combined with OTP_LOG_TO_CONSOLE, is the
    // dev exemption in `identityTrustConfigurationErrors`. The demo has its own
    // exemption (DEMO_MODE_ENABLED) which is gated by assertDemoIsolation, and
    // conflating the two would let a dev-shaped config skip that guard.
    NODE_ENV: process.env.NODE_ENV ?? "demo",
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error("Failed to start the demo bot:", error);
  process.exit(1);
});
