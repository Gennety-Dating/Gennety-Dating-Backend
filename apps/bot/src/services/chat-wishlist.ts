import { prisma, type Prisma } from "@gennety/db";
import {
  CHAT_WISHLIST_CARD_MAX_ITEMS,
  CHAT_WISHLIST_CARD_MAX_LOOKUPS,
  CHAT_WISHLIST_LOOKUP_TIMEOUT_MS,
  WISHLIST_CATEGORIES,
  WISHLIST_MAX_ITEMS,
  WISHLIST_NOTE_MAX_LEN,
  WISHLIST_TITLE_MAX_LEN,
  isWishlistCategory,
  isWishlistPriceBand,
  type Language,
  type WishlistCategory,
  type WishlistPriceBand,
} from "@gennety/shared";
import { env } from "../config.js";
import {
  createChatImageSignedUrls,
  deleteStorageObject,
  downloadChatImage,
  uploadWishlistImage,
} from "./storage.js";
import { lookupWishlistEntry, type WishlistCandidate, type WishlistLookupResult } from "./wishlist-lookup.js";
import { addWishlistItems, type WishlistItemInput } from "./wishlist.js";

/**
 * The chat agent's wishlist card (decision journal 2026-10-15).
 *
 * The founder sent the app's agent five photos of his favourite perfumes and
 * the agent had nowhere to put them: the Date Wishlist existed, but only as a
 * session on «Сегодня». Now the agent recognises what a person shares — a
 * photo of the thing, a shop screenshot, a link, "хочу X" — and shows a native
 * card under its reply: the items with pictures, all ticked, one «Add» button.
 *
 * **The tap is the consent.** `propose_wishlist_items` writes nothing; it
 * builds the card and stores it on the assistant row (`messages.attachment`).
 * Only `POST /v1/chat/messages/:id/wishlist` saves, with the keys the person
 * left ticked. So the consent gate of profile writes (`chat-consent.ts`) has
 * nothing to guard here, and "вот мои любимые духи" — which must NOT become a
 * profile write — is exactly the moment to show this card.
 *
 * **Pictures.** A clear photo of the thing itself is the person's own photo
 * (copied into the wishlist key on save — the chat copy stays the chat's). A
 * link is read for its page photo; a screenshot or a messy photo is looked up
 * online for a clean product shot, the person's photo being the fallback. The
 * look-ups run inside the reply, so they are few and short
 * (`CHAT_WISHLIST_CARD_MAX_LOOKUPS`, `CHAT_WISHLIST_LOOKUP_TIMEOUT_MS`).
 *
 * **Stored, not ephemeral.** Unlike the one-button `action`, the card is
 * stored with its state (open → saved | dismissed), so it survives a reload,
 * and the next turn's model reads what was saved (`wishlistCardNote`).
 */

export const WISHLIST_CARD_KIND = "wishlist_proposal";
/** Token an app build lists in `X-Gennety-Chat-Cards` when it draws this card. */
export const WISHLIST_CARD_CLIENT_TOKEN = "wishlist";
export const PROPOSE_WISHLIST_TOOL_NAME = "propose_wishlist_items";

/** Signed photos in a card: long enough for a chat left open, short enough to rot. */
const CARD_PHOTO_TTL_S = 60 * 60;
const BRAND_MAX_LEN = 60;

export type WishlistCardState = "open" | "saved" | "dismissed";
/** Stored sources stay the four the wishlist knows — an app decodes nothing new. */
type CardItemSource = "text" | "link" | "search";

export interface WishlistCardItem {
  /** `i1`, `i2`… — what the app sends back to save a subset. */
  key: string;
  title: string;
  brand: string | null;
  category: WishlistCategory;
  /** The person's own words about it. */
  note: string | null;
  /** Their chat photo (`{userId}/{ts}.ext`), when it is the picture. */
  photoPath: string | null;
  /** A shop's page photo (og:image) — shown as is, copied into storage on save. */
  remoteImageUrl: string | null;
  productUrl: string | null;
  priceBand: WishlistPriceBand | null;
  source: CardItemSource;
}

