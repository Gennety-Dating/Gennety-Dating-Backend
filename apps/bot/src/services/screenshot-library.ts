import { randomUUID } from "node:crypto";
import { prisma, Prisma } from "@gennety/db";
import {
  SCREENSHOT_CONSENT_VERSION,
  SCREENSHOT_LIBRARY_MAX_ITEMS,
  SCREENSHOT_LIST_PAGE,
  SCREENSHOT_MAX_DIMENSION,
  SCREENSHOT_MAX_PIXELS,
  SCREENSHOT_OCR_MAX_CHARS,
  SCREENSHOT_SEARCH_HITS,
  SCREENSHOT_SIGNED_URL_TTL_S,
  SCREENSHOT_UPLOAD_MAX_BYTES,
} from "@gennety/shared";
import { env } from "../config.js";
import { imageDimensions } from "../utils/image-dimensions.js";
import { sniffImageMime } from "../utils/image-sniff.js";
import { createOpenAIEmbeddingClient, toPgVectorLiteral } from "./profile-analysis.js";
import {
  createScreenshotSignedUpload,
  createScreenshotSignedUrls,
  downloadScreenshot,
} from "./storage.js";

/**
 * The private screenshot library (decision journal 2026-10-31,
 * docs/product/domains/screenshot-library.md).
 *
 * Three things stay apart: the screenshot, what the model thinks is on it, and
 * what the person confirmed they want. Nothing here touches the profile,
 * matching, a date or the partner.
 *
 * Every query filters by the caller's `userId` in the query itself, so another
 * person's id reads exactly like one that never existed. `generation` is what
 * stops a late answer: disconnecting bumps it on the next connect and hides the
 * rows at once, and every write names the generation it belongs to.
 */

export type LibraryStatus = "off" | "active" | "paused";

export class ScreenshotLibraryError extends Error {
  constructor(
    readonly code:
      | "library-off"
      | "library-paused"
      | "generation-stale"
      | "consent-required"
      | "auto-import-off"
      | "source-excluded"
      | "library-full"
      | "upload-missing"
      | "bad-image"
      | "not-found"
      | "storage-unavailable",
    readonly status: number,
  ) {
    super(code);
  }
}

export interface ScreenshotLibraryView {
  status: LibraryStatus;
  generation: number;
  autoImport: boolean;
  rangeDays: number | null;
  lastReconciledAt: string | null;
  consentVersion: string;
  consentGiven: boolean;
  counts: { total: number; ready: number; processing: number; failed: number; deleting: number };
  limits: { maxItems: number; maxUploadBytes: number; maxDimension: number; maxPixels: number; maxOcrChars: number };
}

export async function libraryView(userId: string): Promise<ScreenshotLibraryView> {
  const library = await prisma.screenshotLibrary.findUnique({ where: { userId } });
  const groups = await prisma.screenshotItem.groupBy({
    by: ["state"],
    where: { userId, deletedAt: null },
    _count: { _all: true },
  });
  const deleting = await prisma.screenshotItem.count({ where: { userId, deletedAt: { not: null } } });
  const count = (...states: string[]) =>
    groups.filter((g) => states.includes(g.state)).reduce((sum, g) => sum + g._count._all, 0);
  return {
    status: (library?.status as LibraryStatus | undefined) ?? "off",
    generation: library?.generation ?? 0,
    autoImport: library?.autoImport ?? false,
    rangeDays: library?.rangeDays ?? null,
    lastReconciledAt: library?.lastReconciledAt?.toISOString() ?? null,
    consentVersion: SCREENSHOT_CONSENT_VERSION,
    consentGiven: library?.status !== "off" && library?.consentVersion === SCREENSHOT_CONSENT_VERSION,
    counts: {
      total: count("reserved", "queued", "indexing", "ready", "failed"),
      ready: count("ready"),
      processing: count("reserved", "queued", "indexing"),
      failed: count("failed"),
      deleting,
    },
    limits: {
      maxItems: SCREENSHOT_LIBRARY_MAX_ITEMS,
      maxUploadBytes: SCREENSHOT_UPLOAD_MAX_BYTES,
      maxDimension: SCREENSHOT_MAX_DIMENSION,
      maxPixels: SCREENSHOT_MAX_PIXELS,
      maxOcrChars: SCREENSHOT_OCR_MAX_CHARS,
    },
  };
}

/**
 * Connect. Idempotent: the same call while connected only updates the mode and
 * the period. Consent is the person's tap on this exact text version; a Photos
 * permission given for a profile photo is not consent and never reaches here.
 */
