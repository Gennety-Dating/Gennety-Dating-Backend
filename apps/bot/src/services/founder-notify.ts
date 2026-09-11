import { Api, InputFile, type RawApi } from "grammy";
import type { InputMediaPhoto } from "grammy/types";
import { prisma, type Prisma } from "@gennety/db";
import { env } from "../config.js";
import { downloadProfileImage } from "./storage.js";
import { getMainBotApi } from "./main-bot-api.js";
import { installApiLimits } from "../api-limits.js";
import { buildWeeklyMatchesReport } from "./weekly-matches-report.js";
import {
  formatPurchaseAmount,
  formatUsdCents,
  purchaseKindLabel,
  starsToUsdCents,
  type PurchaseKind,
} from "./purchases.js";
import { isoDay, previousWeek, signAdSpendLink } from "./founder-ad-spend-link.js";
import type { Venue } from "./venue.js";

/**
 * Founder-notify feed (private ops feed, gated by `FOUNDER_NOTIFY_ENABLED`).
 *
 * One-way notifications to the founder's personal Telegram via a SEPARATE
 * founder bot (`FOUNDER_BOT_TOKEN` → `FOUNDER_TELEGRAM_ID`):
 *   1. `notifyFounderNewUser`      — new registration: full profile + photos.
 *   2. `notifyFounderWeeklyMatches`— weekly matches report link (Thu batch).
 *   3. `notifyFounderDateScheduled`— a date locked in: both date cards + venue.
 *   4. `notifyFounderAccountClosed`— freeze / GDPR delete: profile + phone.
 *   5. `notifyFounderPurchase` / `notifyFounderPurchaseRefunded` — every real
 *      money movement (ticket store, date gate, Premium, Rematch, venue
 *      change; Telegram Stars and App Store alike), with who paid and how much.
 *   6. `notifyFounderAdSpendReminder` — weekly nudge to log acquisition spend
 *      for the week that just closed, carrying a one-tap link to the mobile
 *      form (`docs/product/domains/ad-spend-tracking.md`). Rides
 *      `FOUNDER_NOTIFY_ENABLED` alone — no feature flag of its own, because
 *      the reminder is worthless without the feed it already gates on.
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
 * The founder feed is a PRODUCTION-ONLY ops channel.
 *
 * Dev and prod deliberately share one founder bot + one founder chat (there is
 * only one founder), so an enabled `FOUNDER_NOTIFY_ENABLED` in `.env.local`
 * silently posts local test registrations into the same DM as real users —
 * which is exactly the signal the feed exists to carry. Env hygiene alone is
 * not enough: `.env.local` is untracked and drifts.
 *
 * The discriminator is the one already used by the identity trust gate
 * (`identityTrustConfigurationErrors`): the supported local launcher
 * (`scripts/dev-bot.mjs`) sets `NODE_ENV=development`, while production leaves
 * it unset. ONLY an explicit `development` mutes the feed — anything else is
 * treated as production-like, so a missing `NODE_ENV` can never silence the
 * real one. (`test` is left alone: vitest mocks grammy's `Api`, so no message
 * ever leaves the process there.)
 */
export function isFounderFeedSuppressedRuntime(
  runtime = process.env.NODE_ENV,
): boolean {
  return runtime === "development";
}

/**
 * Memoized founder-bot `Api`. Returns `null` (and stays null) when the feature
 * is disabled, unconfigured, or running outside production, so every notifier
 * degrades to a no-op. A bare `Api` is enough — the founder bot only ever
 * SENDS, it never polls.
 */
function getFounderApi(): Api<RawApi> | null {
  if (founderApi !== undefined) return founderApi;
  if (!env.FOUNDER_NOTIFY_ENABLED || !env.FOUNDER_BOT_TOKEN || !env.FOUNDER_TELEGRAM_ID) {
    founderApi = null;
    return null;
  }
  if (isFounderFeedSuppressedRuntime()) {
    console.warn(
      `${FOUNDER_LOG} suppressed: FOUNDER_NOTIFY_ENABLED is on but NODE_ENV=${process.env.NODE_ENV} — the founder feed is production-only`,
    );
    founderApi = null;
    return null;
  }
  founderApi = new Api(env.FOUNDER_BOT_TOKEN);
  // A second bot token means a second, independent set of Bot API limits, and
  // this one sends in bursts: eleven notifiers, several of which fire together
  // after the Thursday batch. It pays the same rules as the main bot.
  installApiLimits(founderApi);
  return founderApi;
}