export interface WishlistCard {
  kind: typeof WISHLIST_CARD_KIND;
  state: WishlistCardState;
  items: WishlistCardItem[];
  /** Keys saved by the tap; empty until then. */
  savedKeys: string[];
  resolvedAt: string | null;
}

/** What the app gets — `ChatWishlistCard` in the OpenAPI contract. */
export interface WishlistCardView {
  kind: typeof WISHLIST_CARD_KIND;
  state: WishlistCardState;
  items: Array<{
    key: string;
    title: string;
    brand: string | null;
    category: WishlistCategory;
    /** https to draw: a signed photo of theirs, or the shop's page photo. */
    imageUrl: string | null;
    productUrl: string | null;
    priceBand: WishlistPriceBand | null;
    saved: boolean;
  }>;
  savedCount: number;
}

/* ── the tool ───────────────────────────────────────────────────────────── */

export const PROPOSE_WISHLIST_TOOL = {
  type: "function" as const,
  function: {
    name: PROPOSE_WISHLIST_TOOL_NAME,
    description:
      "Show a native card under your reply that proposes items for their Date Wishlist — concrete things they would love to get, try or go to (a perfume, flowers, a drink or dish, a place, jewellery, clothes, a gift, an experience). The card has an «Add» button and NOTHING is saved until they tap it, so call it in the same reply whenever they share such things — photos, a shop screenshot, a link, «хочу / мечтаю / обожаю X» — or ask to add something. One call per reply with every item. Never for portraits, people, memes or hobbies in general.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: CHAT_WISHLIST_CARD_MAX_ITEMS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "category", "image"],
            properties: {
              title: {
                type: "string",
                description: "The thing's exact name as you can read it (product, flower, dish, place), without the brand.",
              },
              brand: { type: ["string", "null"], description: "Brand or maker, when known." },
              category: { type: "string", enum: [...WISHLIST_CATEGORIES] },
              note: {
                type: ["string", "null"],
                description: "Their own words about it, one short phrase in their language (e.g. «самый любимый»). Null if they said nothing.",
              },
              photo: {
                type: ["string", "null"],
                description: "The [imageUrl=…] token value of the photo that shows this item, if any.",
              },
              link: { type: ["string", "null"], description: "The https link they sent for this item, if any." },
              image: {
                type: "string",
                enum: ["photo", "find", "none"],
                description:
                  "photo = their photo is the picture (a clear shot of the thing itself, no faces); find = look the product up online for a clean picture (a screenshot, a collage, a photo with people or clutter, or no photo); none = no picture.",
              },
            },
          },
        },
      },
    },
  },
};

interface ParsedItem {
  title: string;
  brand: string | null;
  category: WishlistCategory;
  note: string | null;
  photo: string | null;
  link: string | null;
  image: "photo" | "find" | "none";
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, max) : null;
}

function cleanLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseItems(raw: unknown, visiblePhotos: ReadonlySet<string>): ParsedItem[] {
  const list = raw && typeof raw === "object" ? (raw as { items?: unknown }).items : null;
  if (!Array.isArray(list)) return [];
  const out: ParsedItem[] = [];
  for (const entry of list.slice(0, CHAT_WISHLIST_CARD_MAX_ITEMS)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const title = cleanText(item.title, WISHLIST_TITLE_MAX_LEN);
    if (!title) continue;
    // A photo the model names must be one it was shown in THIS chat — never a
    // path it made up or one from another person.
    const photo = typeof item.photo === "string" && visiblePhotos.has(item.photo.trim()) ? item.photo.trim() : null;
    const image = item.image === "find" || item.image === "none" ? item.image : "photo";
    out.push({
      title,
      brand: cleanText(item.brand, BRAND_MAX_LEN),
      category: isWishlistCategory(item.category) ? item.category : "gift",
      note: cleanText(item.note, WISHLIST_NOTE_MAX_LEN),
      photo,
      link: cleanLink(item.link),
      image,
    });
  }
  return out;
}