export async function connectLibrary(
  userId: string,
  input: { consentVersion: string; autoImport: boolean; rangeDays: number | null },
): Promise<ScreenshotLibraryView> {
  if (input.consentVersion !== SCREENSHOT_CONSENT_VERSION) {
    throw new ScreenshotLibraryError("consent-required", 409);
  }
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const existing = await tx.screenshotLibrary.findUnique({ where: { userId } });
    const reopening = !existing || existing.status === "off";
    await tx.screenshotLibrary.upsert({
      where: { userId },
      create: {
        userId,
        status: "active",
        generation: 1,
        autoImport: input.autoImport,
        rangeDays: input.rangeDays,
        consentAt: now,
        consentVersion: input.consentVersion,
      },
      update: {
        ...(reopening ? { status: "active", generation: { increment: 1 }, lastReconciledAt: null } : {}),
        autoImport: input.autoImport,
        rangeDays: input.rangeDays,
        consentAt: existing?.consentVersion === input.consentVersion && existing.consentAt && !reopening ? existing.consentAt : now,
        consentVersion: input.consentVersion,
      },
    });
  });
  return libraryView(userId);
}

export async function setLibraryPaused(userId: string, paused: boolean): Promise<ScreenshotLibraryView> {
  const updated = await prisma.screenshotLibrary.updateMany({
    where: { userId, status: { in: ["active", "paused"] } },
    data: { status: paused ? "paused" : "active" },
  });
  if (updated.count === 0) throw new ScreenshotLibraryError("library-off", 409);
  return libraryView(userId);
}

/**
 * «Отключить и удалить». Closes the library in one transaction: consent gone,
 * every row hidden and without its derived text, exclusions cleared. Objects go
 * in the purge sweep, which retries, so this answer means "closed", and
 * `counts.deleting` reaching zero means "removed". Repeating it is harmless.
 */
export async function disconnectLibrary(userId: string): Promise<ScreenshotLibraryView> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.screenshotLibrary.updateMany({
      where: { userId },
      data: { status: "off", autoImport: false, consentAt: null, consentVersion: null, lastReconciledAt: null },
    });
    await tx.$executeRaw`
      UPDATE screenshot_items
      SET deleted_at = ${now}, content_hash = NULL, ocr_text = NULL, title = NULL,
          description = NULL, entities = NULL, embedding = NULL, updated_at = ${now}
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
    `;
    await tx.screenshotExclusion.deleteMany({ where: { userId } });
  });
  return libraryView(userId);
}

async function requireOpen(userId: string, generation: number) {
  const library = await prisma.screenshotLibrary.findUnique({ where: { userId } });
  if (!library || library.status === "off") throw new ScreenshotLibraryError("library-off", 409);
  if (library.generation !== generation) throw new ScreenshotLibraryError("generation-stale", 409);
  return library;
}

export interface ReserveInput {
  generation: number;
  source: "auto" | "manual";
  sourceKey: string;
  contentHash: string;
  capturedAt: Date | null;
  ocrText: string | null;
}

export interface ReserveResult {
  item: ScreenshotItemView;
  uploadUrl: string | null;
  uploadPath: string | null;
  duplicate: boolean;
}

function storagePathOf(userId: string, itemId: string): string {
  return `${userId}/${itemId}.jpg`;
}

/**
 * First step of an upload: a row and a signed PUT. Idempotent on the content:
 * the same bytes in this account get the same row, and a row whose upload never
 * finished gets a fresh URL. A changed file under the same source key is a new
 * version, and the old one leaves in the same transaction.
 */