/** The founder's numeric chat id (validated non-empty by `getFounderApi`). */
function founderChatId(): number {
  return Number(env.FOUNDER_TELEGRAM_ID);
}

/**
 * Anonymous ops alert for ANY scheduled job.
 *
 * The status-timer notifier below predates this and stayed as it is because its
 * wording is specific and its runner has its own heartbeat. This one is what
 * the other twenty-five jobs get: before it, they failed into `console.error`
 * on a droplet nobody watches, so a subsystem could be down for days and the
 * first signal would be a person asking why nothing happened.
 */
export async function notifyFounderSubsystemHealth(
  subsystem: string,
  state: "degraded" | "recovered",
  consecutiveFailures: number,
): Promise<void> {
  const api = getFounderApi();
  if (!api) return;
  const text =
    state === "degraded"
      ? `⚠️ «${subsystem}» падает ${consecutiveFailures} тик(а/ов) подряд.`
      : `✅ «${subsystem}» снова работает — после ${consecutiveFailures} упавших тиков.`;
  try {
    await api.sendMessage(founderChatId(), text);
  } catch (err) {
    console.warn(`${FOUNDER_LOG} subsystem health notify failed`, { subsystem, err });
  }
}

/**
 * A handler blew up while answering a person.
 *
 * `bot.catch` used to be the end of the road: log the error, apologise to the
 * user, move on. That is fine for one bad update and wrong for a broken deploy,
 * where the same exception fires for everybody and nobody is told.
 *
 * Rate-limited hard, because the failure mode being reported is precisely the
 * one that would otherwise send a message per update: the first error in a
 * window is announced, the rest are counted and folded into the next one.
 */
const HANDLER_ALERT_WINDOW_MS = 15 * 60 * 1000;
let handlerAlertWindowStartedAt = 0;
let handlerErrorsSinceAlert = 0;

export async function notifyFounderHandlerError(
  summary: string,
  now: Date = new Date(),
): Promise<void> {
  const api = getFounderApi();
  if (!api) return;

  handlerErrorsSinceAlert += 1;
  const nowMs = now.getTime();
  if (nowMs - handlerAlertWindowStartedAt < HANDLER_ALERT_WINDOW_MS) return;

  const suppressed = handlerErrorsSinceAlert - 1;
  handlerAlertWindowStartedAt = nowMs;
  handlerErrorsSinceAlert = 0;

  const lines = [`🛑 Ошибка в обработчике: ${summary.slice(0, 400)}`];
  if (suppressed > 0) {
    lines.push(`…и ещё ${suppressed} за последние 15 минут.`);
  }
  try {
    await api.sendMessage(founderChatId(), lines.join("\n"));
  } catch (err) {
    console.warn(`${FOUNDER_LOG} handler error notify failed`, err);
  }
}

/** Test seam: the window is module state, and tests must not inherit it. */
export function __resetHandlerAlertsForTests(): void {
  handlerAlertWindowStartedAt = 0;
  handlerErrorsSinceAlert = 0;
}

/** Anonymous ops alert for the pinned status-timer worker. */
export async function notifyFounderStatusTimerHealth(
  state: "degraded" | "recovered",
  consecutiveFailures: number,
): Promise<void> {
  const api = getFounderApi();
  if (!api) return;
  // Names the user-visible consequence, not just the worker. "Status timer
  // degraded" is only actionable if you remember what that worker drives.
  const text =
    state === "degraded"
      ? `⚠️ Воркер закреплённого статуса не отвечает: ${consecutiveFailures} ` +
        `${plural(consecutiveFailures, "тик", "тика", "тиков")} подряд с ошибкой.\n` +
        `Закреплённые сообщения перестали обновляться — проверь логи бота.`
      : `✅ Воркер закреплённого статуса ожил после ${consecutiveFailures} ` +
        `${plural(consecutiveFailures, "неудачного тика", "неудачных тиков", "неудачных тиков")}.`;
  try {
    await api.sendMessage(founderChatId(), text);
  } catch (err) {
    console.warn(`${FOUNDER_LOG} status-timer health notify failed`, err);
  }
}