/** Brand + title, case- and punctuation-folded — "the same thing" for de-duplication. */
export function wishlistIdentity(title: string, brand: string | null): string {
  const fold = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const t = fold(title);
  const b = brand ? fold(brand) : "";
  // "Santal 33" with brand "Le Labo" and "Le Labo Santal 33" without one are
  // the same bottle.
  return b && !t.startsWith(b) ? `${b} ${t}` : t;
}

export interface ProposeDeps {
  lookup: (input: Parameters<typeof lookupWishlistEntry>[0]) => Promise<WishlistLookupResult>;
  existingItems: (userId: string) => Promise<Array<{ title: string; brand: string | null }>>;
}

const defaultProposeDeps: ProposeDeps = {
  lookup: lookupWishlistEntry,
  existingItems: (userId) =>
    prisma.wishlistItem.findMany({ where: { userId }, select: { title: true, brand: true } }),
};

export interface ProposeContext {
  userId: string;
  language: Language;
  cityKey: string | null;
  /** Chat photo paths the model was shown this turn (current and earlier rows). */
  visiblePhotos: ReadonlySet<string>;
}

export interface ProposeOutcome {
  /** The tool result the model reads. */
  result: string;
  card: WishlistCard | null;
  /** «Мой вишлист» button when the list is full. */
  openWishlist: boolean;
}

/**
 * Build the card for `propose_wishlist_items`. Writes nothing: the caller
 * stores the card on the assistant row it is about to write.
 */
export async function proposeWishlistItems(
  raw: unknown,
  ctx: ProposeContext,
  deps: ProposeDeps = defaultProposeDeps,
): Promise<ProposeOutcome> {
  const parsed = parseItems(raw, ctx.visiblePhotos);
  if (parsed.length === 0) {
    return {
      result: JSON.stringify({ success: false, error: "no_items", detail: "Every item needs at least a title." }),
      card: null,
      openWishlist: false,
    };
  }

  const existing = await deps.existingItems(ctx.userId);
  const known = new Set(existing.map((row) => wishlistIdentity(row.title, row.brand)));
  const already: string[] = [];
  const fresh: ParsedItem[] = [];
  for (const item of parsed) {
    const id = wishlistIdentity(item.title, item.brand);
    if (known.has(id)) {
      already.push(item.title);
      continue;
    }
    known.add(id);
    fresh.push(item);
  }

  const room = Math.max(0, WISHLIST_MAX_ITEMS - existing.length);
  if (fresh.length === 0) {
    return {
      result: JSON.stringify({
        success: false,
        error: "already_in_wishlist",
        alreadyInWishlist: already,
        instruction: "All of these are already in their wishlist — no card. Say so warmly in a few words.",
      }),
      card: null,
      openWishlist: false,
    };
  }
  if (room === 0) {
    return {
      result: JSON.stringify({
        success: false,
        error: "wishlist_full",
        instruction: `Their wishlist is full (${WISHLIST_MAX_ITEMS} items) — nothing can be added. React to what they shared, then say they can make room in «Мой вишлист» (a button to it is under your reply).`,
      }),
      card: null,
      openWishlist: true,
    };
  }
  const taken = fresh.slice(0, room);

  let lookupsLeft = CHAT_WISHLIST_CARD_MAX_LOOKUPS;
  const items = await Promise.all(
    taken.map(async (item, index): Promise<WishlistCardItem> => {
      const base: WishlistCardItem = {
        key: `i${index + 1}`,
        title: item.title,
        brand: item.brand,
        category: item.category,
        note: item.note,
        photoPath: item.image === "none" ? null : item.photo,
        remoteImageUrl: null,
        productUrl: item.link,
        priceBand: null,
        source: item.link ? "link" : "text",
      };
      const wantsLookup = Boolean(item.link) || item.image === "find";
      if (!wantsLookup || lookupsLeft <= 0) return base;
      lookupsLeft -= 1;
      const found = await deps
        .lookup({
          userId: ctx.userId,
          kind: item.link ? "url" : "query",
          value: item.link ?? [item.brand, item.title].filter(Boolean).join(" "),
          category: item.category,
          language: ctx.language,
          cityKey: ctx.cityKey,
          timeoutMs: CHAT_WISHLIST_LOOKUP_TIMEOUT_MS,
        })
        .catch((): WishlistLookupResult => ({ ok: false, error: "unavailable" }));
      const candidate = found.ok ? pickCandidate(found.candidates) : null;
      if (!candidate) return base;
      if (item.link) {
        // A page we read names the thing better than a guess from the message.
        return {
          ...base,
          title: candidate.title || base.title,
          brand: candidate.brand ?? base.brand,
          category: candidate.category,
          remoteImageUrl: candidate.imageUrl,
          // A page photo replaces theirs only when there is one.
          photoPath: candidate.imageUrl ? null : base.photoPath,
          productUrl: candidate.productUrl ?? base.productUrl,
          priceBand: candidate.priceBand,
          source: "link",
        };
      }
      // A search found the product: its clean photo and page, but the name the
      // person's own photo or words gave — the search may name a sibling.
      return candidate.imageUrl
        ? {
            ...base,
            remoteImageUrl: candidate.imageUrl,
            photoPath: null,
            productUrl: candidate.productUrl,
            priceBand: candidate.priceBand,
            source: "search",
          }
        : base;
    }),
  );

  const card: WishlistCard = {
    kind: WISHLIST_CARD_KIND,
    state: "open",
    items,
    savedKeys: [],
    resolvedAt: null,
  };
  return {
    result: JSON.stringify({
      success: true,
      card: "shown",
      items: items.map((item) => [item.brand, item.title].filter(Boolean).join(" ")),
      ...(already.length > 0 ? { alreadyInWishlist: already } : {}),
      ...(fresh.length > taken.length ? { leftOutNoRoom: fresh.length - taken.length } : {}),
      instruction:
        "A card with these items and an «Add» button is now under your reply; nothing is saved until they tap it. Your reply: a real reaction to what they shared (one or two sentences, name a thing or two), then one short line pointing at the card, like «добавить в вишлист?». Don't list every item, don't say anything is saved, no second offer in this reply.",
    }),
    card,
    openWishlist: false,
  };
}

