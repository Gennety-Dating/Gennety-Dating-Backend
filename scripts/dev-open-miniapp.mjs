// Dev QA helper: DM a test account two web_app buttons (dark + light) that open
// a Mini App path on the tunnel, so both themes can be reviewed in one tap each.
//
//   node scripts/dev-open-miniapp.mjs <telegramId> "<Title>" "<path?query>"
//   e.g. node scripts/dev-open-miniapp.mjs 782065541 "Feedback" "feedback.html?match=demo&lang=ru"
//
// Reads BOT_TOKEN + WEBAPP_URL from .env.local (then .env). Run from repo root.
import { readFileSync, existsSync } from "node:fs";

const ROOT = process.cwd();
for (const f of [`${ROOT}/.env.local`, `${ROOT}/.env`]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const [, , chatId, title = "Mini App", path = ""] = process.argv;
const token = process.env.BOT_TOKEN;
const base = (process.env.WEBAPP_URL || "").replace(/\/$/, "");
if (!token || !base || !chatId) {
  console.error("Usage: node scripts/dev-open-miniapp.mjs <telegramId> <title> <path?query>");
  console.error("Needs BOT_TOKEN + WEBAPP_URL in env.");
  process.exit(1);
}

const sep = path.includes("?") ? "&" : "?";
const url = (theme) => `${base}/${path}${sep}theme=${theme}`;
const reply_markup = {
  inline_keyboard: [
    [{ text: "🌚 Тёмная тема", web_app: { url: url("dark") } }],
    [{ text: "🌝 Светлая тема", web_app: { url: url("light") } }],
  ],
};

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    text: `🎨 ${title}\nОткрой в обеих темах:`,
    reply_markup,
  }),
});
const j = await res.json();
if (res.ok && j.ok) {
  console.log(`sent "${title}" -> ${chatId}`);
  console.log(`  dark:  ${url("dark")}`);
  console.log(`  light: ${url("light")}`);
} else {
  console.error(`FAILED: ${JSON.stringify(j)}`);
  process.exit(1);
}