export async function reserveUpload(userId: string, input: ReserveInput): Promise<ReserveResult> {
  const library = await requireOpen(userId, input.generation);
  if (input.source === "auto") {
    if (library.status === "paused") throw new ScreenshotLibraryError("library-paused", 409);
    if (!library.autoImport) throw new ScreenshotLibraryError("auto-import-off", 409);
    const excluded = await prisma.screenshotExclusion.findUnique({
      where: { userId_sourceKey: { userId, sourceKey: input.sourceKey } },
    });
    if (excluded) throw new ScreenshotLibraryError("source-excluded", 409);
  } else {
    // Picking it by hand is the person changing their mind about that source.
    await prisma.screenshotExclusion.deleteMany({ where: { userId, sourceKey: input.sourceKey } });
  }

  const existing = await prisma.screenshotItem.findUnique({
    where: { userId_contentHash: { userId, contentHash: input.contentHash } },
  });
  if (existing) {
    const needsBytes = existing.state === "reserved";
    return {
      item: itemView(existing, null),
      uploadUrl: needsBytes ? await createScreenshotSignedUpload(existing.storagePath) : null,
      uploadPath: needsBytes ? existing.storagePath : null,
      duplicate: !needsBytes,
    };
  }

  const total = await prisma.screenshotItem.count({ where: { userId, deletedAt: null } });
  if (total >= SCREENSHOT_LIBRARY_MAX_ITEMS) throw new ScreenshotLibraryError("library-full", 409);

  const id = randomUUID();
  const storagePath = storagePathOf(userId, id);
  const ocrText = input.ocrText?.slice(0, SCREENSHOT_OCR_MAX_CHARS) ?? null;
  let row;
  try {
    row = await prisma.$transaction(async (tx) => {
      await hideRows(tx, { userId, sourceKey: input.sourceKey });
      return tx.screenshotItem.create({
        data: {
          id,
          userId,
          generation: input.generation,
          source: input.source,
          sourceKey: input.sourceKey,
          contentHash: input.contentHash,
          capturedAt: input.capturedAt,
          storagePath,
          ocrText,
        },
      });
    });
  } catch (err) {
    // Two identical requests raced: the loser answers with the winner's row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return reserveUpload(userId, input);
    }
    throw err;
  }
  const uploadUrl = await createScreenshotSignedUpload(storagePath);
  if (!uploadUrl) {
    await hideRows(prisma, { userId, id });
    throw new ScreenshotLibraryError("storage-unavailable", 503);
  }
  return { item: itemView(row, null), uploadUrl, uploadPath: storagePath, duplicate: false };
}

/** Hide rows and drop their derived text in one statement; the sweep does the rest. */
async function hideRows(
  db: Pick<typeof prisma, "$executeRaw">,
  target: { userId: string; id?: string; sourceKey?: string },
): Promise<number> {
  const now = new Date();
  return db.$executeRaw`
    UPDATE screenshot_items
    SET deleted_at = ${now}, content_hash = NULL, ocr_text = NULL, title = NULL,
        description = NULL, entities = NULL, embedding = NULL, updated_at = ${now}
    WHERE user_id = ${target.userId}::uuid AND deleted_at IS NULL
      ${target.id ? Prisma.sql`AND id = ${target.id}::uuid` : Prisma.empty}
      ${target.sourceKey ? Prisma.sql`AND source_key = ${target.sourceKey}` : Prisma.empty}
  `;
}

/**
 * Bytes arrived: check what they really are, then queue for indexing. The object
 * is untrusted until here. Repeating it answers with the row as it stands, and
 * the conditional update means a commit racing a disconnect cannot revive it.
 */
export async function commitUpload(userId: string, itemId: string, generation: number): Promise<ScreenshotItemView> {
  await requireOpen(userId, generation);
  const row = await prisma.screenshotItem.findFirst({ where: { id: itemId, userId, generation, deletedAt: null } });
  if (!row) throw new ScreenshotLibraryError("not-found", 404);
  if (row.state !== "reserved") return itemView(row, null);

  const downloaded = await downloadScreenshot(row.storagePath, SCREENSHOT_UPLOAD_MAX_BYTES);
  if (!downloaded.ok) {
    if (downloaded.reason === "too_large") {
      await hideRows(prisma, { userId, id: itemId });
      throw new ScreenshotLibraryError("bad-image", 422);
    }
    if (downloaded.reason === "unreachable") throw new ScreenshotLibraryError("storage-unavailable", 503);
    throw new ScreenshotLibraryError("upload-missing", 409);
  }
  if (!isAcceptableImage(downloaded.bytes)) {
    await hideRows(prisma, { userId, id: itemId });
    throw new ScreenshotLibraryError("bad-image", 422);
  }
  await prisma.screenshotItem.updateMany({
    where: { id: itemId, userId, generation, deletedAt: null, state: "reserved" },
    data: { state: "queued", nextAttemptAt: new Date() },
  });
  const after = await prisma.screenshotItem.findFirst({ where: { id: itemId, userId, deletedAt: null } });
  if (!after) throw new ScreenshotLibraryError("not-found", 404);
  return itemView(after, null);
}

