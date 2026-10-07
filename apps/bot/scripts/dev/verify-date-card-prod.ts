/**
 * verify-date-card-prod — renders the date card through the PRODUCTION
 * composition (`services/date-card/compose.ts`: the same fonts, brand marks,
 * grain and credit placement `renderDateCard` uses) so the design can be
 * eyeballed without a match. Optionally sends it to a Telegram chat. Does not
 * touch the DB or the live render path.
 *
 *   pnpm tsx apps/bot/scripts/dev/verify-date-card-prod.ts \
 *     [--lang=ru] [--theme=dark|light] [--partner=a.jpg] [--venue=b.jpg] \
 *     [--slogan="Her pick.\nYour move."] [--dump=/tmp] [--chat=<id>|skip]
 *
 * Without --partner / --venue it pulls two stock photos from picsum.
 */
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { Api, InputFile } from "grammy";
import { t, type Language } from "@gennety/shared";
import { duotonePng, toPngBuffer } from "../../src/services/date-card/image.js";
import { HERO_W, HERO_H, type CardTheme } from "../../src/services/date-card/template.js";
import { composeDateCard } from "../../src/services/date-card/compose.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");
if (existsSync(resolve(repoRoot, ".env.local"))) loadEnv({ path: resolve(repoRoot, ".env.local") });
loadEnv({ path: resolve(repoRoot, ".env") });

function arg(name: string): string | undefined {
  for (const raw of process.argv.slice(2)) if (raw.startsWith(`--${name}=`)) return raw.slice(name.length + 3);
  return undefined;
}
async function fetchBuf(url: string): Promise<Buffer | null> {
  try {
    const r = await fetch(url);
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}
async function photo(flag: string, fallbackUrl: string): Promise<Buffer | null> {
  const path = arg(flag);
  return path ? readFileSync(resolve(path)) : fetchBuf(fallbackUrl);
}

async function main(): Promise<void> {
  const lang = (arg("lang") ?? "ru") as Language;
  const theme = (arg("theme") ?? "dark") as CardTheme;
  const [partnerRaw, venueRaw] = await Promise.all([
    photo("partner", "https://picsum.photos/id/64/640/760"),
    photo("venue", "https://picsum.photos/id/431/1000/720"),
  ]);

  const png = await composeDateCard({
    partnerName: "Алекс",
    partnerPhoto: partnerRaw ? await toPngBuffer(partnerRaw) : null,
    venuePhoto: venueRaw ? await duotonePng(venueRaw, "#1C0710", "#F7E7EB", HERO_W, HERO_H, 0.7) : null,
    venueName: "Koffer Coffee",
    venueAddress: "вул. Хрещатик 14, Київ",
    slogan: arg("slogan")?.replaceAll("\\n", "\n") ?? t(lang, "dateCardSlogan"),
    theme,
  });

  const dump = arg("dump");
  if (dump) writeFileSync(resolve(dump, `date-card-${lang}-${theme}.png`), png);

  const chat = Number(arg("chat") ?? (process.env["DEV_OTP_BYPASS_TELEGRAM_IDS"] ?? "").split(",")[0]?.trim());
  const token = process.env["BOT_TOKEN"];
  if (arg("chat") !== "skip" && token && Number.isFinite(chat) && chat) {
    await new Api(token).sendPhoto(chat, new InputFile(png, "date-card.png"), {
      caption: `Карточка свидания — прод-рендер из кода (${lang}, ${theme}).`,
    });
    console.log(`[verify] sent prod render to chat=${chat}`);
  }
  console.log("[verify] done");
  process.exit(0);
}

main().catch((e) => {
  console.error("[verify] failed:", e);
  process.exit(1);
});
