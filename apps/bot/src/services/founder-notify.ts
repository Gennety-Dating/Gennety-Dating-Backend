import { Api, InputFile, type RawApi } from "grammy";
import type { InputMediaPhoto } from "grammy/types";
import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { downloadProfileImage } from "./storage.js";
import { getMainBotApi } from "./main-bot-api.js";
import { buildWeeklyMatchesReport } from "./weekly-matches-report.js";
import type { Venue } from "./venue.js";

/**
 * Founder-notify feed (private ops feed, gated by `FOUNDER_NOTIFY_ENABLED`).
 *
 * Three one-way notifications to the founder's personal Telegram via a
 * SEPARATE founder bot (`FOUNDER_BOT_TOKEN` → `FOUNDER_TELEGRAM_ID`):
 *   1. `notifyFounderNewUser`      — new registration: full profile + photos.
 *   2. `notifyFounderWeeklyMatches`— weekly matches report link (Thu batch).
 *   3. `notifyFounderDateScheduled`— a date locked in: both date cards + venue.
 *
 * Everything here is BEST-EFFORT and fire-and-forget: a failure must never
 * touch the user-facing flow. Callers should not await the result on any hot
 * path (or should `.catch(() => {})` when they do).
 *
 * **Cross-bot `file_id` constraint.** Telegram `file_id`s are per-bot, so the
 * founder bot can never re-send a `@gennetybot` `file_id`. This module always
 * uploads RAW BYTES (`InputFile` from a `Buffer`): profile photos are fetched
 * with the MAIN bot (`downloadProfileImage`) and re-uploaded here; date-card
 * PNG buffers are captured at render time and passed in.
 */

const FOUNDER_LOG = "[founder-notify]";
/** Telegram media-group caption ceiling. */
const CAPTION_MAX = 1024;
/** Telegram media-group size ceiling. */
const MEDIA_GROUP_MAX = 10;

let founderApi: Api<RawApi> | null | undefined;

/**
 * Memoized founder-bot `Api`. Returns `null` (and stays null) when the feature
 * is disabled or unconfigured, so every notifier degrades to a no-op. A bare
 * `Api` is enough — the founder bot only ever SENDS, it never polls.
 */
function getFounderApi(): Api<RawApi> | null {
  if (founderApi !== undefined) return founderApi;
  if (!env.FOUNDER_NOTIFY_ENABLED || !env.FOUNDER_BOT_TOKEN || !env.FOUNDER_TELEGRAM_ID) {
    founderApi = null;
    return null;
  }
  founderApi = new Api(env.FOUNDER_BOT_TOKEN);
  return founderApi;
}

/** The founder's numeric chat id (validated non-empty by `getFounderApi`). */
function founderChatId(): number {
  return Number(env.FOUNDER_TELEGRAM_ID);
}

function truncateCaption(text: string): string {
  return text.length <= CAPTION_MAX ? text : `${text.slice(0, CAPTION_MAX - 1)}…`;
}

/**
 * Send a text header followed by a photo media-group built from raw byte
 * buffers. The header rides as the first photo's caption when it fits
 * (≤1024), else it is sent as its own message first. Empty photo list → the
 * header is sent as a plain message.
 */
async function sendHeaderWithPhotos(
  api: Api<RawApi>,
  chatId: number,
  header: string,
  photos: Buffer[],
): Promise<void> {
  const usable = photos.slice(0, MEDIA_GROUP_MAX);
  if (usable.length === 0) {
    await api.sendMessage(chatId, header);
    return;
  }

  const captionFits = header.length <= CAPTION_MAX;
  if (!captionFits) {
    await api.sendMessage(chatId, header);
  }

  if (usable.length === 1) {
    await api.sendPhoto(
      chatId,
      new InputFile(usable[0]!),
      captionFits ? { caption: header } : {},
    );
    return;
  }

  const media: InputMediaPhoto[] = usable.map((buf, i) => ({
    type: "photo",
    media: new InputFile(buf),
    ...(captionFits && i === 0 ? { caption: header } : {}),
  }));
  await api.sendMediaGroup(chatId, media);
}

// ───────────────────────────────────────────────────────────────────────────
// Feature 1 — new registration
// ───────────────────────────────────────────────────────────────────────────

