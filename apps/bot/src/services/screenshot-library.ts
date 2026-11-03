import { randomUUID } from "node:crypto";
import { prisma, Prisma } from "@gennety/db";
import {
  SCREENSHOT_AGENT_LIST_PAGE,
  SCREENSHOT_CONSENT_VERSION,
  SCREENSHOT_LIBRARY_MAX_ITEMS,
  SCREENSHOT_LIST_PAGE,
  SCREENSHOT_MAX_DIMENSION,
  SCREENSHOT_MAX_PIXELS,
  SCREENSHOT_OCR_MAX_CHARS,
  SCREENSHOT_SEARCH_HITS,
  SCREENSHOT_SIGNED_URL_TTL_S,
  SCREENSHOT_UPLOAD_MAX_BYTES,
  screenshotKindOf,
  screenshotLegacyCategory,
  screenshotStoredValuesOfCategory,
  screenshotStoredValuesOfKind,
  type ScreenshotCategory,
  type ScreenshotKind,
} from "@gennety/shared";
import { env } from "../config.js";
import { dropScreenshotSources, moveScreenshotSources } from "./memory-ideas.js";
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

const DAY_MS = 24 * 3_600_000;

export class ScreenshotLibraryError extends Error {
  constructor(
    readonly code:
      | "library-off"
      | "library-paused"
      | "generation-stale"
      | "consent-required"
      | "auto-import-off"
      | "source-excluded"
      | "out-of-range"
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
    await dropScreenshotSources(tx, userId, "all");
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
    // The period chosen on connecting is what they agreed to have imported; the
    // phone filters by it, and the server holds it too (audit F-12). A screenshot
    // with no capture time and anything picked by hand are not limited by it.
    if (library.rangeDays !== null && input.capturedAt && input.capturedAt.getTime() < Date.now() - library.rangeDays * DAY_MS) {
      throw new ScreenshotLibraryError("out-of-range", 409);
    }
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

  const id = randomUUID();
  const storagePath = storagePathOf(userId, id);
  const ocrText = input.ocrText?.slice(0, SCREENSHOT_OCR_MAX_CHARS) ?? null;
  let row;
  try {
    row = await prisma.$transaction(async (tx) => {
      // The library row is the lock disconnecting takes first: a reservation
      // that read «open» before a disconnect committed waits for it here and
      // then sees «off», instead of leaving a live row in a closed library.
      // The cap is counted under the same lock, so two uploads cannot both
      // take the last place (audit F-04).
      const [locked] = await tx.$queryRaw<Array<{ status: string; generation: number; auto_import: boolean }>>`
        SELECT status, generation, auto_import FROM screenshot_libraries WHERE user_id = ${userId}::uuid FOR UPDATE
      `;
      if (!locked || locked.status === "off") throw new ScreenshotLibraryError("library-off", 409);
      if (locked.generation !== input.generation) throw new ScreenshotLibraryError("generation-stale", 409);
      if (input.source === "auto" && locked.status === "paused") throw new ScreenshotLibraryError("library-paused", 409);
      if (input.source === "auto" && !locked.auto_import) throw new ScreenshotLibraryError("auto-import-off", 409);
      // A new version of a source replaces the old one, so it is counted without it.
      const older = await tx.screenshotItem.findMany({
        where: { userId, sourceKey: input.sourceKey, deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      await hideRows(tx, { userId, sourceKey: input.sourceKey });
      const total = await tx.screenshotItem.count({ where: { userId, deletedAt: null } });
      if (total >= SCREENSHOT_LIBRARY_MAX_ITEMS) throw new ScreenshotLibraryError("library-full", 409);
      const created = await tx.screenshotItem.create({
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
      // An edit in Photos: the idea follows the new version (decision 2026-11-03).
      await moveScreenshotSources(tx, userId, older.map((row) => row.id), created.id);
      return created;
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
  target: { userId: string; id?: string; sourceKey?: string; source?: "auto"; generation?: number },
): Promise<number> {
  const now = new Date();
  return db.$executeRaw`
    UPDATE screenshot_items
    SET deleted_at = ${now}, content_hash = NULL, ocr_text = NULL, title = NULL,
        description = NULL, entities = NULL, embedding = NULL, updated_at = ${now}
    WHERE user_id = ${target.userId}::uuid AND deleted_at IS NULL
      ${target.id ? Prisma.sql`AND id = ${target.id}::uuid` : Prisma.empty}
      ${target.sourceKey ? Prisma.sql`AND source_key = ${target.sourceKey}` : Prisma.empty}
      ${target.source ? Prisma.sql`AND source = ${target.source}` : Prisma.empty}
      ${target.generation !== undefined ? Prisma.sql`AND generation = ${target.generation}` : Prisma.empty}
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
    await dropScreenshotSources(tx, userId, [itemId]);
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
    removed += await prisma.$transaction(async (tx) => {
      // Only what the automatic import brought in this generation: a screenshot
      // picked by hand needs no library access, so leaving the iOS selection
      // says nothing about it (audit B-5).
      const gone = await tx.screenshotItem.findMany({ where: { userId, sourceKey, source: "auto", generation, deletedAt: null }, select: { id: true } });
      const count = await hideRows(tx, { userId, sourceKey, source: "auto", generation });
      await dropScreenshotSources(tx, userId, gone.map((row) => row.id));
      return count;
    });
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
  /** The four values shipped clients decode. `kind` is the finer one. */
  category: ScreenshotCategory | null;
  kind: ScreenshotKind | null;
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
    category: screenshotLegacyCategory(row.category),
    kind: screenshotKindOf(row.category),
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
  options: { before?: Date; category?: string; kind?: ScreenshotKind; limit?: number },
): Promise<{ items: ScreenshotItemView[]; nextBefore: string | null }> {
  const limit = Math.min(options.limit ?? SCREENSHOT_LIST_PAGE, SCREENSHOT_LIST_PAGE);
  const rows = await prisma.screenshotItem.findMany({
    where: {
      userId,
      deletedAt: null,
      state: { not: "reserved" },
      ...(options.before ? { createdAt: { lt: options.before } } : {}),
      ...(options.kind
        ? { category: { in: screenshotStoredValuesOfKind(options.kind) } }
        : options.category
          ? { category: { in: screenshotStoredValuesOfCategory(options.category) } }
          : {}),
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
  match: "text" | "meaning" | "list";
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

/** Words of a description that say nothing on their own. The query is in English. */
const QUERY_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "about", "some", "something", "things", "how", "what", "where", "when", "was", "are", "you", "your", "all", "any", "saved", "screenshot",
]);

/**
 * A Postgres pattern for one word. It matches at the start of a word, so an
 * inflected Russian word still finds its stem; a short one must be the whole word,
 * or «car» answers «add to cart» and «recipe card» (labelled set, 2026-11-01).
 */
function wordPattern(word: string): string {
  const escaped = word.replace(/[\\.^$*+?()[\]{}|-]/g, (c) => `\\${c}`);
  return [...word].length < 5 ? `\\m${escaped}\\M` : `\\m${escaped}`;
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

/** Narrow a search or a listing. The owner is not here: every query has it itself. */
export interface ScreenshotFilter {
  kind?: ScreenshotKind;
  /** Taken on or after this moment; an item with no capture time counts by its import. */
  capturedFrom?: Date;
  /** Taken before this moment. */
  capturedBefore?: Date;
}

function filterSql(filter: ScreenshotFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (filter.kind) parts.push(Prisma.sql`AND category = ANY (${screenshotStoredValuesOfKind(filter.kind)}::text[])`);
  if (filter.capturedFrom) parts.push(Prisma.sql`AND COALESCE(captured_at, created_at) >= ${filter.capturedFrom}`);
  if (filter.capturedBefore) parts.push(Prisma.sql`AND COALESCE(captured_at, created_at) < ${filter.capturedBefore}`);
  return parts.length > 0 ? Prisma.join(parts, " ") : Prisma.empty;
}

function hitOf(row: HitRow, match: ScreenshotHit["match"], words: readonly string[]): ScreenshotHit {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    capturedAt: row.captured_at,
    state: row.state,
    matchedText: matchedSnippet(row.ocr_text, words),
    match,
  };
}

export interface ScreenshotPageRequest {
  filter?: ScreenshotFilter;
  offset?: number;
  limit?: number;
}

/**
 * Exact words first, because a name the person remembers beats any embedding;
 * then meaning, cut off at the distance above. The owner filter is in both
 * queries, ahead of ranking. Words also reach screenshots still being indexed,
 * since the phone's OCR arrived with the upload.
 *
 * A page is a slice of that one order, which is stable: both queries break ties
 * by id. Each reads up to the page's end plus one, which is at most a library.
 */
export async function searchScreenshotsPage(
  userId: string,
  query: string,
  keywords: readonly string[],
  request: ScreenshotPageRequest = {},
  deps: SearchDeps = {},
): Promise<{ hits: ScreenshotHit[]; hasMore: boolean }> {
  const offset = Math.max(0, request.offset ?? 0);
  const limit = request.limit ?? SCREENSHOT_SEARCH_HITS;
  const wanted = offset + limit + 1;
  const scope = filterSql(request.filter ?? {});
  const usable = (w: string) => w.trim().slice(0, 40);
  const named = [...new Set(keywords.map(usable))].filter((w) => [...w].length >= 3).slice(0, 6);
  const described = [...new Set(query.split(/[^\p{L}\p{N}'-]+/u).map(usable))]
    .filter((w) => [...w].length >= 3 && !QUERY_STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 8);
  const words = [...named, ...described];
  const hits = new Map<string, ScreenshotHit>();

  if (words.length > 0) {
    // A name given as a keyword finds on its own. Words of the description must
    // all be there: one common word of it is not a match, meaning search is for that.
    const anyOf = named.map(wordPattern);
    const allOf = described.map(wordPattern);
    const rows = await prisma.$queryRaw<HitRow[]>`
      SELECT id, title, description, category, captured_at, state, ocr_text
      FROM screenshot_items
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL AND state <> 'reserved'
        AND (concat_ws(' ', ocr_text, title, description) ~* ANY (${anyOf}::text[])
             OR (cardinality(${allOf}::text[]) > 0
                 AND concat_ws(' ', ocr_text, title, description) ~* ALL (${allOf}::text[])))
        ${scope}
      ORDER BY captured_at DESC NULLS LAST, id
      LIMIT ${wanted}
    `;
    for (const row of rows) hits.set(row.id, hitOf(row, "text", words));
  }

  if (hits.size < wanted) {
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
          ${scope}
        ORDER BY embedding <=> ${literal}::vector, id
        LIMIT ${wanted}
      `;
      for (const row of rows) {
        if (hits.size >= wanted) break;
        if (!hits.has(row.id)) hits.set(row.id, hitOf(row, "meaning", words));
      }
    }
  }
  const ranked = [...hits.values()];
  return { hits: ranked.slice(offset, offset + limit), hasMore: ranked.length > offset + limit };
}

export async function searchScreenshots(
  userId: string,
  query: string,
  keywords: readonly string[],
  deps: SearchDeps = {},
): Promise<ScreenshotHit[]> {
  return (await searchScreenshotsPage(userId, query, keywords, {}, deps)).hits;
}

/** «All my restaurants»: no query to rank by, so newest first, with the total. */
export async function listScreenshotsPage(
  userId: string,
  request: ScreenshotPageRequest = {},
): Promise<{ hits: ScreenshotHit[]; hasMore: boolean; total: number }> {
  const offset = Math.max(0, request.offset ?? 0);
  const limit = request.limit ?? SCREENSHOT_AGENT_LIST_PAGE;
  const scope = filterSql(request.filter ?? {});
  const [rows, counted] = await Promise.all([
    prisma.$queryRaw<HitRow[]>`
      SELECT id, title, description, category, captured_at, state, NULL::text AS ocr_text
      FROM screenshot_items
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL AND state <> 'reserved'
        ${scope}
      ORDER BY COALESCE(captured_at, created_at) DESC, id
      LIMIT ${limit + 1} OFFSET ${offset}
    `,
    prisma.$queryRaw<Array<{ total: number }>>`
      SELECT COUNT(*)::int AS total
      FROM screenshot_items
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL AND state <> 'reserved'
        ${scope}
    `,
  ]);
  return {
    hits: rows.slice(0, limit).map((row) => hitOf(row, "list", [])),
    hasMore: rows.length > limit,
    total: counted[0]?.total ?? 0,
  };
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
