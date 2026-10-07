import { prisma } from "@gennety/db";
import {
  LEGAL_DOCS_TASTE_HINTS_FROM,
  WISHLIST_CONSENT_VERSION,
  WISHLIST_MAX_ITEMS,
  WISHLIST_NOTE_MAX_LEN,
  WISHLIST_SESSION_MIN_PROFILER_ANSWERS,
  WISHLIST_SESSION_SNOOZE_MS,
  WISHLIST_TITLE_MAX_LEN,
  afterDateGendered,
  afterDateT,
  isWishlistCategory,
  isWishlistPriceBand,
  isWishlistSource,
  profilerOptionText,
  profilerQuestionById,
  profilerQuestionInput,
  wishlistMoreLabel,
  wishlistTeaserIds,
  type Language,
  type WishlistCategory,
  type WishlistPriceBand,
  type WishlistSource,
} from "@gennety/shared";
import { env } from "../config.js";
import { isPremiumActive } from "./premium.js";
import { createProfilePhotoSignedUrl, createWishlistImageSignedUrls } from "./storage.js";
import { copyWishlistImage } from "./wishlist-lookup.js";

/**
 * Date Wishlist (decision journal 2026-10-08) — everything except the web
 * look-ups (`wishlist-lookup.ts`) and the delivery surfaces (routes, Telegram).
 *
 * The owner side: consent, items, and the «Сегодня» session that takes ONE
 * Profiler batch slot (never the first). The viewer side: the offer after
 * mutual interest the morning after (`morning-after.ts`) — the partner's
 * favourite flowers and the cheat sheet, a tenth of it free and the rest for
 * one purchase or with Premium.
 *
 * **Who sees a wishlist.** Only the other side of a match whose
 * `mutualInterestAt` is stamped, and only while the owner's consent stands.
 * Never before mutual interest, never anybody else. A block in either
 * direction closes it.
 */

const IMAGE_URL_TTL_S = 24 * 60 * 60;
const FLOWERS_QUESTION_ID = "f_flowers";
const FLOWERS_FREE_TEXT_MAX = 80;

export interface WishlistItemView {
  id: string;
  category: WishlistCategory;
  title: string;
  brand: string | null;
  note: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  priceBand: WishlistPriceBand | null;
  source: WishlistSource;
}

type ItemRow = {
  id: string;
  category: string;
  title: string;
  brand: string | null;
  note: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  priceBand: string | null;
  source: string;
};

const itemSelect = {
  id: true,
  category: true,
  title: true,
  brand: true,
  note: true,
  imageUrl: true,
  productUrl: true,
  priceBand: true,
  source: true,
} as const;

/** Rows → views, with ONE signing request for every stored image. */
async function viewItems(rows: ItemRow[]): Promise<WishlistItemView[]> {
  const paths = rows.map((row) => row.imageUrl ?? "");
  const signed = paths.some(Boolean)
    ? await createWishlistImageSignedUrls(paths, IMAGE_URL_TTL_S).catch(() => paths.map(() => null))
    : paths.map(() => null);
  return rows.map((row, index) => ({
    id: row.id,
    category: isWishlistCategory(row.category) ? row.category : "gift",
    title: row.title,
    brand: row.brand,
    note: row.note,
    imageUrl: row.imageUrl ? (signed[index] ?? null) : null,
    productUrl: row.productUrl,
    priceBand: isWishlistPriceBand(row.priceBand) ? row.priceBand : null,
    source: isWishlistSource(row.source) ? row.source : "text",
  }));
}

async function loadItems(userId: string): Promise<ItemRow[]> {
  return prisma.wishlistItem.findMany({
    where: { userId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: itemSelect,
  });
}

/* ── owner side ─────────────────────────────────────────────────────────── */

export interface OwnWishlist {
  consent: { given: boolean; version: string; givenVersion: string | null };
  items: WishlistItemView[];
  maxItems: number;
  /** The «Сегодня» session is open right now (`wishlistOfferedAt` and not done). */
  sessionOpen: boolean;
  done: boolean;
}

export async function getOwnWishlist(userId: string): Promise<OwnWishlist | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      wishlistConsentAt: true,
      wishlistConsentVersion: true,
      profile: { select: { wishlistOfferedAt: true, wishlistDoneAt: true } },
    },
  });
  if (!user) return null;
  const items = await viewItems(await loadItems(userId));
  return {
    consent: {
      given: user.wishlistConsentAt != null,
      version: WISHLIST_CONSENT_VERSION,
      givenVersion: user.wishlistConsentVersion,
    },
    items,
    maxItems: WISHLIST_MAX_ITEMS,
    sessionOpen: Boolean(user.profile?.wishlistOfferedAt && !user.profile.wishlistDoneAt),
    done: Boolean(user.profile?.wishlistDoneAt),
  };
}