/**
 * Someone marked an event `unsafe` (LAUNCH_EVENTS §10).
 *
 * Fired at write time rather than left to the admin hub, because this is the
 * one post-event answer where waiting for someone to open a dashboard is the
 * wrong outcome. It carries the REPORTER's name and handle (plus the event and
 * the reporter's own words when they wrote some) for exactly that reason: an
 * alert whose point is "reach this person now" that only prints two UUIDs
 * still routes through the dashboard, which is the delay it exists to avoid.
 * The disclosure is narrower than the profile-and-photos dump the
 * account-closure notification already makes in this same private DM.
 */
export async function notifyFounderEventSafetyFlag(input: {
  eventId: string;
  userId: string;
  text: string | null;
}): Promise<void> {
  const api = getFounderApi();
  if (!api) return;
  try {
    // Two ids were the whole message before, and on a phone that is a dead
    // end: a safety report is the one alert whose value is being able to
    // reach the person NOW, and looking up who `user=<uuid>` is meant opening
    // the dashboard first. The disclosure this adds — a name and a handle —
    // is strictly narrower than what the account-closed notification in this
    // same DM already carries.
    const [event, user] = await Promise.all([
      prisma.event.findUnique({
        where: { id: input.eventId },
        select: { title: true, cityKey: true, startsAt: true },
      }),
      prisma.user.findUnique({
        where: { id: input.userId },
        select: { firstName: true, telegramUsername: true, phone: true },
      }),
    ]);

    const lines = ["🚨 Отметка «небезопасно» после мероприятия"];
    if (event) {
      const when = event.startsAt.toLocaleDateString("ru-RU", {
        timeZone: "Europe/Kyiv",
        dateStyle: "medium",
      });
      lines.push(`📍 ${event.title} · ${event.cityKey} · ${when}`);
    }
    if (user) {
      const contact = [
        user.telegramUsername ? `@${user.telegramUsername}` : null,
        user.phone,
      ].filter(Boolean);
      // Explicitly "who reported", not a bare 👤: this id is the person who
      // felt unsafe, never the person they are reporting, and a name printed
      // under a 🚨 with no label reads as the opposite.
      lines.push(
        `🙋 Сообщил(а): ${user.firstName ?? "—"}${contact.length ? ` · ${contact.join(" · ")}` : ""}`,
      );
    }
    lines.push(`event=${input.eventId}`, `user=${input.userId}`);
    if (input.text) lines.push("", `«${input.text}»`);
    await api.sendMessage(founderChatId(), lines.join("\n"));
  } catch (err) {
    console.warn(`${FOUNDER_LOG} event safety notify failed`, { eventId: input.eventId, err });
  }
}

/** Privacy-safe terminal alert for Venue Intent V2 provider failures. */
export async function notifyFounderVenueSelectionFailure(
  matchId: string,
  reason: string,
  attempts: number,
): Promise<void> {
  const api = getFounderApi();
  if (!api) return;
  try {
    // Says what it costs the pair, because that is what decides whether the
    // founder acts now or reads it over coffee.
    await api.sendMessage(
      founderChatId(),
      `⚠️ Не удалось подобрать место для пары — свидание висит без адреса.\n` +
        `Причина: ${reason} (попыток: ${attempts})\n` +
        `match=${matchId}`,
    );
  } catch (err) {
    console.warn(`${FOUNDER_LOG} venue-selection failure notify failed`, { matchId, err });
  }
}

/**
 * Weekly "one venue is taking the city" alert (VENUE_ENGINE_IMPROVEMENT_PLAN
 * part 6). Carries the sample size on purpose: in a city with three dates a
 * 66% share is arithmetic, not a defect, and only the reader can tell those
 * apart. A minimum-sample threshold was considered and rejected — it would
 * blind the alert exactly when a new market launches.
 */
