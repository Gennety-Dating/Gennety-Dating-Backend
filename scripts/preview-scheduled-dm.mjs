#!/usr/bin/env node
// One-shot preview: send the scheduled-match confirmation DM (with the
// `date_time` MessageEntity) to a Telegram chat via the dev bot. Lets us
// eyeball-test the 📅 affordance on a real iOS/Android Telegram client
// without driving the full match → calendar → venue flow.
//
// Usage:
//   node --env-file=.env.local scripts/preview-scheduled-dm.mjs [chatId] [language]
//
// Defaults: chatId = first DEV_OTP_BYPASS_TELEGRAM_IDS, language = ru.
// Prereq:   you've tapped /start in @gennetytestbot at least once.
//
// Inlines buildDateTimeEntity and uses fetch directly so the script has
// zero npm dependencies and runs from any cwd.

const RENDER_TZ = "Europe/Kyiv";
const CALENDAR_AFFORDANCE = "📅 ";
const LOCALE_TAGS = { en: "en-GB", ru: "ru-RU", uk: "uk-UA", de: "de-DE", pl: "pl-PL" };

function renderDate(when, language) {
  return new Intl.DateTimeFormat(LOCALE_TAGS[language], {
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: RENDER_TZ,
  }).format(when);
}

function buildDateTimeEntity(baseText, when, language) {
  const separator = "\n\n";
  const placeholder = `${CALENDAR_AFFORDANCE}${renderDate(when, language)}`;
  const prefix = `${baseText}${separator}`;
  return {
    text: `${prefix}${placeholder}`,
    entity: {
      type: "date_time",
      offset: prefix.length,
      length: placeholder.length,
      unix_time: Math.floor(when.getTime() / 1000),
    },
  };
}

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN not set. Run with: node --env-file=.env.local scripts/preview-scheduled-dm.mjs");
  process.exit(1);
}

const argChatId = process.argv[2];
const argLang = process.argv[3];
const language = (argLang || "ru").toLowerCase();
if (!["en", "ru", "uk", "de", "pl"].includes(language)) {
  console.error(`Unsupported language "${language}" (expected en|ru|uk|de|pl)`);
  process.exit(1);
}

let chatId = argChatId;
if (!chatId) {
  const bypass = (process.env.DEV_OTP_BYPASS_TELEGRAM_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  chatId = bypass[0];
  if (!chatId) {
    console.error("No chatId arg and DEV_OTP_BYPASS_TELEGRAM_IDS empty");
    process.exit(1);
  }
}

const COPY = {
  en: "Locked in! Coupa Café — 123 Khreshchatyk\nhttps://maps.google.com/?cid=12345 — see you there 🤝",
  ru: "Готово! Coupa Café — Крещатик, 123\nhttps://maps.google.com/?cid=12345 — до встречи 🤝",
  uk: "Готово! Coupa Café — Хрещатик, 123\nhttps://maps.google.com/?cid=12345 — до зустрічі 🤝",
  de: "Fix! Coupa Café — 123 Khreshchatyk\nhttps://maps.google.com/?cid=12345 — bis dann 🤝",
  pl: "Ustalone! Coupa Café — Chreszczatyk 123\nhttps://maps.google.com/?cid=12345 — do zobaczenia 🤝",
};

// Next Saturday at 19:00 Europe/Kyiv (UTC+3 in May = 16:00Z).
function nextSaturday1900Kyiv() {
  const now = new Date();
  const offsetDays = (6 - now.getUTCDay() + 7) % 7 || 7;
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + offsetDays,
      16,
      0,
      0,
    ),
  );
}

const when = nextSaturday1900Kyiv();
const { text, entity } = buildDateTimeEntity(COPY[language], when, language);

const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
const me = await meRes.json();
if (!me.ok) {
  console.error("getMe failed:", me);
  process.exit(1);
}
console.log(`[preview] sending via @${me.result.username} to chat ${chatId} (${language})`);
console.log(`[preview] agreedTime: ${when.toISOString()}`);
console.log(`[preview] entity offset=${entity.offset} length=${entity.length} unix_time=${entity.unix_time}`);

const sendRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: Number(chatId),
    text,
    entities: [entity],
  }),
});
const sent = await sendRes.json();
if (!sent.ok) {
  console.error("[preview] sendMessage failed:", sent);
  process.exit(1);
}
console.log(`[preview] ok — message_id=${sent.result.message_id}`);