export async function giveWishlistConsent(userId: string, now: Date = new Date()): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { wishlistConsentAt: now, wishlistConsentVersion: WISHLIST_CONSENT_VERSION },
  });
}

/**
 * Withdraw: the list is hidden from every match at once (the viewer reads
 * consent on each request). Items are kept so a change of heart costs nothing;
 * deleting them is a separate act, item by item or all at once.
 */
export async function withdrawWishlistConsent(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { wishlistConsentAt: null, wishlistConsentVersion: null },
  });
}

export interface WishlistItemInput {
  category: unknown;
  title: unknown;
  brand?: unknown;
  note?: unknown;
  imageUrl?: unknown;
  productUrl?: unknown;
  priceBand?: unknown;
  source: unknown;
  catalogKey?: unknown;
}

export type WishlistItemRefusal = "no-consent" | "bad-item" | "too-many";

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, max) : null;
}

function cleanHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Validate one item; null when it is not something we will store. */
export function normaliseWishlistItem(input: WishlistItemInput): {
  category: WishlistCategory;
  title: string;
  brand: string | null;
  note: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  priceBand: WishlistPriceBand | null;
  source: WishlistSource;
  catalogKey: string | null;
} | null {
  if (!isWishlistCategory(input.category) || !isWishlistSource(input.source)) return null;
  const title = cleanText(input.title, WISHLIST_TITLE_MAX_LEN);
  if (!title) return null;
  return {
    category: input.category,
    title,
    brand: cleanText(input.brand, 60),
    note: cleanText(input.note, WISHLIST_NOTE_MAX_LEN),
    imageUrl: cleanHttpsUrl(input.imageUrl),
    productUrl: cleanHttpsUrl(input.productUrl),
    priceBand: isWishlistPriceBand(input.priceBand) ? input.priceBand : null,
    source: input.source,
    catalogKey: cleanText(input.catalogKey, 60),
  };
}

/**
 * Add confirmed items. Consent first — an item is never stored without it,
 * because storing is what makes it showable. The confirmation card's remote
 * photo is copied into our storage now (a shop's CDN link would rot and would
 * tell the shop who looked); a photo that cannot be copied leaves the item
 * without one rather than failing it.
 */
export async function addWishlistItems(
  userId: string,
  inputs: WishlistItemInput[],
): Promise<{ ok: true; items: WishlistItemView[] } | { ok: false; error: WishlistItemRefusal }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { wishlistConsentAt: true },
  });
  if (!user?.wishlistConsentAt) return { ok: false, error: "no-consent" };

  const items = inputs.map(normaliseWishlistItem);
  if (items.length === 0 || items.some((item) => item === null)) {
    return { ok: false, error: "bad-item" };
  }
  const existing = await prisma.wishlistItem.count({ where: { userId } });
  if (existing + items.length > WISHLIST_MAX_ITEMS) return { ok: false, error: "too-many" };

  const stored = await Promise.all(
    items.map(async (item) => ({
      ...item!,
      imageUrl: item!.imageUrl ? await copyWishlistImage(userId, item!.imageUrl).catch(() => null) : null,
    })),
  );
  await prisma.wishlistItem.createMany({
    data: stored.map((item, index) => ({
      userId,
      category: item.category,
      title: item.title,
      brand: item.brand,
      note: item.note,
      imageUrl: item.imageUrl,
      productUrl: item.productUrl,
      priceBand: item.priceBand,
      source: item.source,
      catalogKey: item.catalogKey,
      position: existing + index,
    })),
  });
  return { ok: true, items: await viewItems(await loadItems(userId)) };
}

export async function deleteWishlistItem(userId: string, itemId: string): Promise<boolean> {
  const { count } = await prisma.wishlistItem.deleteMany({ where: { id: itemId, userId } });
  return count > 0;
}

/** Every stored image path of a user — for account deletion's storage sweep. */
export async function wishlistImagePaths(userId: string): Promise<string[]> {
  const rows = await prisma.wishlistItem.findMany({
    where: { userId, imageUrl: { not: null } },
    select: { imageUrl: true },
  });
  return rows.map((row) => row.imageUrl!).filter(Boolean);
}

/* ── the «Сегодня» session (a Profiler slot) ────────────────────────────── */

/**
 * Whether the wishlist may take the batch slot that is due now. Never the
 * first batches (`WISHLIST_SESSION_MIN_PROFILER_ANSWERS`), never twice once
 * done, not while snoozed, and only in the app — the session has no Telegram
 * surface.
 */