export function isAcceptableImage(bytes: Buffer): boolean {
  const mime = sniffImageMime(bytes);
  if (mime !== "image/jpeg" && mime !== "image/png") return false;
  const size = imageDimensions(bytes);
  if (!size || size.width === 0 || size.height === 0) return false;
  return (
    size.width <= SCREENSHOT_MAX_DIMENSION &&
    size.height <= SCREENSHOT_MAX_DIMENSION &&
    size.width * size.height <= SCREENSHOT_MAX_PIXELS
  );
}

/** One item: hidden now, and the next automatic pass will not bring it back. */
export async function deleteItem(userId: string, itemId: string): Promise<void> {
  const row = await prisma.screenshotItem.findFirst({ where: { id: itemId, userId }, select: { sourceKey: true } });
  if (!row) return;
  await prisma.$transaction(async (tx) => {
    await hideRows(tx, { userId, id: itemId });
    await tx.screenshotExclusion.upsert({
      where: { userId_sourceKey: { userId, sourceKey: row.sourceKey } },
      create: { userId, sourceKey: row.sourceKey },
      update: {},
    });
  });
}

/**
 * The phone's confirmed comparison with Photos. Only keys the phone positively
 * established as gone arrive here, never a network failure's silence. They leave
 * without an exclusion: selecting them again in iOS brings them back.
 */
export async function reconcile(
  userId: string,
  generation: number,
  removedSourceKeys: readonly string[],
): Promise<{ removed: number }> {
  await requireOpen(userId, generation);
  let removed = 0;
  for (const sourceKey of removedSourceKeys) {
    removed += await hideRows(prisma, { userId, sourceKey });
  }
  await prisma.screenshotLibrary.updateMany({ where: { userId, generation }, data: { lastReconciledAt: new Date() } });
  return { removed };
}

/* ── Reading ────────────────────────────────────────────────────────────── */

export interface ScreenshotItemView {
  id: string;
  state: string;
  source: string;
  sourceKey: string;
  title: string | null;
  description: string | null;
  category: string | null;
  capturedAt: string | null;
  importedAt: string;
  imageUrl: string | null;
}

interface ItemRow {
  id: string;
  state: string;
  source: string;
  sourceKey: string;
  title: string | null;
  description: string | null;
  category: string | null;
  capturedAt: Date | null;
  createdAt: Date;
}

function itemView(row: ItemRow, imageUrl: string | null): ScreenshotItemView {
  return {
    id: row.id,
    state: row.state,
    source: row.source,
    sourceKey: row.sourceKey,
    title: row.title,
    description: row.description,
    category: row.category,
    capturedAt: row.capturedAt?.toISOString() ?? null,
    importedAt: row.createdAt.toISOString(),
    imageUrl,
  };
}

async function signed(rows: Array<ItemRow & { storagePath: string }>): Promise<ScreenshotItemView[]> {
  const urls = await createScreenshotSignedUrls(rows.map((r) => r.storagePath), SCREENSHOT_SIGNED_URL_TTL_S).catch(
    () => rows.map(() => null),
  );
  return rows.map((row, i) => itemView(row, row.state === "reserved" ? null : (urls[i] ?? null)));
}

