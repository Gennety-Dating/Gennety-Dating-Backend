#!/usr/bin/env node
/**
 * Starts the local bot with `.env.local` applied before Node evaluates the
 * application import graph. This matters for Prisma: its singleton is created
 * while modules load, earlier than config.ts can call dotenv.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function loadEnv(path, override) {
  if (!existsSync(path)) return;
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
}

loadEnv(resolve(root, ".env.local"), true);
loadEnv(resolve(root, ".env"), false);

/**
 * Refuse to start a second dev bot. Two instances long-poll the same
 * BOT_TOKEN and fight over Telegram updates (409 Conflict), and whichever
 * leftover process already owns PUBLIC_PORT keeps serving the Mini App API
 * with its now-stale in-memory Prisma client — i.e. silent 500s on
 * /v1/matches/:id/ticket/state and friends after a schema/`db:generate`
 * change. Fail fast with a clear message instead of producing that mess.
 */
function isPortFree(port) {
  return new Promise((res) => {
    const tester = createServer()
      .once("error", (err) => res(err.code !== "EADDRINUSE"))
      .once("listening", () => tester.close(() => res(true)))
      .listen(port, "127.0.0.1");
  });
}

const publicPort = Number(process.env.PUBLIC_PORT ?? "3101");
if (!(await isPortFree(publicPort))) {
  console.error(
    `\n✖ Port ${publicPort} is already in use — a dev bot is already running.\n` +
      `  Starting a second one makes both bots fight over Telegram updates (409 Conflict)\n` +
      `  and the stale instance keeps answering the Mini App API with an outdated Prisma\n` +
      `  client (silent 500s). Stop the running one first:\n\n` +
      `    pkill -f dev-bot.mjs ; pkill -f 'tsx watch src/index.ts'\n`,
  );
  process.exit(1);
}

const child = spawn("pnpm", ["--filter", "@gennety/bot", "dev"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? "development",
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error("Failed to start the dev bot:", error);
  process.exit(1);
});