export async function notifyFounderVenueConcentration(
  alerts: ReadonlyArray<{
    cityKey: string;
    placeId: string;
    count: number;
    assignments: number;
    sharePct: number;
    uniqueVenues: number;
  }>,
  windowDays: number,
): Promise<void> {
  const api = getFounderApi();
  if (!api || alerts.length === 0) return;
  const lines = alerts.map(
    (row) =>
      `• ${row.cityKey}: ${row.sharePct.toFixed(0)}% — ${row.count} из ${row.assignments} свиданий ушли в одно место (${row.placeId}); всего задействовано мест: ${row.uniqueVenues}`,
  );
  try {
    await api.sendMessage(
      founderChatId(),
      `📍 Одно место забирает город (за ${windowDays} дн.)\n${lines.join("\n")}\n\n` +
        `На малых числах это арифметика, а не поломка — сначала посмотри на количество свиданий.`,
    );
  } catch (err) {
    console.warn(`${FOUNDER_LOG} venue-concentration notify failed`, err);
  }
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
  if (user.language) lines.push(`Язык: ${user.language}`);
  if (user.registrationTrack) lines.push(`Трек: ${user.registrationTrack}`);
  lines.push(`Верификация: ${user.verificationStatus}`);
  const score = attractivenessOf(p);
  if (score != null) lines.push(`⭐ Attractiveness: ${score}/100`);
  if (user.telegramUsername) lines.push(`TG: @${user.telegramUsername}`);
  return truncateCaption(lines.join("\n"));
}

// ───────────────────────────────────────────────────────────────────────────
// Feature 4 — account closed (freeze / delete)
// ───────────────────────────────────────────────────────────────────────────

/** Minimal shape the account-closed notifier reads. On a hard delete the
 * caller MUST pre-fetch this (and any photo bytes) BEFORE the delete/storage
 * cleanup runs, since the row and Supabase-hosted photos are gone afterward.
 * `FOUNDER_ACCOUNT_CLOSED_SELECT` below is the matching Prisma `select`. */
export interface FounderAccountUser {
  firstName: string | null;
  age: number | null;
  gender: string | null;
  preference: string | null;
  phone: string | null;
  email: string | null;
  language: string | null;
  registrationTrack: string | null;
  verificationStatus: string;
  telegramUsername: string | null;
  telegramId: bigint;
  /** Drives "days in product" on the anonymous delete notification. */
  createdAt: Date;
  /** Funnel stage on the anonymous delete notification. */
  status: string;
  onboardingStep: string;
  profile: {
    homeCity: string | null;
    height: number | null;
    hobbies: string[];
    partnerPreferences: string | null;
    photos: string[];
    eloSeedDetails: unknown;
  } | null;
}

/** Prisma `select` shape matching {@link FounderAccountUser}. */
export const FOUNDER_ACCOUNT_CLOSED_SELECT = {
  firstName: true,
  age: true,
  gender: true,
  preference: true,
  phone: true,
  email: true,
  language: true,
  registrationTrack: true,
  verificationStatus: true,
  telegramUsername: true,
  telegramId: true,
  createdAt: true,
  status: true,
  onboardingStep: true,
  profile: {
    select: {
      homeCity: true,
      height: true,
      hobbies: true,
      partnerPreferences: true,
      photos: true,
      eloSeedDetails: true,
    },
  },
} satisfies Prisma.UserSelect;

/**
 * DM the founder when a user closes their account — freeze (soft) or delete
 * (hard). Both carry the full profile card, the phone number and the photos.
 *
 * **History, because this branch has moved twice and will be questioned again.**
 * The delete path was reduced to an anonymous lifecycle event on 2026-08-01,
 * on the reasoning that a deletion is a GDPR Art. 17 erasure request and a
 * profile dump landing in a Telegram chat at that moment outlives the erasure.
 * It was **restored by an explicit founder decision on 2026-08-02**: at this
 * stage of the product, knowing exactly who left — with enough context to
 * recognise them and follow up personally — is treated as load-bearing for
 * understanding early churn, and the operator accepts the tradeoff knowingly.
 *
 * What that decision commits us to, and what must NOT quietly rot:
 *   - `legal/privacy-policy.md` §12.2 discloses this notification explicitly,
 *     including the phone number and the photos. If this code changes, that
 *     section changes in the same commit.
 *   - It is recorded as an accepted residual risk in `legal/dpia.md` (R9) and
 *     as a processing activity in `legal/ropa.md` §2.10.
 *   - An erasure request extends to this chat: when a user asks to be
 *     forgotten, the operator must delete the corresponding messages from the
 *     founder-bot conversation. Nothing automates that.
 *
 * Because a hard delete cascades the row away and removes Supabase-hosted
 * photos, the CALLER must pre-fetch `user` (with profile) and, for a delete,
 * pass pre-downloaded `photoBuffers` — Telegram `file_id`s stay resolvable
 * after the row is gone, but a Supabase storage path does not survive the
 * cleanup that runs before the delete transaction. When `photoBuffers` is
 * omitted (the freeze path, where the row still exists), photos are downloaded
 * here from `user.profile.photos` directly.
 */