function pickCandidate(candidates: WishlistCandidate[]): WishlistCandidate | null {
  return candidates.find((candidate) => candidate.imageUrl) ?? candidates[0] ?? null;
}

/* ── reading a stored card ──────────────────────────────────────────────── */

/** The stored JSON as a card, or null for anything that is not one. */
export function readWishlistCard(raw: unknown): WishlistCard | null {
  if (!raw || typeof raw !== "object") return null;
  const card = raw as Partial<WishlistCard>;
  if (card.kind !== WISHLIST_CARD_KIND || !Array.isArray(card.items)) return null;
  const state: WishlistCardState =
    card.state === "saved" || card.state === "dismissed" ? card.state : "open";
  const items = card.items.filter(
    (item): item is WishlistCardItem =>
      Boolean(item) && typeof item.key === "string" && typeof item.title === "string",
  );
  return {
    kind: WISHLIST_CARD_KIND,
    state,
    items: items.map((item) => ({
      ...item,
      category: isWishlistCategory(item.category) ? item.category : "gift",
      priceBand: isWishlistPriceBand(item.priceBand) ? item.priceBand : null,
    })),
    savedKeys: Array.isArray(card.savedKeys) ? card.savedKeys.filter((key) => typeof key === "string") : [],
    resolvedAt: typeof card.resolvedAt === "string" ? card.resolvedAt : null,
  };
}

/**
 * Cards → what the app draws, signing every photo of every card in ONE
 * Storage request (a history page may carry several cards).
 */
