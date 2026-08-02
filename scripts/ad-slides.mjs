#!/usr/bin/env node
/**
 * Ad slide renderer — the paid-acquisition creative set (Kyiv launch).
 *
 * Renders the ad carousel as PNGs with the SAME satori → resvg stack the
 * product's own cards use (date / match / referral / expiry), so the creative
 * is pixel-identical to the brand rather than a lookalike rebuilt in Figma:
 * same burgundy gradient, same Unbounded/Archivo/Roboto files, same butterfly
 * mark, same cream ink.
 *
 * Audience: WOMEN. Every copy and casting decision below is made for a female
 * viewer — the hero photography is male, and the slide that carries the
 * product's real differentiator for women (§Phase 4 coordination + §3.7b venue
 * change, both of which put the woman in control) gets its own slide.
 *
 * Marketing asset, not product code: nothing here is imported by the bot, no
 * database, no network, no env. Pure read-files → rasterize → write-files.
 *
 * Usage:
 *   pnpm ads
 * Optional:
 *   --out=./tmp/ads       output directory (default: ./tmp/ad-slides)
 *   --format=story|feed|both   9:16 1080x1920 / 4:5 1080x1350 (default: both)
 *   --lang=uk|ru|both     copy set (default: uk)
 *   --only=1,4            render just these slide numbers
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const requireFromBot = createRequire(join(root, "apps/bot/package.json"));

// satori ships dual CJS/ESM, so the callable lands one or two `.default` deep
// depending on which build Node picks — unwrap rather than assume.
const satoriMod = await import(requireFromBot.resolve("satori"));
const satori = typeof satoriMod.default === "function" ? satoriMod.default : satoriMod.default.default;
const { Resvg } = await import(requireFromBot.resolve("@resvg/resvg-js"));
const { createCanvas, loadImage } = await import(requireFromBot.resolve("@napi-rs/canvas"));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const OUT_DIR = resolve(root, arg("out", "tmp/ad-slides"));
const FORMAT_ARG = arg("format", "both");
const LANG_ARG = arg("lang", "uk");
const ONLY = arg("only", "")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

// ---------------------------------------------------------------------------
// Brand system (finalized 2026-07-02; the referral card is the reference)
// ---------------------------------------------------------------------------

const BG_GRADIENT = "linear-gradient(158deg, #17090D 0%, #2A0E17 42%, #6E1B2E 100%)";
/** Flat ground resvg paints under the SVG, and what every scrim fades into. */
const BG_FLAT = "#17090D";
const CREAM = "#F7ECEC";
/** Headline second line / the "this is the point" colour. */
const PEACH = "#F0B7A0";
/** Small-caps kickers and rule lines. */
const GOLD = "#E7C7A6";
const WINE = "#8B253B";

const FORMATS = {
  // 9:16 — Stories / Reels / TikTok. The primary buy.
  story: { key: "story", w: 1080, h: 1920, pad: 92 },
  // 4:5 — the in-feed Instagram carousel.
  feed: { key: "feed", w: 1080, h: 1350, pad: 84 },
};

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

const fontFile = (f) => readFileSync(join(root, "apps/bot/src/assets/fonts", f));

/**
 * Headlines use the FULL Unbounded, never the latin/cyrillic subsets. satori
 * does not fall through per-glyph inside a family — it primary-matches the
 * first font registered for a name/weight/style — so a subset that misses a
 * glyph silently resolves it from Roboto mid-word with no error. Ukrainian
 * needs І Ї Є Ґ; the full file removes the hazard entirely (same call
 * ARCHITECTURE.md records for the expiry / time / match cards).
 */
const FONTS = [
  { name: "Roboto", data: fontFile("Roboto-Regular.ttf"), weight: 400, style: "normal" },
  { name: "Roboto", data: fontFile("Roboto-Medium.ttf"), weight: 500, style: "normal" },
  { name: "Roboto", data: fontFile("Roboto-Bold.ttf"), weight: 700, style: "normal" },
  { name: "Display", data: fontFile("unbounded-700.woff"), weight: 700, style: "normal" },
  { name: "Wordmark", data: fontFile("ArchivoBlack-Regular.ttf"), weight: 400, style: "normal" },
];

// ---------------------------------------------------------------------------
// satori node helpers (plain .mjs — no JSX). Every box carries an explicit
// display so satori never has to guess.
// ---------------------------------------------------------------------------