export async function wishlistSessionEligible(userId: string, now: Date = new Date()): Promise<boolean> {
  if (!env.WISHLIST_FEATURE_ENABLED) return false;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      platform: true,
      profile: {
        select: { wishlistOfferedAt: true, wishlistDoneAt: true, wishlistSnoozedUntil: true },
      },
    },
  });
  const profile = user?.profile;
  if (!user || !profile) return false;
  if (user.platform !== "mobile" && user.platform !== "both") return false;
  if (profile.wishlistDoneAt || profile.wishlistOfferedAt) return false;
  if (profile.wishlistSnoozedUntil && profile.wishlistSnoozedUntil.getTime() > now.getTime()) {
    return false;
  }
  const answered = await prisma.profilerAnswer.count({
    where: { userId, answerText: { not: null } },
  });
  return answered >= WISHLIST_SESSION_MIN_PROFILER_ANSWERS;
}

/** Claim the slot for the wishlist (CAS on `wishlistOfferedAt`). */
export async function openWishlistSession(userId: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await prisma.profile.updateMany({
    where: { userId, wishlistOfferedAt: null, wishlistDoneAt: null },
    data: { wishlistOfferedAt: now },
  });
  return count === 1;
}

export async function wishlistSessionOpen(userId: string): Promise<boolean> {
  if (!env.WISHLIST_FEATURE_ENABLED) return false;
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { wishlistOfferedAt: true, wishlistDoneAt: true },
  });
  return Boolean(profile?.wishlistOfferedAt && !profile.wishlistDoneAt);
}

export type WishlistSessionAction = "done" | "later";

/**
 * Close the session. `done` needs at least one item (an empty "Готово" is a
 * «Позже» in disguise and is refused so the app says so); `later` releases the
 * slot and lets the session come back after `WISHLIST_SESSION_SNOOZE_MS`.
 */
export async function resolveWishlistSession(
  userId: string,
  action: WishlistSessionAction,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; error: "empty" | "not-open" }> {
  if (action === "done") {
    const items = await prisma.wishlistItem.count({ where: { userId } });
    if (items === 0) return { ok: false, error: "empty" };
    await prisma.profile.updateMany({
      where: { userId },
      data: { wishlistDoneAt: now, wishlistSnoozedUntil: null },
    });
    return { ok: true };
  }
  const { count } = await prisma.profile.updateMany({
    where: { userId, wishlistOfferedAt: { not: null }, wishlistDoneAt: null },
    data: {
      wishlistOfferedAt: null,
      wishlistSnoozedUntil: new Date(now.getTime() + WISHLIST_SESSION_SNOOZE_MS),
    },
  });
  return count === 1 ? { ok: true } : { ok: false, error: "not-open" };
}

/* ── viewer side: the offer after mutual interest ───────────────────────── */

export interface WishlistSheet {
  /** Items on the list right now. */
  total: number;
  unlocked: boolean;
  /** All items when unlocked; else only the free teaser. */
  items: WishlistItemView[];
  lockedCount: number;
  /** «Ещё 5 позиций», localised; null when nothing is locked. */
  lockedLabel: string | null;
  priceStars: number;
  /** StoreKit consumable id, or null while the App Store rail is off. */
  appStoreProductId: string | null;
  /** The viewer has Premium — opening is free. */
  premiumIncluded: boolean;
}

export interface MutualOffer {
  matchId: string;
  mutualAt: Date;
  partner: { firstName: string | null; gender: string | null; photoUrl: string | null };
  title: string;
  body: string;
  timing: string;
  gift: string;
  /** «Её любимые цветы: Пионы, Белые тюльпаны», or null. */
  flowersHint: string | null;
  /** «Анна добавила идеи…», or null when there is no sheet to offer. */
  wishlistLine: string | null;
  wishlist: WishlistSheet | null;
}

export type OfferRefusal = "not-found" | "not-mutual";

type Partner = {
  id: string;
  firstName: string | null;
  gender: string | null;
  policyVersion: string | null;
  wishlistConsentAt: Date | null;
  profile: { photos: string[] } | null;
};

/**
 * A block OR a report in either direction closes the offer (DPIA 2026-10-08,
 * action 12): someone who reported their date must not have their wishlist
 * sold to that person, and a reported person must not be invited to send
 * gifts. A report is enough on its own — reporting without blocking is common.
 */