export async function wishlistCardViews(cards: WishlistCard[]): Promise<WishlistCardView[]> {
  const paths = cards.flatMap((card) => card.items.map((item) => item.photoPath ?? ""));
  const signed = paths.some(Boolean)
    ? await createChatImageSignedUrls(paths, CARD_PHOTO_TTL_S).catch(() => paths.map(() => null))
    : paths.map(() => null);
  let cursor = 0;
  return cards.map((card) => {
    const saved = new Set(card.savedKeys);
    return {
      kind: WISHLIST_CARD_KIND,
      state: card.state,
      items: card.items.map((item) => {
        const photo = signed[cursor++] ?? null;
        return {
          key: item.key,
          title: item.title,
          brand: item.brand,
          category: item.category,
          imageUrl: (item.photoPath ? photo : null) ?? item.remoteImageUrl,
          productUrl: item.productUrl,
          priceBand: item.priceBand,
          saved: saved.has(item.key),
        };
      }),
      savedCount: saved.size,
    };
  });
}

/**
 * What the model reads under its own earlier reply: the card and its answer.
 * Without it the next turn would not know whether "да" was already tapped.
 */
export function wishlistCardNote(card: WishlistCard): string {
  const name = (item: WishlistCardItem) => `«${[item.brand, item.title].filter(Boolean).join(" ")}»`;
  const all = card.items.map(name).join(", ");
  if (card.state === "saved") {
    const saved = card.items.filter((item) => card.savedKeys.includes(item.key));
    const skipped = card.items.filter((item) => !card.savedKeys.includes(item.key));
    return `[Card under this reply: wishlist items ${all}. They tapped «Add» — saved to their wishlist: ${saved.map(name).join(", ") || "nothing"}${skipped.length > 0 ? `; left out: ${skipped.map(name).join(", ")}` : ""}.]`;
  }
  if (card.state === "dismissed") {
    return `[Card under this reply: wishlist items ${all}. They tapped «Not now» — nothing saved. Don't offer these again unless they ask.]`;
  }
  return `[Card under this reply: wishlist items ${all} with an «Add» button. Not tapped yet — nothing saved so far. If they say yes in words, point them to the card's button.]`;
}

/* ── the tap ────────────────────────────────────────────────────────────── */

export type ResolveRefusal = "not-found" | "bad-request" | "too-many" | "unavailable";

export type ResolveResult =
  | { ok: true; card: WishlistCard }
  | { ok: false; error: ResolveRefusal; room?: number };

export interface ResolveDeps {
  findRow: (userId: string, messageId: string) => Promise<{ attachment: unknown } | null>;
  saveCard: (messageId: string, card: WishlistCard) => Promise<void>;
  countItems: (userId: string) => Promise<number>;
  existingItems: (userId: string) => Promise<Array<{ title: string; brand: string | null }>>;
  copyChatPhoto: (userId: string, chatPath: string) => Promise<string | null>;
  addItems: typeof addWishlistItems;
}

/** The person's chat photo, copied under their own wishlist key; null on any failure. */
export async function copyChatPhotoToWishlist(userId: string, chatPath: string): Promise<string | null> {
  const match = /^([0-9a-f-]{36})\/\d{1,20}\.(jpg|png|webp)$/i.exec(chatPath);
  if (match?.[1]?.toLowerCase() !== userId.toLowerCase()) return null;
  const buffer = await downloadChatImage(chatPath);
  if (!buffer) return null;
  const ext = match[2]!.toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  try {
    return (await uploadWishlistImage(userId, buffer, mime)).path;
  } catch (err) {
    console.warn("[chat-wishlist] photo copy failed:", err);
    return null;
  }
}

const defaultResolveDeps: ResolveDeps = {
  findRow: (userId, messageId) =>
    prisma.message.findFirst({ where: { id: messageId, userId, role: "assistant" }, select: { attachment: true } }),
  saveCard: async (messageId, card) => {
    await prisma.message.update({
      where: { id: messageId },
      data: { attachment: card as unknown as Prisma.InputJsonValue },
    });
  },
  countItems: (userId) => prisma.wishlistItem.count({ where: { userId } }),
  existingItems: defaultProposeDeps.existingItems,
  copyChatPhoto: copyChatPhotoToWishlist,
  addItems: addWishlistItems,
};

/** One tap per card at a time — a double tap must not save the items twice. */
const cardLocks = new Map<string, Promise<unknown>>();