const box = (style, children) => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children },
});
const txt = (style, value) => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children: String(value) },
});
const img = (src, style) => ({
  type: "img",
  props: { src, style: { display: "flex", ...style } },
});
const col = (style, children) => box({ flexDirection: "column", ...style }, children);
const row = (style, children) => box({ flexDirection: "row", ...style }, children);
const spacer = (flex = 1) => box({ flex }, []);

// ---------------------------------------------------------------------------
// Imagery
// ---------------------------------------------------------------------------

const PORTRAIT_DIR = join(root, "apps/bot/src/assets/referral-portraits");

/**
 * The casting board. Keys are stable so a slide references a person, not a
 * filename — swapping a photo is a one-line change here.
 *
 * `focusY` is the vertical centre of the crop as a fraction of the source
 * height: these are full-length / mid-body shots, so a plain centre crop cuts
 * heads off. `zoom` tightens beyond cover-fit — needed both for framing and,
 * on `man_maker`, to keep a defect out of frame entirely.
 */
const CAST = {
  // MEN — the hero casting for a female audience.
  man_dinner: { file: "hf_20260722_012657_4c67b127-8db0-4706-8c53-5dd3122220d3.png", focusY: 0.42 },
  // Zoomed hard ON PURPOSE. The apron in the source carries garbled
  // AI-generated lettering ("Gcctucy"), and legible nonsense text is the
  // fastest way for a viewer to clock the creative as synthetic — which is a
  // problem on the slide whose entire claim is "nothing here is fake". The
  // crop keeps head and shoulders and drops the apron out of frame.
  man_maker: {
    file: "hf_20260722_014514_cd1b3c02-1539-45d8-a6b9-69501e96fbc5.png",
    focusY: 0.30,
    zoom: 1.75,
  },
  man_gym: { file: "hf_20260722_022025_9fb1df58-3980-473e-a590-130c3d2b5ba0.png", focusY: 0.24 },
  // WOMEN — the viewer's stand-in on the control slide.
  woman_dinner: { file: "hf_20260731_153301_91a6b446-898e-484c-9a3c-071c065e25f5.png", focusY: 0.26 },
  woman_table: { file: "hf_20260721_021900_0536ddb3-fe1d-4119-bafa-aefe6e5be5d8.png", focusY: 0.30 },
  // Production referral portraits (small, 620px tall) — filler tiles only.
  extra_1: { file: "1.jpg", focusY: 0.32 },
  extra_2: { file: "2.jpg", focusY: 0.32 },
  extra_3: { file: "3.jpg", focusY: 0.32 },
  extra_4: { file: "4.jpg", focusY: 0.32 },
  extra_5: { file: "5.jpg", focusY: 0.32 },
};

/**
 * Crop + downscale to a target aspect, returning a JPEG data URI.
 *
 * Downscaling is not cosmetic: the Higgsfield sources are 3–7 MB PNGs and the
 * bytes are base64-inlined into the SVG, so handing satori the originals makes
 * a ~40 MB document per slide. Cropping here (rather than leaning on
 * objectFit) is what lets `focusY` keep a face in frame.
 */
const photoCache = new Map();
async function photo(castKey, aspect, targetW = 900) {
  const cacheKey = `${castKey}:${aspect}:${targetW}`;
  if (photoCache.has(cacheKey)) return photoCache.get(cacheKey);

  const entry = CAST[castKey];
  if (!entry) throw new Error(`unknown cast key: ${castKey}`);
  const path = join(PORTRAIT_DIR, entry.file);
  if (!existsSync(path)) {
    console.warn(`[ads] missing photo ${entry.file} — slot renders empty`);
    photoCache.set(cacheKey, null);
    return null;
  }

  const src = await loadImage(readFileSync(path));
  const targetH = Math.round(targetW / aspect);

  // Cover-fit the source into the target box, anchored at focusY.
  const scale = Math.max(targetW / src.width, targetH / src.height) * (entry.zoom ?? 1);
  const drawW = src.width * scale;
  const drawH = src.height * scale;
  const dx = (targetW - drawW) / 2;
  const dy = Math.min(0, Math.max(targetH - drawH, -(drawH * entry.focusY - targetH / 2)));

  const canvas = createCanvas(targetW, targetH);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(src, dx, dy, drawW, drawH);
  const uri = `data:image/jpeg;base64,${canvas.toBuffer("image/jpeg", 82).toString("base64")}`;
  photoCache.set(cacheKey, uri);
  return uri;
}