export async function notifyFounderAccountClosed(
  action: "frozen" | "deleted",
  user: FounderAccountUser,
  photoBuffers?: Buffer[],
): Promise<void> {
  const api = getFounderApi();
  if (!api) return;

  try {
    const header = buildAccountClosedHeader(action, user);
    let buffers = photoBuffers;
    if (!buffers) {
      buffers = [];
      const botApi = getMainBotApi();
      const photoRefs = user.profile?.photos ?? [];
      if (botApi) {
        for (const ref of photoRefs.slice(0, MEDIA_GROUP_MAX)) {
          const buf = await downloadProfileImage(ref, botApi);
          if (buf) buffers.push(buf);
        }
      }
    }
    await sendHeaderWithPhotos(api, founderChatId(), header, buffers);
  } catch (err) {
    console.warn(`${FOUNDER_LOG} notifyFounderAccountClosed failed`, { action, err });
  }
}

/**
 * Profile card for a closed account, freeze or delete alike.
 *
 * Carries the phone number by design — see the founder decision recorded on
 * `notifyFounderAccountClosed`. The one addition kept from the anonymous
 * version is `В продукте: N дн.`, which costs nothing and is the single most
 * useful number for reading early churn.
 */
function buildAccountClosedHeader(
  action: "frozen" | "deleted",
  user: FounderAccountUser,
): string {
  const p = user.profile;
  const title = action === "deleted" ? "🗑 Аккаунт УДАЛЁН" : "❄️ Аккаунт ЗАМОРОЖЕН";
  const lines: string[] = [title];
  const name = user.firstName ?? "—";
  const age = user.age != null ? `, ${user.age}` : "";
  lines.push(`👤 ${name}${age}`);
  // The phone number is the headline datum for this notification.
  lines.push(`📞 Телефон: ${user.phone ?? "—"}`);
  if (user.email) lines.push(`✉️ Email: ${user.email}`);
  if (user.gender) lines.push(`Пол: ${user.gender}`);
  if (user.preference) lines.push(`Искал(а): ${user.preference}`);
  if (p?.homeCity) lines.push(`Город: ${p.homeCity}`);
  if (p?.height) lines.push(`Рост: ${p.height} см`);
  if (p?.hobbies && p.hobbies.length) lines.push(`Хобби: ${p.hobbies.join(", ")}`);
  if (p?.partnerPreferences) lines.push(`Хотел(а) в партнёре: ${p.partnerPreferences}`);
  if (user.language) lines.push(`Язык: ${user.language}`);
  if (user.registrationTrack) lines.push(`Трек: ${user.registrationTrack}`);
  lines.push(`Верификация: ${user.verificationStatus}`);
  const score = attractivenessOf((p ?? null) as Record<string, unknown> | null);
  if (score != null) lines.push(`⭐ Attractiveness: ${score}/100`);
  if (user.telegramUsername) lines.push(`TG: @${user.telegramUsername}`);
  lines.push(`Telegram ID: ${user.telegramId.toString()}`);
  const days = Math.max(
    0,
    Math.floor((Date.now() - user.createdAt.getTime()) / 86_400_000),
  );
  lines.push(`В продукте: ${days} дн.`);
  return truncateCaption(lines.join("\n"));
}

// ───────────────────────────────────────────────────────────────────────────
// Feature 5 — purchases (every real money movement)
// ───────────────────────────────────────────────────────────────────────────

/**
 * One purchase, as the call site knows it at the moment money moved. Kept
 * deliberately small: the notifier resolves the payer's identity itself, so a
 * caller only has to describe the charge.
 */
export interface FounderPurchaseNotice {
  userId: string;
  kind: PurchaseKind;
  provider: "telegram_stars" | "app_store" | "no_charge";
  /** Stars charged (Telegram rail). */
  amountStars?: number | null;
  /** Exact money in cents (App Store / the no-charge rail's shelf price). */
  amountCents?: number | null;
  currency?: string | null;
  /** Short human description: "3 tickets", "оба слота", "продление". */
  detail?: string | null;
  matchId?: string | null;
  externalPaymentId?: string | null;
}