async function blockedBetween(a: string, b: string): Promise<boolean> {
  const [block, report] = await Promise.all([
    prisma.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
      select: { id: true },
    }),
    prisma.report.findFirst({
      where: {
        OR: [
          { reporterId: a, reportedId: b },
          { reporterId: b, reportedId: a },
        ],
      },
      select: { id: true },
    }),
  ]);
  return block != null || report != null;
}

/** The pair, the viewer's side and the partner — or why not. */
async function loadMutualPair(
  matchId: string,
  viewerId: string,
): Promise<{ ok: true; mutualAt: Date; partner: Partner } | { ok: false; error: OfferRefusal }> {
  const partnerSelect = {
    id: true,
    firstName: true,
    gender: true,
    policyVersion: true,
    wishlistConsentAt: true,
    profile: { select: { photos: true } },
  } as const;
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      userAId: true,
      userBId: true,
      mutualInterestAt: true,
      userA: { select: partnerSelect },
      userB: { select: partnerSelect },
    },
  });
  if (!match || (match.userAId !== viewerId && match.userBId !== viewerId)) {
    return { ok: false, error: "not-found" };
  }
  if (!match.mutualInterestAt) return { ok: false, error: "not-mutual" };
  const partner = match.userAId === viewerId ? match.userB : match.userA;
  if (await blockedBetween(viewerId, partner.id)) return { ok: false, error: "not-found" };
  return { ok: true, mutualAt: match.mutualInterestAt, partner };
}

/**
 * The partner's favourite flowers as a hint, in the viewer's language. Only
 * when the partner accepted the policy that discloses taste hints, or gave the
 * wishlist consent (whose text names this too) — someone who answered under
 * an older policy never had it explained, so their answer stays private.
 */
async function flowersHint(partner: Partner, language: Language): Promise<string | null> {
  const disclosed =
    partner.wishlistConsentAt != null ||
    (partner.policyVersion != null && partner.policyVersion >= LEGAL_DOCS_TASTE_HINTS_FROM);
  if (!disclosed) return null;
  const answer = await prisma.profilerAnswer.findFirst({
    where: { userId: partner.id, questionId: FLOWERS_QUESTION_ID, skipped: false },
    select: { answerText: true, optionIds: true },
  });
  if (!answer) return null;
  const question = profilerQuestionById(FLOWERS_QUESTION_ID);
  const options = question ? (profilerQuestionInput(question)?.options ?? []) : [];
  const picked = (answer.optionIds ?? [])
    .map((id) => options.find((option) => option.id === id))
    .filter((option): option is NonNullable<typeof option> => option != null)
    .map((option) => profilerOptionText(option, language));
  // A tapped answer reads cleanly in the viewer's language; free text is the
  // partner's own words and is only shown when nothing was tapped.
  const text =
    picked.length > 0
      ? picked.join(", ")
      : (answer.answerText ?? "").replace(/\s+/gu, " ").trim().slice(0, FLOWERS_FREE_TEXT_MAX);
  if (!text) return null;
  return afterDateGendered(language, "flowersHint", partner.gender, { flowers: text });
}

/** Whether the viewer may see the whole sheet; Premium writes its unlock row. */
async function sheetUnlocked(matchId: string, viewerId: string, ownerId: string, now: Date): Promise<{
  unlocked: boolean;
  premium: boolean;
}> {
  const row = await prisma.wishlistUnlock.findUnique({
    where: { matchId_userId: { matchId, userId: viewerId } },
    select: { refundedAt: true },
  });
  const premium = await isPremiumActive(viewerId, now);
  if (row && !row.refundedAt) return { unlocked: true, premium };
  if (premium && !row) {
    // Written so the sheet stays open after Premium lapses: Premium "opens"
    // it, it does not rent it. A refunded purchase is not re-opened this way.
    await prisma.wishlistUnlock
      .create({ data: { matchId, userId: viewerId, ownerId, provider: "premium" } })
      .catch(() => undefined);
    return { unlocked: true, premium };
  }
  return { unlocked: false, premium };
}

async function buildSheet(
  matchId: string,
  viewerId: string,
  partner: Partner,
  language: Language,
  now: Date,
): Promise<WishlistSheet | null> {
  if (!env.WISHLIST_FEATURE_ENABLED || !partner.wishlistConsentAt) return null;
  const rows = await loadItems(partner.id);
  if (rows.length === 0) return null;
  const { unlocked, premium } = await sheetUnlocked(matchId, viewerId, partner.id, now);
  const teaser = new Set(wishlistTeaserIds(rows));
  const shown = unlocked ? rows : rows.filter((row) => teaser.has(row.id));
  const lockedCount = rows.length - shown.length;
  return {
    total: rows.length,
    unlocked,
    items: await viewItems(shown),
    lockedCount,
    lockedLabel: lockedCount > 0 ? wishlistMoreLabel(language, lockedCount) : null,
    priceStars: env.WISHLIST_UNLOCK_STARS,
    appStoreProductId: env.WISHLIST_APPSTORE_ENABLED ? env.WISHLIST_APPSTORE_PRODUCT_ID : null,
    premiumIncluded: premium,
  };
}