/**
 * DM the founder the full profile of a newly-activated user, once. Idempotent
 * via `User.founderNotifiedAt` — an atomic `updateMany(where: { id, status:
 * "active", founderNotifiedAt: null })` claims the notification, so repeated
 * activations (verified-after-skip, unfreeze on `/start`) never re-send.
 *
 * Deliberately EXCLUDES `psychologicalSummary` / the AI-memory dump (the
 * answer to the exported-AI prompt) — only the ordinary onboarding facts and
 * photos are relayed. Attractiveness score is included when the vision seed
 * has already run (verified users).
 */
export async function notifyFounderNewUser(userId: string): Promise<void> {
  const api = getFounderApi();
  if (!api) return;

  try {
    // Claim the notification atomically. If no row is updated the user is
    // either not active or already notified — nothing to do.
    const claim = await prisma.user.updateMany({
      where: { id: userId, status: "active", founderNotifiedAt: null },
      data: { founderNotifiedAt: new Date() },
    });
    if (claim.count === 0) return;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });
    if (!user) return;

    const header = buildNewUserHeader(user);

    // Fetch photo bytes with the MAIN bot (file_ids are @gennetybot's), then
    // re-upload via the founder bot. Supabase-path photos also resolve here.
    const botApi = getMainBotApi();
    const photoRefs = user.profile?.photos ?? [];
    const buffers: Buffer[] = [];
    if (botApi) {
      for (const ref of photoRefs.slice(0, MEDIA_GROUP_MAX)) {
        const buf = await downloadProfileImage(ref, botApi);
        if (buf) buffers.push(buf);
      }
    }

    await sendHeaderWithPhotos(api, founderChatId(), header, buffers);
  } catch (err) {
    console.warn(`${FOUNDER_LOG} notifyFounderNewUser failed`, { userId, err });
  }
}

type UserWithProfile = NonNullable<
  Awaited<ReturnType<typeof prisma.user.findUnique>>
> & { profile: { [k: string]: unknown } | null };

function attractivenessOf(profile: Record<string, unknown> | null): number | null {
  if (!profile) return null;
  const details = profile["eloSeedDetails"];
  if (details && typeof details === "object" && "score" in details) {
    const s = (details as { score?: unknown }).score;
    if (typeof s === "number") return Math.round(s);
  }
  return null;
}

function buildNewUserHeader(user: UserWithProfile): string {
  const p = (user.profile ?? {}) as Record<string, unknown>;
  const lines: string[] = ["🆕 Новая регистрация"];
  const name = user.firstName ?? "—";
  const age = user.age != null ? `, ${user.age}` : "";
  lines.push(`👤 ${name}${age}`);
  if (user.gender) lines.push(`Пол: ${user.gender}`);
  if (user.preference) lines.push(`Ищет: ${user.preference}`);
  const city = (p["homeCity"] as string | null) ?? null;
  if (city) lines.push(`Город: ${city}`);
  const height = p["height"] as number | null;
  if (height) lines.push(`Рост: ${height} см`);
  const hobbies = p["hobbies"] as string[] | undefined;
  if (hobbies && hobbies.length) lines.push(`Хобби: ${hobbies.join(", ")}`);
  const partnerPrefs = p["partnerPreferences"] as string | null;
  if (partnerPrefs) lines.push(`Хочет в партнёре: ${partnerPrefs}`);
  const ethnicity = p["ethnicity"] as string | null;
  if (ethnicity) lines.push(`Национальность/этнос: ${ethnicity}`);
  if (user.language) lines.push(`Язык: ${user.language}`);
  if (user.registrationTrack) lines.push(`Трек: ${user.registrationTrack}`);
  lines.push(`Верификация: ${user.verificationStatus}`);
  const score = attractivenessOf(p);
  if (score != null) lines.push(`⭐ Attractiveness: ${score}/100`);
  if (user.telegramUsername) lines.push(`TG: @${user.telegramUsername}`);
  return truncateCaption(lines.join("\n"));
}

// ───────────────────────────────────────────────────────────────────────────
// Feature 2 — weekly matches report
// ───────────────────────────────────────────────────────────────────────────

/**
 * After the Thursday batch, snapshot the week's matches into a `FounderReport`
 * row and DM the founder a tokenized link to the report page
 * (`GET /v1/founder/report/:token`). No-op when the feature is off or no pairs
 * were created.
 */
