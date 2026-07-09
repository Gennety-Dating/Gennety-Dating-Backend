/**
 * verify-date-card-prod — renders the date card through the PRODUCTION modules
 * (services/date-card/template.ts + image.ts duotone/grain + shared i18n slogan)
 * so we can eyeball that the port matches the approved design. Optionally sends
 * to a Telegram chat. Does not touch the DB or the live render path.
 *
 *   pnpm tsx apps/bot/scripts/dev/verify-date-card-prod.ts [--chat=<id>] [--lang=ru] [--dump=/tmp]
 */
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Api, InputFile } from "grammy";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { t, type Language } from "@gennety/shared";
import { duotonePng, grainPng, toPngBuffer } from "../../src/services/date-card/image.js";
import { butterflyPng } from "../../src/services/match-card/collage.js";
import { buildCardElement, CARD_W, CARD_H } from "../../src/services/date-card/template.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");
if (existsSync(resolve(repoRoot, ".env.local"))) loadEnv({ path: resolve(repoRoot, ".env.local") });
loadEnv({ path: resolve(repoRoot, ".env") });

function arg(name: string): string | undefined {
  for (const raw of process.argv.slice(2)) if (raw.startsWith(`--${name}=`)) return raw.slice(name.length + 3);
  return undefined;
}
function fontFile(file: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../../src/assets/fonts/${file}`, import.meta.url)));
}
async function fetchBuf(url: string): Promise<Buffer | null> {
  try {
    const r = await fetch(url);
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const lang = (arg("lang") ?? "ru") as Language;
  const [partnerRaw, venueRaw] = await Promise.all([
    fetchBuf("https://picsum.photos/id/64/640/760"),
    fetchBuf("https://picsum.photos/id/431/1000/720"),
  ]);
  const partnerPhoto = partnerRaw ? await toPngBuffer(partnerRaw) : null;
  const venuePhoto = venueRaw ? await duotonePng(venueRaw, "#1C0710", "#F7E7EB", 1000, 690, 0.7) : null;

  const logo = await butterflyPng(600);

  const archivo = fontFile("ArchivoBlack-Regular.ttf");
  const element = buildCardElement({
    partnerName: "Алекс",
    partnerPhoto,
    venuePhoto,
    grain: grainPng(CARD_W, CARD_H, 9),
    logo,
    venueName: "Koffer Coffee",
    venueAddress: "вул. Хрещатик 14, Київ",
    slogan: t(lang, "dateCardSlogan"),
  });

  const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
    width: CARD_W,
    height: CARD_H,
    fonts: [
      { name: "Roboto", data: fontFile("Roboto-Regular.ttf"), weight: 400, style: "normal" },
      { name: "Roboto", data: fontFile("Roboto-Medium.ttf"), weight: 500, style: "normal" },
      { name: "Roboto", data: fontFile("Roboto-Bold.ttf"), weight: 700, style: "normal" },
      { name: "Archivo Black", data: archivo, weight: 400, style: "normal" },
      { name: "Archivo Black", data: archivo, weight: 700, style: "normal" },
    ],
  });
  const png = Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: CARD_W } }).render().asPng());

  const dump = arg("dump");
  if (dump) writeFileSync(resolve(dump, "prod-card.png"), png);

  const chat = Number(arg("chat") ?? (process.env["DEV_OTP_BYPASS_TELEGRAM_IDS"] ?? "").split(",")[0]?.trim());
  const token = process.env["BOT_TOKEN"];
  if (arg("chat") !== "skip" && token && Number.isFinite(chat) && chat) {
    await new Api(token).sendPhoto(chat, new InputFile(png, "prod-card.png"), {
      caption: "✅ Карточка свидания — новая палитра (бордовый #8B253B + логотип-бабочка). Прод-рендер из кода.",
    });
    console.log(`[verify] sent prod render to chat=${chat}`);
  }
  console.log("[verify] done");
}

main().catch((e) => {
  console.error("[verify] failed:", e);
  process.exit(1);
});