/**
 * «Add» (with the keys left ticked) or «Not now» on a card. Idempotent: a
 * second «Add» answers the saved card; «Not now» on a saved card changes
 * nothing; «Add» after «Not now» is a change of mind and saves.
 */
export async function resolveWishlistCard(
  userId: string,
  messageId: string,
  input: { action: "save"; keys: string[] } | { action: "dismiss" },
  deps: ResolveDeps = defaultResolveDeps,
  now: Date = new Date(),
): Promise<ResolveResult> {
  const previous = cardLocks.get(messageId) ?? Promise.resolve();
  const run = previous.then(() => resolveInner(userId, messageId, input, deps, now));
  const chain = run.catch(() => undefined);
  cardLocks.set(messageId, chain);
  try {
    return await run;
  } finally {
    if (cardLocks.get(messageId) === chain) cardLocks.delete(messageId);
  }
}

async function resolveInner(
  userId: string,
  messageId: string,
  input: { action: "save"; keys: string[] } | { action: "dismiss" },
  deps: ResolveDeps,
  now: Date,
): Promise<ResolveResult> {
  const row = await deps.findRow(userId, messageId);
  const card = readWishlistCard(row?.attachment);
  if (!card) return { ok: false, error: "not-found" };

  if (input.action === "dismiss") {
    if (card.state !== "open") return { ok: true, card };
    const dismissed: WishlistCard = { ...card, state: "dismissed", resolvedAt: now.toISOString() };
    await deps.saveCard(messageId, dismissed);
    return { ok: true, card: dismissed };
  }

  if (card.state === "saved") return { ok: true, card };
  const wanted = new Set(input.keys);
  const picked = card.items.filter((item) => wanted.has(item.key));
  if (picked.length === 0) return { ok: false, error: "bad-request" };

  // Saved meanwhile through «Мой вишлист» or an earlier card: counts as saved,
  // stored once.
  const existing = await deps.existingItems(userId);
  const known = new Set(existing.map((item) => wishlistIdentity(item.title, item.brand)));
  const toAdd = picked.filter((item) => !known.has(wishlistIdentity(item.title, item.brand)));
  const room = WISHLIST_MAX_ITEMS - existing.length;
  if (toAdd.length > room) return { ok: false, error: "too-many", room: Math.max(0, room) };

  if (toAdd.length > 0) {
    // Copied before the insert; a photo that cannot be copied falls back to the
    // shop photo, then to none — never fails the save.
    const inputs: WishlistItemInput[] = await Promise.all(
      toAdd.map(async (item) => {
        const imagePath = item.photoPath ? await deps.copyChatPhoto(userId, item.photoPath) : null;
        return {
          category: item.category,
          title: item.title,
          brand: item.brand,
          note: item.note,
          imagePath,
          imageUrl: imagePath ? null : item.remoteImageUrl,
          productUrl: item.productUrl,
          priceBand: item.priceBand,
          source: item.source,
        };
      }),
    );
    const added = await deps.addItems(userId, inputs, now);
    if (!added.ok) {
      // The copies would be orphans: nothing references them.
      await discardCopies(userId, inputs);
      if (added.error === "too-many") {
        return { ok: false, error: "too-many", room: Math.max(0, WISHLIST_MAX_ITEMS - (await deps.countItems(userId))) };
      }
      return { ok: false, error: "unavailable" };
    }
  }

  const saved: WishlistCard = {
    ...card,
    state: "saved",
    savedKeys: picked.map((item) => item.key),
    resolvedAt: now.toISOString(),
  };
  await deps.saveCard(messageId, saved);
  return { ok: true, card: saved };
}

async function discardCopies(userId: string, inputs: WishlistItemInput[]): Promise<void> {
  await Promise.all(
    inputs
      .map((input) => input.imagePath)
      .filter((path): path is string => typeof path === "string" && path.startsWith(`${userId}/w`))
      .map((path) => deleteStorageObject(env.SUPABASE_CHAT_BUCKET, path).catch(() => false)),
  );
}