/** Rasterize an inline SVG to a data URI (satori renders <img>, not raw SVG). */
function svgUri(svg, width) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
  return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

/** The brand butterfly, alpha-trimmed and tinted, at its true aspect ratio. */
let butterflyCache = null;
async function butterfly(tint = CREAM) {
  if (butterflyCache?.[tint]) return butterflyCache[tint];
  const svg = readFileSync(join(root, "apps/bot/src/assets/brand/butterfly-logo.svg"), "utf8");
  const size = 512;
  const base = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  const src = await loadImage(Buffer.from(base));
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(src, 0, 0, size, size);
  if (tint) {
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, size, size);
  }
  // Alpha-trim so the mark keeps its real proportions instead of sitting in a
  // square box with invisible padding (which squashes it in a flex row).
  const data = ctx.getImageData(0, 0, size, size).data;
  let minX = size, minY = size, maxX = -1, maxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[(y * size + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const w = Math.max(1, maxX - minX + 1);
  const h = Math.max(1, maxY - minY + 1);
  const trimmed = createCanvas(w, h);
  trimmed.getContext("2d").drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
  const out = {
    uri: `data:image/png;base64,${trimmed.toBuffer("image/png").toString("base64")}`,
    ratio: w / h,
  };
  butterflyCache = { ...(butterflyCache ?? {}), [tint]: out };
  return out;
}

/** A tick inside a ring — the verification motif. Vector, so it stays crisp. */
const checkUri = (color) =>
  svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
       <circle cx="50" cy="50" r="45" fill="none" stroke="${color}" stroke-width="6"/>
       <path d="M30 52 L44 66 L71 36" fill="none" stroke="${color}"
             stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
     </svg>`,
    240,
  );

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * NOTE ON THE CADENCE CLAIM (slide 3).
 *
 * Production runs `DROP_CADENCE=weekly` — one drop, Thursday 18:00 Kyiv
 * (PRODUCT_SPEC §3.1). The `daily` profile exists in code but is INERT and
 * turning it on is a separate founder decision gated on pool size. So the copy
 * says "one pair a week", not "a day": advertising a daily pair would be the
 * same category of promise the unlaunched-city gate exists to stop us making.
 *
 * If `DROP_CADENCE=daily` is ever flipped in `/opt/gennety/.env`, swap
 * `cadence: "weekly"` → `"daily"` below and re-render. Nothing else changes.
 */
const CADENCE = "weekly";

/** The one thing every slide has to leave behind. */
const HANDLE = "@gennetybot";

const COPY = {
  uk: {
    tagline: "Твій особистий AI-метчмейкер",
    slides: [
      {
        n: 1,
        kicker: "ЗНАЙОМСТВА БЕЗ ЛИСТУВАННЯ",
        head: ["ЖОДНОГО", "ЛИСТУВАННЯ."],
        headAccent: ["ЛИШЕ СПРАВЖНІ", "ПОБАЧЕННЯ."],
        sub: "Твій особистий AI-метчмейкер аналізує профіль і цілодобово шукає партнера за глибинними факторами сумісності — а тоді сам домовляється про час і місце.",
      },
      {
        n: 2,
        kicker: "БЕЗПЕКА",
        head: ["ЛИШЕ", "ВЕРИФІКОВАНІ"],
        headAccent: ["ПРОФІЛІ."],
        sub: "Кожен проходить перевірку живою камерою: селфі звіряється з фотографіями профілю. Жодних фейків, ботів і чужих світлин.",
      },
      {
        n: 3,
        kicker: "БЕЗ СВАЙПІВ",
        head: { weekly: ["ОДНА ПАРА", "НА ТИЖДЕНЬ."], daily: ["ОДНА ПАРА", "НА ДЕНЬ."] },
        headAccent: ["ЗАТЕ ТА САМА."],
        stats: [
          ["0", "свайпів"],
          ["0", "змарнованих годин"],
          ["0", "розчарувань"],
        ],
        sub: {
          weekly: "Ніякої стрічки з сотнями анкет. Щочетверга о 18:00 — один вивірений збіг.",
          daily: "Ніякої стрічки з сотнями анкет. Щодня о 18:00 — один вивірений збіг.",
        },
      },
      {
        n: 4,
        kicker: "ТВІЙ КОНТРОЛЬ",
        head: ["ОСТАННЄ СЛОВО —"],
        headAccent: ["ЗА ТОБОЮ."],
        bullets: [
          "Ділитися контактом чи ні — вирішуєш ти",
          "Останнє слово про місце зустрічі — теж твоє",
          "Він не напише першим: у застосунку немає чатів",
        ],
      },
      {
        n: 5,
        kicker: "212 ПЕРЕВІРЕНИХ МІСЦЬ У КИЄВІ",
        head: ["МИ ОБИРАЄМО"],
        headAccent: ["МІСЦЕ ЗА ВАС."],
        venues: [
          "Сенс на Хрещатику",
          "Завертайло біля Софії",
          "Кава та троянди",
          "BARVY",
          "Маріїнський парк",
          "Андріївський узвіз",
        ],
        sub: "Рейтинг 4.0+, відчинено саме у ваш час і зручно дістатися обом. Не «десь у центрі» — конкретна адреса.",
      },
      {
        n: 6,
        kicker: "ПОЧНИ ЗАРАЗ",
        head: { weekly: ["КОЖНОГО", "ЧЕТВЕРГА"], daily: ["КОЖНОГО", "ДНЯ"] },
        headAccent: ["МИ ЗНАХОДИМО", "ТВОЮ ПАРУ."],
        cta: "@gennetybot",
        sub: "Квиток на перше побачення — у подарунок новим учасницям. Реєстрація в Telegram.",
      },
    ],
  },

  ru: {
    tagline: "Твой личный AI-мэтчмейкер",
    slides: [
      {
        n: 1,
        kicker: "ЗНАКОМСТВА БЕЗ ПЕРЕПИСОК",
        head: ["НИКАКИХ", "ПЕРЕПИСОК."],
        headAccent: ["ТОЛЬКО РЕАЛЬНЫЕ", "СВИДАНИЯ."],
        sub: "Твой личный AI-мэтчмейкер анализирует профиль и круглосуточно ищет партнёра по глубинным факторам совместимости — а затем сам договаривается о времени и месте.",
      },
      {
        n: 2,
        kicker: "БЕЗОПАСНОСТЬ",
        head: ["ТОЛЬКО", "ВЕРИФИЦИРОВАННЫЕ"],
        headAccent: ["ПРОФИЛИ."],
        sub: "Каждый проходит проверку живой камерой: селфи сверяется с фотографиями профиля. Никаких фейков, ботов и чужих снимков.",
      },
      {
        n: 3,
        kicker: "БЕЗ СВАЙПОВ",
        head: { weekly: ["ОДНА ПАРА", "В НЕДЕЛЮ."], daily: ["ОДНА ПАРА", "В ДЕНЬ."] },
        headAccent: ["ЗАТО ТА САМАЯ."],
        stats: [
          ["0", "свайпов"],
          ["0", "потраченных часов"],
          ["0", "разочарований"],
        ],
        sub: {
          weekly: "Никакой ленты из сотен анкет. Каждый четверг в 18:00 — одно выверенное совпадение.",
          daily: "Никакой ленты из сотен анкет. Каждый день в 18:00 — одно выверенное совпадение.",
        },
      },
      {
        n: 4,
        kicker: "ТВОЙ КОНТРОЛЬ",
        head: ["ПОСЛЕДНЕЕ СЛОВО —"],
        headAccent: ["ЗА ТОБОЙ."],
        bullets: [
          "Делиться контактом или нет — решаешь ты",
          "Последнее слово о месте встречи — тоже твоё",
          "Он не напишет первым: в приложении нет чатов",
        ],
      },
      {
        n: 5,
        kicker: "212 ПРОВЕРЕННЫХ МЕСТ В КИЕВЕ",
        head: ["МЫ ВЫБИРАЕМ"],
        headAccent: ["МЕСТО ЗА ВАС."],
        venues: [
          "Сенс на Хрещатику",
          "Завертайло біля Софії",
          "Кава та троянди",
          "BARVY",
          "Маріїнський парк",
          "Андріївський узвіз",
        ],
        sub: "Рейтинг 4.0+, открыто именно в ваше время и удобно добраться обоим. Не «где-то в центре» — конкретный адрес.",
      },
      {
        n: 6,
        kicker: "НАЧНИ СЕЙЧАС",
        head: { weekly: ["КАЖДЫЙ", "ЧЕТВЕРГ"], daily: ["КАЖДЫЙ", "ДЕНЬ"] },
        headAccent: ["МЫ НАХОДИМ", "ТВОЮ ПАРУ."],
        cta: "@gennetybot",
        sub: "Билет на первое свидание — в подарок новым участницам. Регистрация в Telegram.",
      },
    ],
  },
};

/** Copy fields may be cadence-keyed objects; resolve them to the live profile. */
const pick = (value) =>
  value && !Array.isArray(value) && typeof value === "object" ? value[CADENCE] : value;

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

/** Type scale, tuned per format (feed is 30% shorter, so it runs tighter). */
function scale(fmt) {
  const story = fmt.key === "story";
  return {
    head: story ? 82 : 74,
    headTight: story ? 68 : 62,
    kicker: story ? 25 : 23,
    sub: story ? 32 : 29,
    body: story ? 34 : 31,
    gapL: story ? 56 : 38,
    gapM: story ? 34 : 24,
    gapS: story ? 20 : 14,
  };
}

function lockup(mark, size = 62) {
  return row({ alignItems: "center" }, [
    mark ? img(mark.uri, { width: Math.round(size * mark.ratio), height: size, marginRight: 18 }) : box({}, []),
    txt({ fontFamily: "Wordmark", fontSize: size * 0.72, color: CREAM, letterSpacing: -1 }, "Gennety"),
  ]);
}

function kickerLine(s, text) {
  return row({ alignItems: "center" }, [
    box({ width: 44, height: 3, background: GOLD, marginRight: 18 }, []),
    txt(
      {
        fontFamily: "Roboto",
        fontWeight: 700,
        fontSize: s.kicker,
        letterSpacing: 3.2,
        color: GOLD,
      },
      text,
    ),
  ]);
}

/**
 * Unbounded's average cap advance as a fraction of the font size. Measured off
 * a real render (an 11-char Ukrainian caps line at 82px occupied ~808px), then
 * rounded UP for headroom — it is a wide face, and the whole point of the
 * constant is that a line must never wrap.
 */
const CAP_ADVANCE = 0.90;

/**
 * The headline: cream lines, then accent lines. Both are set in the display
 * face at its heaviest weight, thickened further with a same-colour text
 * stroke (satori honours WebkitTextStroke) since the family ships no heavier
 * cut — the same trick the referral card uses.
 *
 * The size AUTO-FITS to the longest line rather than being hand-tuned per
 * slide: there are 6 slides × 2 formats × 2 languages, and a wrapped display
 * line (a lone "ЛИШЕ" orphaned above its own sentence) is the single most
 * common way this kind of layout breaks. Fitting on character count is crude
 * but monotonic, which is all that is needed to guarantee no wrap.
 */
function headline(s, lines, accentLines, size, maxWidth) {
  const all = [...(lines ?? []), ...(accentLines ?? [])];
  const longest = all.reduce((m, l) => Math.max(m, l.length), 1);
  const fs = Math.floor(Math.min(size ?? s.head, maxWidth / (longest * CAP_ADVANCE)));
  const line = (value, color) =>
    txt(
      {
        fontFamily: "Display",
        fontWeight: 700,
        fontSize: fs,
        lineHeight: 1.04,
        color,
        whiteSpace: "nowrap",
        WebkitTextStroke: `1.5px ${color}`,
      },
      value,
    );
  return col({ alignItems: "flex-start" }, [
    ...(lines ?? []).map((l) => line(l, CREAM)),
    ...(accentLines ?? []).map((l) => line(l, PEACH)),
  ]);
}

function subline(s, text, width) {
  return txt(
    {
      fontFamily: "Roboto",
      fontWeight: 400,
      fontSize: s.sub,
      lineHeight: 1.42,
      color: "rgba(247,236,236,0.76)",
      maxWidth: width ?? "100%",
    },
    text,
  );
}

/** Carousel position dots — orients the viewer mid-swipe. */
function dots(index, total) {
  return row({ alignItems: "center" }, [
    ...Array.from({ length: total }, (_, i) =>
      box(
        {
          width: i === index ? 30 : 10,
          height: 10,
          borderRadius: 999,
          marginRight: 10,
          background: i === index ? PEACH : "rgba(247,236,236,0.28)",
        },
        [],
      ),
    ),
  ]);
}

/**
 * Position dots + the handle. The handle rather than the tagline: this line is
 * on every slide, so it should be the thing a viewer has to remember, and the
 * tagline already runs in the body copy of slide 1.
 */
function footer(s, index, total, handle) {
  return row({ alignItems: "center", justifyContent: "space-between", width: "100%" }, [
    dots(index, total),
    txt(
      { fontFamily: "Roboto", fontWeight: 700, fontSize: s.kicker, color: "rgba(247,236,236,0.62)" },
      handle,
    ),
  ]);
}

/** Photo tile: rounded, hairline cream edge so it reads as a card on the gradient. */
function tile(uri, style) {
  if (!uri) return box({ ...style, background: "rgba(247,236,236,0.08)" }, []);
  return img(uri, { objectFit: "cover", ...style });
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

async function slideBody(slide, fmt, s, mark) {
  const c = slide;
  const head = pick(c.head);
  const sub = pick(c.sub);
  const story = fmt.key === "story";
  const inner = fmt.w - fmt.pad * 2;

  switch (c.n) {
    // ---- 1. Hook: full-bleed male hero, copy anchored to the bottom --------
    case 1: {
      // FULL-BLEED, not a photo band. A band ends on a hard horizontal edge
      // that the burgundy gradient cannot be faded into (the gradient's value
      // at that y is nothing like the flat colour a scrim can reach), so the
      // card reads as two stacked rectangles. Bleeding the photo across the
      // whole slide and darkening the lower half removes the edge entirely.
      const hero = await photo("man_dinner", fmt.w / fmt.h, 1080);
      return {
        absolutes: [
          hero ? img(hero, { position: "absolute", top: 0, left: 0, width: fmt.w, height: fmt.h }) : box({}, []),
          box(
            {
              position: "absolute",
              left: 0,
              top: 0,
              width: fmt.w,
              height: fmt.h,
              background:
                `linear-gradient(180deg, rgba(23,9,13,0.55) 0%, rgba(23,9,13,0.12) 26%,` +
                ` rgba(23,9,13,0.55) 48%, rgba(30,11,17,0.94) 66%, ${BG_FLAT} 82%)`,
            },
            [],
          ),
        ],
        content: [
          lockup(mark),
          spacer(),
          kickerLine(s, c.kicker),
          box({ height: s.gapM }, []),
          headline(s, head, c.headAccent, s.head, inner),
          box({ height: s.gapM }, []),
          subline(s, sub, inner),
        ],
      };
    }

    // ---- 2. Verification: portrait card with the tick badge ----------------
    case 2: {
      const cardW = Math.round(inner * (story ? 0.78 : 0.62));
      const cardH = Math.round(cardW * (story ? 1.36 : 1.06));
      const p = await photo("man_maker", cardW / cardH, 900);
      const badge = story ? 152 : 126;
      return {
        content: [
          lockup(mark),
          box({ height: s.gapL }, []),
          kickerLine(s, c.kicker),
          box({ height: s.gapM }, []),
          headline(s, head, c.headAccent, s.headTight, inner),
          box({ height: s.gapL }, []),
          // The badge overlaps the card's top-right corner: the tick belongs
          // ON the person, which is exactly what the check verifies.
          box({ position: "relative", width: inner, height: cardH }, [
            tile(p, { width: cardW, height: cardH, borderRadius: 30 }),
            box(
              {
                position: "absolute",
                left: cardW - badge / 2,
                top: -badge / 3,
                width: badge,
                height: badge,
                borderRadius: 999,
                background: BG_FLAT,
                border: `5px solid ${BG_FLAT}`,
                alignItems: "center",
                justifyContent: "center",
              },
              [img(checkUri(PEACH), { width: badge - 14, height: badge - 14 })],
            ),
          ]),
          box({ height: s.gapL }, []),
          subline(s, sub, inner),
          spacer(),
        ],
      };
    }

    // ---- 3. One pair: typographic, zeros carry the argument ----------------
    case 3: {
      const stripH = story ? 250 : 200;
      const tiles = await Promise.all(
        ["man_gym", "woman_table", "man_dinner"].map((k) => photo(k, 0.74, 420)),
      );
      const gap = 20;
      const tileW = Math.round((inner - gap * 2) / 3);
      const statSize = story ? 88 : 74;
      return {
        content: [
          lockup(mark),
          // The photo strip is pinned to the bottom, so the copy block needs
          // its own leading spacer — otherwise all the slack collects in one
          // hole between the two.
          spacer(0.75),
          kickerLine(s, c.kicker),
          box({ height: s.gapM }, []),
          headline(s, head, c.headAccent, s.headTight, inner),
          box({ height: s.gapL }, []),
          // The three zeros are the argument, so they are set at display size
          // and share a left edge — a column of "0" the eye reads before the
          // labels, rather than three sentences that happen to start with one.
          col(
            {},
            c.stats.map(([n, label], i) =>
              row(
                {
                  alignItems: "center",
                  marginBottom: i === c.stats.length - 1 ? 0 : s.gapS,
                },
                [
                  txt(
                    {
                      fontFamily: "Display",
                      fontWeight: 700,
                      fontSize: statSize,
                      lineHeight: 1,
                      color: PEACH,
                      width: statSize * 1.1,
                    },
                    n,
                  ),
                  txt(
                    { fontFamily: "Roboto", fontWeight: 500, fontSize: s.body, color: CREAM },
                    label,
                  ),
                ],
              ),
            ),
          ),
          box({ height: s.gapL }, []),
          subline(s, sub, inner),
          spacer(),
          row(
            {},
            tiles.map((t, i) =>
              tile(t, {
                width: tileW,
                height: stripH,
                borderRadius: 20,
                marginRight: i === tiles.length - 1 ? 0 : gap,
                opacity: 0.92,
              }),
            ),
          ),
        ],
      };
    }

    // ---- 4. Control: her photo bleeding off, bullets on the left ----------
    case 4: {
      // Anchored INTO the top-right corner, bleeding off both edges. A photo
      // floating in the middle of the upper half leaves dead burgundy on three
      // sides; running it off the corner makes the emptiness read as deliberate
      // negative space for the lockup instead of as a gap.
      const bandH = Math.round(fmt.h * (story ? 0.64 : 0.58));
      const p = await photo("woman_dinner", fmt.w / bandH, 1080);
      return {
        absolutes: [
          p
            ? img(p, { position: "absolute", left: 0, top: 0, width: fmt.w, height: bandH })
            : box({}, []),
          // The photo runs under the lockup's row; this keeps the wordmark
          // legible without darkening the whole frame.
          box(
            {
              position: "absolute",
              left: 0,
              top: 0,
              width: fmt.w,
              height: Math.round(fmt.h * 0.16),
              background: `linear-gradient(180deg, rgba(23,9,13,0.82) 0%, rgba(23,9,13,0) 100%)`,
            },
            [],
          ),
          // The scrim must reach FULL opacity above the photo band's bottom
          // edge — that is what hides the edge. A gradient that merely ends at
          // the edge leaves a visible horizontal seam, because the burgundy
          // background is itself a gradient and no flat colour matches it there.
          box(
            {
              position: "absolute",
              left: 0,
              top: Math.round(fmt.h * 0.22),
              width: fmt.w,
              height: fmt.h - Math.round(fmt.h * 0.22),
              background:
                `linear-gradient(180deg, rgba(23,9,13,0) 0%, rgba(23,9,13,0.62) 38%,` +
                ` ${BG_FLAT} 60%, ${BG_FLAT} 100%)`,
            },
            [],
          ),
        ],
        content: [
          lockup(mark),
          spacer(),
          kickerLine(s, c.kicker),
          box({ height: s.gapM }, []),
          headline(s, head, c.headAccent, s.headTight, inner),
          box({ height: s.gapL }, []),
          col(
            {},
            c.bullets.map((b, i) =>
              row(
                {
                  alignItems: "flex-start",
                  marginBottom: i === c.bullets.length - 1 ? 0 : s.gapM,
                  maxWidth: inner,
                },
                [
                  box(
                    {
                      width: 14,
                      height: 14,
                      borderRadius: 999,
                      background: PEACH,
                      marginTop: s.body * 0.42,
                      marginRight: 22,
                      flexShrink: 0,
                    },
                    [],
                  ),
                  txt(
                    {
                      fontFamily: "Roboto",
                      fontWeight: 500,
                      fontSize: s.body,
                      lineHeight: 1.32,
                      color: CREAM,
                      maxWidth: inner - 36,
                    },
                    b,
                  ),
                ],
              ),
            ),
          ),
        ],
      };
    }

    // ---- 5. Venues: real Kyiv names, set as a list ------------------------
    case 5: {
      // Text-only slide: centre the block between two spacers rather than
      // top-aligning it, so the slack reads as margin instead of as a missing
      // element.
      return {
        content: [
          lockup(mark),
          spacer(0.85),
          kickerLine(s, c.kicker),
          box({ height: s.gapM }, []),
          headline(s, head, c.headAccent, s.headTight, inner),
          box({ height: s.gapL }, []),
          col(
            { width: inner },
            c.venues.map((v, i) =>
              row(
                {
                  alignItems: "center",
                  // Roomier than a default list row: this is the slide with
                  // the least content, so the list earns the vertical space
                  // that would otherwise pool under it as a hole.
                  paddingTop: story ? s.gapM : s.gapS,
                  paddingBottom: story ? s.gapM : s.gapS,
                  borderBottom:
                    i === c.venues.length - 1 ? "none" : "1px solid rgba(247,236,236,0.16)",
                },
                [
                  txt(
                    {
                      fontFamily: "Roboto",
                      fontWeight: 700,
                      fontSize: s.kicker,
                      color: "rgba(247,236,236,0.42)",
                      width: 56,
                    },
                    String(i + 1).padStart(2, "0"),
                  ),
                  txt(
                    { fontFamily: "Roboto", fontWeight: 500, fontSize: s.body, color: CREAM },
                    v,
                  ),
                ],
              ),
            ),
          ),
          spacer(),
          subline(s, sub, inner),
        ],
      };
    }

    // ---- 6. CTA ----------------------------------------------------------
    case 6: {
      const markH = story ? 200 : 168;
      return {
        content: [
          lockup(mark),
          spacer(),
          mark
            ? img(mark.uri, { width: Math.round(markH * mark.ratio), height: markH })
            : box({}, []),
          box({ height: s.gapL }, []),
          kickerLine(s, c.kicker),
          box({ height: s.gapM }, []),
          headline(s, head, c.headAccent, s.headTight, inner),
          box({ height: s.gapL }, []),
          txt(
            {
              fontFamily: "Wordmark",
              fontSize: story ? 62 : 54,
              color: BG_FLAT,
              background: PEACH,
              borderRadius: 999,
              paddingTop: 26,
              paddingBottom: 30,
              paddingLeft: 52,
              paddingRight: 52,
              letterSpacing: -1,
            },
            c.cta,
          ),
          spacer(),
          subline(s, sub, inner),
        ],
      };
    }

    default:
      throw new Error(`no layout for slide ${c.n}`);
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function renderSlide(slide, fmt, lang, total) {
  const s = scale(fmt);
  const mark = await butterfly(CREAM);
  const { absolutes = [], content } = await slideBody(slide, fmt, s, mark);

  const tree = col(
    {
      width: fmt.w,
      height: fmt.h,
      position: "relative",
      background: BG_GRADIENT,
      color: CREAM,
      fontFamily: "Roboto",
      padding: fmt.pad,
      alignItems: "flex-start",
    },
    [
      // Absolutely-positioned art paints first: satori paints in document
      // order, and the copy must always win.
      ...absolutes,
      ...content,
      box({ height: s.gapL }, []),
      footer(s, slide.n - 1, total, HANDLE),
    ],
  );

  const svg = await satori(tree, { width: fmt.w, height: fmt.h, fonts: FONTS });
  return Buffer.from(
    new Resvg(svg, { fitTo: { mode: "width", value: fmt.w }, background: BG_FLAT })
      .render()
      .asPng(),
  );
}

async function main() {
  const formats =
    FORMAT_ARG === "both" ? [FORMATS.story, FORMATS.feed] : [FORMATS[FORMAT_ARG]].filter(Boolean);
  if (!formats.length) throw new Error(`unknown --format=${FORMAT_ARG}`);
  const langs = LANG_ARG === "both" ? ["uk", "ru"] : [LANG_ARG];
  for (const l of langs) if (!COPY[l]) throw new Error(`unknown --lang=${l}`);

  mkdirSync(OUT_DIR, { recursive: true });

  for (const lang of langs) {
    const slides = COPY[lang].slides.filter((sl) => !ONLY.length || ONLY.includes(sl.n));
    for (const fmt of formats) {
      const dir = join(OUT_DIR, langs.length > 1 ? `${lang}-${fmt.key}` : fmt.key);
      mkdirSync(dir, { recursive: true });
      for (const slide of slides) {
        const started = Date.now();
        const png = await renderSlide(slide, fmt, lang, COPY[lang].slides.length);
        const name = `${String(slide.n).padStart(2, "0")}.png`;
        writeFileSync(join(dir, name), png);
        console.log(
          `  ${lang}/${fmt.key}/${name}  ${fmt.w}x${fmt.h}  ${(png.length / 1024).toFixed(0)} KB  ${Date.now() - started}ms`,
        );
      }
    }
  }

  const written = readdirSync(OUT_DIR, { recursive: true }).filter((f) => String(f).endsWith(".png"));
  console.log(`\n${written.length} slides → ${OUT_DIR}`);
}

await main();