/**
 * DM the founder that someone paid. Fired from the SETTLEMENT point of each
 * rail — the same write whose unique provider-charge id makes the purchase
 * exactly-once — so a redelivered `successful_payment` (Telegram retry, App
 * Store re-submit) never produces a second message: the caller has already
 * returned on the duplicate before reaching this.
 *
 * Identity is the point of the notification, so it leads with whatever
 * actually reaches the person: the Telegram `@username` on the Telegram rail,
 * the phone number on the mobile one (a mobile-only account has a synthetic
 * negative `telegramId` and no username at all).
 *
 * Best-effort like every other notifier here: a failure is logged and never
 * touches the payment path.
 */
export async function notifyFounderPurchase(notice: FounderPurchaseNotice): Promise<void> {
  const api = getFounderApi();
  if (!api) return;

  try {
    const user = await prisma.user.findUnique({
      where: { id: notice.userId },
      select: FOUNDER_PAYER_SELECT,
    });
    if (!user) return;

    const amount = formatPurchaseAmount({
      amountStars: notice.amountStars ?? null,
      amountCents: notice.amountCents ?? null,
      currency: notice.currency ?? null,
      usdCents:
        notice.amountCents ??
        (notice.amountStars != null ? starsToUsdCents(notice.amountStars) : null),
      amountIsEstimate: notice.amountCents == null && notice.amountStars != null,
    });

    const lines = [
      `💰 Покупка — ${purchaseKindLabel(notice.kind)}`,
      ...payerLines(user),
      `💵 ${amount}`,
    ];
    if (notice.detail) lines.push(`🧾 ${notice.detail}`);
    lines.push(`🏦 ${providerLabel(notice.provider)}`);
    if (notice.matchId) lines.push(`Матч: ${notice.matchId}`);
    if (notice.externalPaymentId) lines.push(`Charge: ${notice.externalPaymentId}`);

    await api.sendMessage(founderChatId(), lines.join("\n"));
  } catch (err) {
    console.warn(`${FOUNDER_LOG} notifyFounderPurchase failed`, {
      userId: notice.userId,
      kind: notice.kind,
      err,
    });
  }
}

/**
 * DM the founder that a purchase came back. Without this the feed would carry
 * a sale that is no longer one — a Rematch refund fires seconds after the
 * purchase message, and a venue-change race can refund minutes later. The
 * admin list shows the same fact as a status; this keeps the DM honest.
 */
export async function notifyFounderPurchaseRefunded(notice: {
  userId: string;
  kind: PurchaseKind;
  amountStars?: number | null;
  amountCents?: number | null;
  /** Charge currency for the `amountCents` rail. Omit on the Stars rail. */
  currency?: string | null;
  /** Why it came back, in the source's own words (`refunded_no_candidate`). */
  reason?: string | null;
  externalPaymentId?: string | null;
}): Promise<void> {
  const api = getFounderApi();
  if (!api) return;

  try {
    const user = await prisma.user.findUnique({
      where: { id: notice.userId },
      select: FOUNDER_PAYER_SELECT,
    });
    if (!user) return;

    const amount = formatPurchaseAmount({
      amountStars: notice.amountStars ?? null,
      amountCents: notice.amountCents ?? null,
      currency: notice.currency ?? null,
      usdCents:
        notice.amountCents ??
        (notice.amountStars != null ? starsToUsdCents(notice.amountStars) : null),
      amountIsEstimate: notice.amountCents == null && notice.amountStars != null,
    });

    const lines = [
      `↩️ Возврат — ${purchaseKindLabel(notice.kind)}`,
      ...payerLines(user),
      `💵 ${amount}`,
    ];
    if (notice.reason) lines.push(`Причина: ${notice.reason}`);
    if (notice.externalPaymentId) lines.push(`Charge: ${notice.externalPaymentId}`);

    await api.sendMessage(founderChatId(), lines.join("\n"));
  } catch (err) {
    console.warn(`${FOUNDER_LOG} notifyFounderPurchaseRefunded failed`, {
      userId: notice.userId,
      err,
    });
  }
}

/**
 * DM the founder that money moved and the goods did NOT — the one payment
 * outcome nobody else reports.
 *
 * Every settled rail already announces itself (`notifyFounderPurchase`) and
 * every compensated one announces the reversal (`notifyFounderPurchaseRefunded`).
 * What had no voice at all was the third outcome: Telegram confirmed the Stars,
 * and the handler then returned early or threw before writing anything durable.
 * There is no ledger row to reconcile against in that case — a `console.error`
 * on a droplet was the entire audit trail — so this is deliberately loud and
 * carries the charge id, which is the only thing `refundStarPayment` needs.
 *
 * Two things make it different from the notifiers above, and both are the point:
 *
 *  1. **The payer may not exist in our database.** `user-not-found` is one of
 *     the failures being reported, so the identity block degrades to the raw
 *     Telegram id rather than returning early the way the others do. A
 *     notification we drop here is a charge nobody ever learns about.
 *  2. **It is not best-effort at the call site.** The caller awaits it, because
 *     it is the last thing standing between a silent charge and a refund.
 */