export async function mutualOfferFor(
  matchId: string,
  viewerId: string,
  language: Language,
  now: Date = new Date(),
): Promise<{ ok: true; offer: MutualOffer } | { ok: false; error: OfferRefusal }> {
  const pair = await loadMutualPair(matchId, viewerId);
  if (!pair.ok) return pair;
  const { partner } = pair;
  const name = partner.firstName ?? "";
  const [flowers, wishlist, photoUrl] = await Promise.all([
    flowersHint(partner, language),
    buildSheet(matchId, viewerId, partner, language, now),
    partner.profile?.photos?.[0]
      ? createProfilePhotoSignedUrl(partner.profile.photos[0], 60 * 60).catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    ok: true,
    offer: {
      matchId,
      mutualAt: pair.mutualAt,
      partner: { firstName: partner.firstName, gender: partner.gender, photoUrl },
      title: afterDateT(language, "mutualTitle"),
      body: afterDateGendered(language, "mutualBody", partner.gender, { name }),
      timing: afterDateT(language, "mutualTiming"),
      gift: afterDateT(language, "mutualGift"),
      flowersHint: flowers,
      wishlistLine: wishlist
        ? afterDateGendered(language, "wishlistOffer", partner.gender, { name })
        : null,
      wishlist,
    },
  };
}

/* ── purchases ──────────────────────────────────────────────────────────── */

export type UnlockRefusal = OfferRefusal | "no-sheet" | "already-unlocked";

/**
 * May `viewerId` buy the sheet of `matchId` now? Checked at invoice time, at
 * pre-checkout (links are reusable) and again at settle.
 */
export async function wishlistPurchasable(
  matchId: string,
  viewerId: string,
): Promise<{ ok: true; ownerId: string } | { ok: false; error: UnlockRefusal }> {
  if (!env.WISHLIST_FEATURE_ENABLED) return { ok: false, error: "no-sheet" };
  const pair = await loadMutualPair(matchId, viewerId);
  if (!pair.ok) return pair;
  if (!pair.partner.wishlistConsentAt) return { ok: false, error: "no-sheet" };
  const items = await prisma.wishlistItem.count({ where: { userId: pair.partner.id } });
  if (items === 0) return { ok: false, error: "no-sheet" };
  const row = await prisma.wishlistUnlock.findUnique({
    where: { matchId_userId: { matchId, userId: viewerId } },
    select: { refundedAt: true },
  });
  if (row && !row.refundedAt) return { ok: false, error: "already-unlocked" };
  return { ok: true, ownerId: pair.partner.id };
}

/**
 * Record a paid unlock. Idempotent on the provider's payment id (a redelivered
 * Stars update, a re-reported App Store transaction). A refunded earlier
 * unlock for the same pair is replaced by the new purchase.
 */
export async function recordWishlistUnlock(input: {
  matchId: string;
  viewerId: string;
  ownerId: string;
  provider: "telegram_stars" | "app_store";
  externalPaymentId: string;
  amountStars?: number | null;
  amountCents?: number | null;
}): Promise<"created" | "duplicate"> {
  const seen = await prisma.wishlistUnlock.findUnique({
    where: { externalPaymentId: input.externalPaymentId },
    select: { id: true },
  });
  if (seen) return "duplicate";
  await prisma.wishlistUnlock.deleteMany({
    where: { matchId: input.matchId, userId: input.viewerId, refundedAt: { not: null } },
  });
  try {
    await prisma.wishlistUnlock.create({
      data: {
        matchId: input.matchId,
        userId: input.viewerId,
        ownerId: input.ownerId,
        provider: input.provider,
        externalPaymentId: input.externalPaymentId,
        amountStars: input.amountStars ?? null,
        amountCents: input.amountCents ?? null,
      },
    });
    return "created";
  } catch {
    // The pair unique: a parallel request (or a Premium row) got there first.
    return "duplicate";
  }
}

/** An App Store REFUND / revoke for a consumable we recorded. */
export async function markWishlistUnlockRefunded(
  externalPaymentId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await prisma.wishlistUnlock.updateMany({
    where: { externalPaymentId, refundedAt: null },
    data: { refundedAt: now },
  });
  return count > 0;
}