export async function notifyFounderWeeklyMatches(matchIds: string[]): Promise<void> {
  const api = getFounderApi();
  if (!api) return;
  if (matchIds.length === 0) return;

  try {
    const report = await buildWeeklyMatchesReport({ matchIds });
    if (report.pairs.length === 0) return;

    const token = randomToken();
    const weekOf = startOfUtcDay(new Date());
    await prisma.founderReport.create({
      // Prisma Json — the report is a plain serializable snapshot.
      data: { token, weekOf, dataJson: report as unknown as object },
    });

    const url = `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/v1/founder/report/${token}`;
    const header =
      `🗓 Матчи недели: ${report.pairs.length} ` +
      `${plural(report.pairs.length, "пара", "пары", "пар")}\n${url}`;
    await api.sendMessage(founderChatId(), header, {
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.warn(`${FOUNDER_LOG} notifyFounderWeeklyMatches failed`, { err });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Feature 3 — date scheduled
// ───────────────────────────────────────────────────────────────────────────

export interface FounderDateScheduledInput {
  matchId: string;
  /** Rendered date-card PNG shown to user A (i.e. showing partner B). */
  cardBufferA: Buffer | null;
  /** Rendered date-card PNG shown to user B (i.e. showing partner A). */
  cardBufferB: Buffer | null;
  userA: { firstName: string | null; age: number | null; gender: string | null; city: string | null };
  userB: { firstName: string | null; age: number | null; gender: string | null; city: string | null };
  venue: Pick<Venue, "name" | "address">;
  agreedTime: Date;
  /** Fallback partner-photo refs (first photo per side) when cards are absent. */
  photoRefA: string | null;
  photoRefB: string | null;
}

/**
 * DM the founder that a date locked in: both rendered date cards (male card +
 * female card) as one media group, captioned with the pair + venue + time.
 * When the date-card feature is off (no buffers) it falls back to the two
 * partner photos fetched via the main bot.
 */
export async function notifyFounderDateScheduled(
  input: FounderDateScheduledInput,
): Promise<void> {
  const api = getFounderApi();
  if (!api) return;

  try {
    // Order the two cards male-first for a stable, readable layout. A card's
    // gender is the RECIPIENT's gender (the recipient sees their partner).
    const sides: Array<{ gender: string | null; card: Buffer | null; photoRef: string | null }> = [
      { gender: input.userA.gender, card: input.cardBufferA, photoRef: input.photoRefA },
      { gender: input.userB.gender, card: input.cardBufferB, photoRef: input.photoRefB },
    ];
    sides.sort((a, b) => (a.gender === "male" ? -1 : b.gender === "male" ? 1 : 0));

    const buffers: Buffer[] = [];
    for (const s of sides) {
      if (s.card) {
        buffers.push(s.card);
        continue;
      }
      // Fallback: fetch the partner photo via the main bot.
      const botApi = getMainBotApi();
      if (botApi && s.photoRef) {
        const buf = await downloadProfileImage(s.photoRef, botApi);
        if (buf) buffers.push(buf);
      }
    }

    const header = buildDateScheduledHeader(input);
    await sendHeaderWithPhotos(api, founderChatId(), header, buffers);
  } catch (err) {
    console.warn(`${FOUNDER_LOG} notifyFounderDateScheduled failed`, {
      matchId: input.matchId,
      err,
    });
  }
}

function buildDateScheduledHeader(input: FounderDateScheduledInput): string {
  const a = input.userA;
  const b = input.userB;
  const who = (u: FounderDateScheduledInput["userA"]) => {
    const name = u.firstName ?? "—";
    const age = u.age != null ? `, ${u.age}` : "";
    const city = u.city ? ` (${u.city})` : "";
    return `${name}${age}${city}`;
  };
  const when = input.agreedTime.toLocaleString("ru-RU", {
    timeZone: "Europe/Kyiv",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return truncateCaption(
    [
      "💫 Свидание запланировано",
      `${who(a)}  ✕  ${who(b)}`,
      `📍 ${input.venue.name}`,
      input.venue.address,
      `📅 ${when} (Kyiv)`,
    ].join("\n"),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** URL-safe crypto-random token for the report page (32 bytes → 43 chars). */
function randomToken(): string {
  // Node's webcrypto is globally available on Node 20.
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** Test seam: reset the memoized founder Api (used by unit tests). */
export function __resetFounderApiForTests(): void {
  founderApi = undefined;
}