export interface FounderPaymentStuckNotice {
  /** Telegram id of the payer — the only identity guaranteed to exist. */
  telegramId: bigint;
  /** Our user id, when the payer resolved at all. */
  userId?: string | null;
  amountStars?: number | null;
  /** The invoice payload, so the founder can see what was bought. */
  payload?: string | null;
  externalPaymentId?: string | null;
  /** Machine reason in the handler's own words (`user-not-found`, `threw`). */
  reason: string;
}

export async function notifyFounderPaymentStuck(
  notice: FounderPaymentStuckNotice,
): Promise<void> {
  const api = getFounderApi();
  if (!api) return;

  try {
    const user = notice.userId
      ? await prisma.user
          .findUnique({ where: { id: notice.userId }, select: FOUNDER_PAYER_SELECT })
          .catch(() => null)
      : null;

    const amount = formatPurchaseAmount({
      amountStars: notice.amountStars ?? null,
      amountCents: null,
      currency: null,
      usdCents: notice.amountStars != null ? starsToUsdCents(notice.amountStars) : null,
      amountIsEstimate: notice.amountStars != null,
    });

    const lines = [
      "🚨 Оплата прошла, товар НЕ выдан",
      ...(user ? payerLines(user) : [`👤 Telegram ID: ${notice.telegramId.toString()}`]),
      `💵 ${amount}`,
      `❗️ Причина: ${notice.reason}`,
    ];
    if (notice.payload) lines.push(`🧾 Payload: ${notice.payload}`);
    if (notice.externalPaymentId) lines.push(`Charge: ${notice.externalPaymentId}`);
    lines.push("Вернуть звёзды можно по этому charge id.");

    await api.sendMessage(founderChatId(), lines.join("\n"));
  } catch (err) {
    console.warn(`${FOUNDER_LOG} notifyFounderPaymentStuck failed`, {
      telegramId: notice.telegramId.toString(),
      reason: notice.reason,
      err,
    });
  }
}

/** Prisma `select` for the payer identity block shared by both notifiers. */
const FOUNDER_PAYER_SELECT = {
  id: true,
  firstName: true,
  age: true,
  telegramId: true,
  telegramUsername: true,
  phone: true,
  email: true,
  platform: true,
  ticketBalance: true,
} satisfies Prisma.UserSelect;

type FounderPayer = Prisma.UserGetPayload<{ select: typeof FOUNDER_PAYER_SELECT }>;

/** Who paid — the block the founder actually reads first. */
function payerLines(user: FounderPayer): string[] {
  const name = user.firstName ?? "—";
  const age = user.age != null ? `, ${user.age}` : "";
  const lines = [`👤 ${name}${age}`];

  // A mobile-only account carries a synthetic NEGATIVE telegramId and no
  // username, so the phone is the only handle that exists there.
  const contact: string[] = [];
  if (user.telegramUsername) contact.push(`@${user.telegramUsername}`);
  if (user.phone) contact.push(user.phone);
  if (contact.length === 0 && user.email) contact.push(user.email);
  lines.push(`📞 ${contact.length > 0 ? contact.join(" · ") : "контакта нет"}`);

  if (user.telegramId > 0n) lines.push(`Telegram ID: ${user.telegramId.toString()}`);
  lines.push(`Платформа: ${user.platform} · билетов на счету: ${user.ticketBalance}`);
  lines.push(`ID: ${user.id}`);
  return lines;
}