export async function listItems(
  userId: string,
  options: { before?: Date; category?: string; limit?: number },
): Promise<{ items: ScreenshotItemView[]; nextBefore: string | null }> {
  const limit = Math.min(options.limit ?? SCREENSHOT_LIST_PAGE, SCREENSHOT_LIST_PAGE);
  const rows = await prisma.screenshotItem.findMany({
    where: {
      userId,
      deletedAt: null,
      state: { not: "reserved" },
      ...(options.before ? { createdAt: { lt: options.before } } : {}),
      ...(options.category ? { category: options.category } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return {
    items: await signed(page),
    nextBefore: rows.length > limit ? (page[page.length - 1]?.createdAt.toISOString() ?? null) : null,
  };
}

export async function readItem(userId: string, itemId: string): Promise<ScreenshotItemView> {
  const row = await prisma.screenshotItem.findFirst({ where: { id: itemId, userId, deletedAt: null } });
  if (!row) throw new ScreenshotLibraryError("not-found", 404);
  const [view] = await signed([row]);
  return view!;
}

/* ── Search ─────────────────────────────────────────────────────────────── */

/**
 * The widest cosine distance still offered as a match. Beyond it the honest
 * answer is "nothing found", not the least unrelated picture. A starting value:
 * NOT yet measured on a labelled set, which the rollout checklist requires.
 */
export const SCREENSHOT_MATCH_MAX_DISTANCE = 0.72;

export interface ScreenshotHit {
  id: string;
  title: string | null;
  description: string | null;
  category: string | null;
  capturedAt: Date | null;
  state: string;
  matchedText: string | null;
  match: "text" | "meaning";
}

interface HitRow {
  id: string;
  title: string | null;
  description: string | null;
  category: string | null;
  captured_at: Date | null;
  state: string;
  ocr_text: string | null;
}

export interface SearchDeps {
  embed?: (input: string) => Promise<number[]>;
}

function escapeLike(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Up to three lines around the first word found: what the person will recognise. */
export function matchedSnippet(text: string | null, words: readonly string[]): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const word of words) {
    const at = lower.indexOf(word.toLowerCase());
    if (at >= 0) {
      const start = Math.max(0, at - 60);
      return text.slice(start, at + word.length + 60).replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

/**
 * Exact words first, because a name the person remembers beats any embedding;
 * then meaning, cut off at the distance above. The owner filter is in both
 * queries, ahead of ranking. Words also reach screenshots still being indexed,
 * since the phone's OCR arrived with the upload.
 */
export async function searchScreenshots(
  userId: string,
  query: string,
  keywords: readonly string[],
  deps: SearchDeps = {},
): Promise<ScreenshotHit[]> {
  const words = [...new Set([...keywords, ...query.split(/[^\p{L}\p{N}'-]+/u)])]
    .map((w) => w.trim().slice(0, 40))
    .filter((w) => [...w].length >= 3)
    .slice(0, 8);
  const hits = new Map<string, ScreenshotHit>();

  if (words.length > 0) {
    const patterns = words.map(escapeLike);
    const rows = await prisma.$queryRaw<HitRow[]>`
      SELECT id, title, description, category, captured_at, state, ocr_text
      FROM screenshot_items
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL AND state <> 'reserved'
        AND (ocr_text ILIKE ANY (${patterns}::text[])
             OR title ILIKE ANY (${patterns}::text[])
             OR description ILIKE ANY (${patterns}::text[]))
      ORDER BY captured_at DESC NULLS LAST
      LIMIT ${SCREENSHOT_SEARCH_HITS}
    `;
    for (const row of rows) {
      hits.set(row.id, {
        id: row.id,
        title: row.title,
        description: row.description,
        category: row.category,
        capturedAt: row.captured_at,
        state: row.state,
        matchedText: matchedSnippet(row.ocr_text, words),
        match: "text",
      });
    }
  }

  if (hits.size < SCREENSHOT_SEARCH_HITS) {
    const embed = deps.embed ?? defaultEmbed;
    const vector = await embed(query).catch(() => null);
    if (vector) {
      const literal = toPgVectorLiteral(vector);
      const rows = await prisma.$queryRaw<HitRow[]>`
        SELECT id, title, description, category, captured_at, state, NULL::text AS ocr_text
        FROM screenshot_items
        WHERE user_id = ${userId}::uuid AND deleted_at IS NULL AND state = 'ready'
          AND embedding IS NOT NULL
          AND embedding <=> ${literal}::vector <= ${SCREENSHOT_MATCH_MAX_DISTANCE}
        ORDER BY embedding <=> ${literal}::vector
        LIMIT ${SCREENSHOT_SEARCH_HITS}
      `;
      for (const row of rows) {
        if (hits.size >= SCREENSHOT_SEARCH_HITS) break;
        if (hits.has(row.id)) continue;
        hits.set(row.id, {
          id: row.id,
          title: row.title,
          description: row.description,
          category: row.category,
          capturedAt: row.captured_at,
          state: row.state,
          matchedText: null,
          match: "meaning",
        });
      }
    }
  }
  return [...hits.values()];
}

async function defaultEmbed(input: string): Promise<number[]> {
  if (!env.OPENAI_API_KEY) throw new Error("embedding unavailable");
  const client = createOpenAIEmbeddingClient(env.OPENAI_API_KEY);
  return client.embed(input);
}

/** Library screen search: results as the app draws them. */
export async function searchItems(userId: string, query: string): Promise<ScreenshotItemView[]> {
  const hits = await searchScreenshots(userId, query, []);
  if (hits.length === 0) return [];
  const rows = await prisma.screenshotItem.findMany({
    where: { userId, deletedAt: null, id: { in: hits.map((h) => h.id) } },
  });
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return signed(hits.map((h) => byId.get(h.id)).filter((r): r is NonNullable<typeof r> => Boolean(r)));
}