function providerLabel(provider: FounderPurchaseNotice["provider"]): string {
  if (provider === "telegram_stars") return "Telegram Stars";
  if (provider === "app_store") return "App Store";
  return "без оплаты — демо/dev (деньги не двигались)";
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
      data: {
        token,
        weekOf,
        dataJson: report as unknown as object,
        expiresAt: new Date(Date.now() + FOUNDER_REPORT_TTL_MS),
      },
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
// Feature 6 — weekly ad-spend reminder
// ───────────────────────────────────────────────────────────────────────────

/**
 * A Monday-morning nudge naming the week that just closed, carrying a one-tap
 * link to the founder's mobile ad-spend form
 * (`GET /v1/founder/ad-spend/:token`, `public/routes/founder-ad-spend.ts`).
 *
 * **Why the link is not the dashboard's `/ad-spend` any more.** It was, and on
 * a phone that link went nowhere useful: the dashboard authenticates with a
 * Bearer `ADMIN_API_KEY` held in `sessionStorage`, and Telegram opens links in
 * a fresh in-app browser where that store is always empty. Tapping the
 * reminder meant hunting down the admin key before typing a single number, so
 * in practice the entry waited for a desk — and CAC/ROAS on the dashboard went
 * stale for exactly as long. The tokenized form removes the login step; the
 * dashboard link stays in the message as the second line, because editing
 * history and reading the CAC that comes out of it still belong there.
 *
 * **`weekOf` is derived, not passed.** The caller used to hand in
 * `Date.now() - 7d`, which only landed on a Monday because the cron fires at
 * 09:00 Kyiv; at any hour before 03:00 the same subtraction lands on Sunday in
 * UTC and the reminder would name a Sun–Sat window matching no dashboard entry.
 * `previousUtcWeek` reads the weekday instead, so the message is independent of
 * when the cron runs. An explicit argument is still accepted for tests and for
 * a manual re-send of an older week.
 *
 * The message also states what is ALREADY logged for that week. Without it the
 * reminder is unconditional nagging: a founder who entered Friday's spend on
 * Sunday still gets told on Monday to go do it, which is how a weekly nudge
 * teaches you to ignore it.
 */
export async function notifyFounderAdSpendReminder(weekOf?: Date): Promise<void> {
  const api = getFounderApi();
  if (!api) return;

  try {
    const week = weekOf
      ? { start: startOfUtcDay(weekOf), end: new Date(startOfUtcDay(weekOf).getTime() + 6 * 86_400_000) }
      : previousWeek();
    const { start, end } = week;
    const fmt = (d: Date) =>
      d.toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "long" });

    // Overlap, not containment — the same rule the admin list and the form
    // page use, so "already logged" means the same thing in all three.
    const logged = await prisma.adSpend.findMany({
      where: { periodEnd: { gte: start }, periodStart: { lte: end } },
      select: { channel: true, amountUsdCents: true },
    });

    const lines: string[] = [];
    if (logged.length === 0) {
      lines.push(`💸 Расходы на привлечение за ${fmt(start)} – ${fmt(end)} ещё не внесены.`);
    } else {
      const totalUsd = logged.reduce((sum, r) => sum + r.amountUsdCents, 0);
      const channels = [...new Set(logged.map((r) => r.channel))].join(", ");
      lines.push(
        `💸 Расходы за ${fmt(start)} – ${fmt(end)}: ` +
          `${logged.length} ${plural(logged.length, "запись", "записи", "записей")} ` +
          `на ${formatUsdCents(totalUsd)} (${channels}).`,
        `Если что-то ещё не учтено — добавь:`,
      );
    }

    const token = signAdSpendLink({ weekStart: isoDay(start), weekEnd: isoDay(end) });
    if (token) {
      lines.push(`${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/v1/founder/ad-spend/${token}`);
    }
    if (env.ADMIN_DASHBOARD_URL) {
      lines.push(`Вся история и CAC: ${env.ADMIN_DASHBOARD_URL.replace(/\/+$/, "")}/ad-spend`);
    }
    if (!token && !env.ADMIN_DASHBOARD_URL) {
      lines.push("(ни ADMIN_API_KEY, ни ADMIN_DASHBOARD_URL не заданы — ссылки нет)");
    }

    await api.sendMessage(founderChatId(), lines.join("\n"), {
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.warn(`${FOUNDER_LOG} notifyFounderAdSpendReminder failed`, { err });
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

/**
 * How long a weekly-report link stays live.
 *
 * The token in the URL is the page's sole authorization and the page shows real
 * users' names, photos, cities and attractiveness scores — so the token also
 * sits in reverse-proxy access logs and browser history indefinitely. 90 days
 * (matching the reference-selfie GDPR window) keeps the link usable well past
 * the week it reports on while bounding how long a leaked log line is worth
 * anything.
 */
export const FOUNDER_REPORT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

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
