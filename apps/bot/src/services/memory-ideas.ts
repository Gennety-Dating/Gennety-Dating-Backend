import { prisma, Prisma } from "@gennety/db";
import {
  MEMORY_IDEAS_MAX_PER_USER,
  MEMORY_IDEAS_PAGE,
  MEMORY_NOTE_MAX,
  MEMORY_PREFERENCE_VALUE_MAX,
  MEMORY_REASON_QUESTIONS_MAX,
  MEMORY_REASON_SNOOZE_MS,
  MEMORY_RECIPIENT_MAX,
  MEMORY_TITLE_MAX,
  canonicalMemoryUrl,
  isOnlyForMe,
  memoryCanonicalKey,
  possiblySameIdea,
  type MemoryIdeaKind,
  type MemoryIntent,
  type MemoryPreferenceFacet,
  type MemoryProvenance,
  type MemoryReason,
  type MemorySourceKind,
  type MemoryUse,
} from "@gennety/shared";

/**
 * Ideas: the person's confirmed wishes, joined from any number of sources
 * (docs/product/domains/memory-ideas.md). Every function takes the owner, and
 * every query filters by it, so a stale or foreign id acts on nothing. Each
 * change writes its history row in one transaction with the change, and a
 * repeated `idempotencyKey` returns the idea as it stands.
 */

export class MemoryIdeaError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "MemoryIdeaError";
  }
}

type Tx = Prisma.TransactionClient;
type IdeaRow = Prisma.MemoryIdeaGetPayload<{ include: { sources: true } }>;
export type MemoryActor = "person" | "system";

const withSources = { sources: { orderBy: { createdAt: "asc" as const } } };

export interface MemorySourceInput {
  kind: MemorySourceKind;
  provenance: MemoryProvenance;
  screenshotItemId?: string | null;
  wishlistItemId?: string | null;
  url?: string | null;
  quote?: string | null;
}

export interface SaveIdeaInput {
  kind: MemoryIdeaKind;
  title: string;
  note?: string | null;
  city?: string | null;
  placeId?: string | null;
  catalogKey?: string | null;
  eventAt?: Date | null;
  eventTimezone?: string | null;
  intent?: MemoryIntent;
  reason?: MemoryReason | null;
  recipient?: string | null;
  source: MemorySourceInput;
  idempotencyKey?: string;
}

export interface MemoryIdeaView {
  id: string;
  kind: string;
  title: string;
  note: string | null;
  city: string | null;
  placeId: string | null;
  eventAt: string | null;
  eventTimezone: string | null;
  eventCheck: string;
  intent: string;
  reason: string | null;
  recipient: string | null;
  usage: { ownDates: boolean; matching: boolean; partner: boolean; onlyForMe: boolean };
  version: number;
  sources: Array<{ id: string; kind: string; provenance: string; screenshotId: string | null; wishlistItemId: string | null; url: string | null; quote: string | null; createdAt: string }>;
  updatedAt: string;
}

export function ideaView(row: IdeaRow): MemoryIdeaView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    note: row.note,
    city: row.city,
    placeId: row.placeId,
    eventAt: row.eventAt?.toISOString() ?? null,
    eventTimezone: row.eventTimezone,
    eventCheck: row.eventCheck,
    intent: row.intent,
    reason: row.reason,
    recipient: row.recipient,
    usage: {
      ownDates: row.allowOwnDates,
      matching: row.allowMatching,
      partner: row.allowPartner,
      onlyForMe: isOnlyForMe(row),
    },
    version: row.version,
    sources: row.sources.map((s) => ({
      id: s.id,
      kind: s.kind,
      provenance: s.provenance,
      screenshotId: s.screenshotItemId,
      wishlistItemId: s.wishlistItemId,
      url: s.url,
      quote: s.quote,
      createdAt: s.createdAt.toISOString(),
    })),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sourceDedupeKey(source: MemorySourceInput): string {
  if (source.screenshotItemId) return `screenshot:${source.screenshotItemId}`;
  if (source.wishlistItemId) return `wishlist:${source.wishlistItemId}`;
  const url = source.url ? canonicalMemoryUrl(source.url) : null;
  if (url) return `url:${url}`;
  const quote = source.quote?.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ") ?? "";
  if (quote) return `${source.kind}:${quote.slice(0, 200)}`;
  throw new MemoryIdeaError("bad-source", 400);
}

function clip(value: string | null | undefined, max: number): string | null {
  const clean = value?.replace(/\s+/gu, " ").trim();
  return clean ? [...clean].slice(0, max).join("") : null;
}

function requireTitle(title: string): string {
  const clean = clip(title, MEMORY_TITLE_MAX);
  if (!clean) throw new MemoryIdeaError("bad-title", 400);
  return clean;
}

async function recordEvent(
  tx: Tx,
  row: { id: string; userId: string },
  actor: MemoryActor,
  type: string,
  payload: Prisma.InputJsonValue | undefined,
  idempotencyKey?: string,
): Promise<void> {
  await tx.memoryIdeaEvent.create({
    data: { ideaId: row.id, userId: row.userId, actor, type, ...(payload === undefined ? {} : { payload }), idempotencyKey: idempotencyKey ?? null },
  });
}

async function liveIdea(tx: Tx, userId: string, id: string): Promise<IdeaRow> {
  const row = await tx.memoryIdea.findFirst({ where: { id, userId, deletedAt: null }, include: withSources });
  if (!row) throw new MemoryIdeaError("not-found", 404);
  return row;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Keep or add a source. A known source returns its idea. An exact identity
 * joins an existing idea. Anything else is a new idea, and same words in the
 * same city come back as `candidates` for the person to decide. Never joined.
 */
export async function saveIdea(
  userId: string,
  input: SaveIdeaInput,
): Promise<{ idea: MemoryIdeaView; created: boolean; candidates: Array<{ id: string; title: string; city: string | null }> }> {
  const title = requireTitle(input.title);
  const dedupeKey = sourceDedupeKey(input.source);
  const sourceUrl = input.source.url ? canonicalMemoryUrl(input.source.url) : null;
  const canonicalKey = memoryCanonicalKey({ placeId: input.placeId ?? null, catalogKey: input.catalogKey ?? null, url: sourceUrl });
  const attempt = () =>
    prisma.$transaction(async (tx) => {
      if (input.source.screenshotItemId) {
        const owned = await tx.screenshotItem.findFirst({
          where: { id: input.source.screenshotItemId, userId, deletedAt: null },
          select: { id: true },
        });
        if (!owned) throw new MemoryIdeaError("source-not-found", 404);
      }
      if (input.source.wishlistItemId) {
        const owned = await tx.wishlistItem.findFirst({ where: { id: input.source.wishlistItemId, userId }, select: { id: true } });
        if (!owned) throw new MemoryIdeaError("source-not-found", 404);
      }
      const known = await tx.memoryIdeaSource.findUnique({ where: { userId_dedupeKey: { userId, dedupeKey } } });
      if (known) return { row: await liveIdea(tx, userId, known.ideaId), created: false };

      const sameIdea = canonicalKey
        ? await tx.memoryIdea.findFirst({ where: { userId, canonicalKey, deletedAt: null }, select: { id: true } })
        : null;
      const sourceData = {
        userId,
        kind: input.source.kind,
        dedupeKey,
        screenshotItemId: input.source.screenshotItemId ?? null,
        wishlistItemId: input.source.wishlistItemId ?? null,
        url: sourceUrl,
        quote: clip(input.source.quote, MEMORY_NOTE_MAX),
        provenance: input.source.provenance,
      };
      if (sameIdea) {
        const source = await tx.memoryIdeaSource.create({ data: { ...sourceData, ideaId: sameIdea.id, originIdeaId: sameIdea.id } });
        await tx.memoryIdea.update({ where: { id: sameIdea.id }, data: { version: { increment: 1 } } });
        await recordEvent(tx, { id: sameIdea.id, userId }, input.source.provenance === "person" ? "person" : "system", "source_added", { sourceId: source.id, kind: source.kind }, input.idempotencyKey);
        return { row: await liveIdea(tx, userId, sameIdea.id), created: false };
      }
      const count = await tx.memoryIdea.count({ where: { userId, deletedAt: null } });
      if (count >= MEMORY_IDEAS_MAX_PER_USER) throw new MemoryIdeaError("limit-reached", 409);
      const answered = input.reason ? { reason: input.reason, reasonAnsweredAt: new Date(), recipient: clip(input.recipient, MEMORY_RECIPIENT_MAX) } : {};
      const row = await tx.memoryIdea.create({
        data: {
          userId,
          kind: input.kind,
          title,
          note: clip(input.note, MEMORY_NOTE_MAX),
          canonicalKey,
          placeId: input.placeId ?? null,
          placeProvenance: input.placeId ? (input.source.provenance === "person" ? "person" : "external") : null,
          city: clip(input.city, 80),
          eventAt: input.eventAt ?? null,
          eventTimezone: input.eventTimezone ?? null,
          intent: input.intent ?? "interested",
          ...answered,
        },
      });
      const source = await tx.memoryIdeaSource.create({ data: { ...sourceData, ideaId: row.id, originIdeaId: row.id } });
      await recordEvent(tx, row, input.source.provenance === "person" ? "person" : "system", "created", { sourceId: source.id, kind: source.kind }, input.idempotencyKey);
      return { row: await liveIdea(tx, userId, row.id), created: true };
    });

  let outcome: { row: IdeaRow; created: boolean };
  try {
    outcome = await attempt();
  } catch (err) {
    // Two taps raced on one identity: the winner's idea is the answer.
    if (!isUniqueViolation(err)) throw err;
    outcome = await attempt();
  }
  const candidates = outcome.created ? await sameWordCandidates(userId, outcome.row) : [];
  return { idea: ideaView(outcome.row), created: outcome.created, candidates };
}

async function sameWordCandidates(userId: string, row: IdeaRow): Promise<Array<{ id: string; title: string; city: string | null }>> {
  if (!row.city) return [];
  const others = await prisma.memoryIdea.findMany({
    where: { userId, deletedAt: null, kind: row.kind, id: { not: row.id }, city: { equals: row.city, mode: "insensitive" } },
    select: { id: true, title: true, city: true, kind: true },
    take: 200,
  });
  return others.filter((other) => possiblySameIdea(row, other)).map(({ id, title, city }) => ({ id, title, city })).slice(0, 5);
}

/** The one-write path: owner check, version check, repeat guard, history. */
async function change(
  userId: string,
  id: string,
  options: { actor: MemoryActor; type: string; idempotencyKey?: string | undefined; expectedVersion?: number | undefined },
  apply: (row: IdeaRow, tx: Tx) => Promise<{ data: Prisma.MemoryIdeaUpdateManyMutationInput; payload?: Prisma.InputJsonValue }>,
): Promise<MemoryIdeaView> {
  const row = await prisma.$transaction(async (tx) => {
    const current = await liveIdea(tx, userId, id);
    if (options.idempotencyKey) {
      const seen = await tx.memoryIdeaEvent.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: options.idempotencyKey } }, select: { id: true } });
      if (seen) return current;
    }
    if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
      throw new MemoryIdeaError("version-conflict", 409);
    }
    const { data, payload } = await apply(current, tx);
    const updated = await tx.memoryIdea.updateMany({
      where: { id, userId, deletedAt: null, version: current.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (updated.count === 0) throw new MemoryIdeaError("version-conflict", 409);
    await recordEvent(tx, current, options.actor, options.type, payload, options.idempotencyKey);
    return liveIdea(tx, userId, id);
  });
  return ideaView(row);
}

export interface ChangeOptions {
  idempotencyKey?: string;
  expectedVersion?: number;
  actor?: MemoryActor;
}

export async function getIdea(userId: string, id: string): Promise<MemoryIdeaView> {
  const row = await prisma.memoryIdea.findFirst({ where: { id, userId, deletedAt: null }, include: withSources });
  if (!row) throw new MemoryIdeaError("not-found", 404);
  return ideaView(row);
}

export async function listIdeas(
  userId: string,
  options: { kind?: string; intent?: string; query?: string; before?: Date; limit?: number } = {},
): Promise<{ items: MemoryIdeaView[]; nextBefore: string | null }> {
  const limit = Math.min(options.limit ?? MEMORY_IDEAS_PAGE, MEMORY_IDEAS_PAGE);
  const query = options.query?.trim();
  const rows = await prisma.memoryIdea.findMany({
    where: {
      userId,
      deletedAt: null,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.intent ? { intent: options.intent } : {}),
      ...(options.before ? { updatedAt: { lt: options.before } } : {}),
      ...(query
        ? { OR: [{ title: { contains: query, mode: "insensitive" as const } }, { note: { contains: query, mode: "insensitive" as const } }, { recipient: { contains: query, mode: "insensitive" as const } }] }
        : {}),
    },
    include: withSources,
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  const last = rows.at(-1);
  return { items: rows.map(ideaView), nextBefore: rows.length === limit && last ? last.updatedAt.toISOString() : null };
}

/**
 * The person's stance. `planned` belongs to a real plan, so only `markPlanned`
 * sets it, and no stance here cancels a date or claims a visit.
 */
export async function setIntent(userId: string, id: string, intent: MemoryIntent, options: ChangeOptions = {}): Promise<MemoryIdeaView> {
  if (intent === "planned") throw new MemoryIdeaError("planned-needs-a-date", 409);
  return change(userId, id, { ...options, actor: options.actor ?? "person", type: "intent" }, async (row) => ({
    data: { intent, intentBeforePlan: null },
    payload: { from: row.intent, to: intent },
  }));
}

/**
 * The person's answer to why they saved it. A gift for someone else and a plain
 * reference stop every wider use: they are not this person's wish, and a later
 * correction has to grant again, so a grant cannot silently return.
 */
export async function setReason(
  userId: string,
  id: string,
  reason: MemoryReason,
  recipient: string | null,
  options: ChangeOptions = {},
): Promise<MemoryIdeaView> {
  return change(userId, id, { ...options, actor: "person", type: "reason" }, async (row, tx) => {
    const narrowing = reason === "gift" || reason === "reference";
    if (narrowing) await cancelReminders(tx, id);
    return {
      data: {
        reason,
        recipient: reason === "gift" ? clip(recipient, MEMORY_RECIPIENT_MAX) : null,
        reasonAnsweredAt: new Date(),
        reasonSnoozedUntil: null,
        ...(narrowing ? { allowOwnDates: false, allowMatching: false, allowPartner: false } : {}),
      },
      payload: { from: row.reason, to: reason },
    };
  });
}

export async function snoozeReason(userId: string, id: string, now: Date = new Date()): Promise<MemoryIdeaView> {
  return change(userId, id, { actor: "person", type: "reason_snoozed" }, async () => ({
    data: { reasonSnoozedUntil: new Date(now.getTime() + MEMORY_REASON_SNOOZE_MS) },
  }));
}

/** New ideas worth one short question, oldest first, a few at a time. */
export async function reasonQuestions(userId: string, now: Date = new Date()): Promise<MemoryIdeaView[]> {
  const rows = await prisma.memoryIdea.findMany({
    where: {
      userId,
      deletedAt: null,
      reason: null,
      intent: { not: "dropped" },
      OR: [{ reasonSnoozedUntil: null }, { reasonSnoozedUntil: { lt: now } }],
    },
    include: withSources,
    orderBy: { createdAt: "asc" },
    take: MEMORY_REASON_QUESTIONS_MAX,
  });
  return rows.map(ideaView);
}

const USE_FIELD: Record<MemoryUse, "allowOwnDates" | "allowMatching" | "allowPartner"> = {
  own_dates: "allowOwnDates",
  matching: "allowMatching",
  partner: "allowPartner",
};

/**
 * One use on or off. Turning on needs the person (never the system) and refuses
 * what the idea cannot mean: a gift or a reference is not a wish of their own.
 * Turning off takes effect at commit, and consumers read these columns live.
 */
export async function setUsage(userId: string, id: string, use: MemoryUse, allow: boolean, options: ChangeOptions = {}): Promise<MemoryIdeaView> {
  const actor = options.actor ?? "person";
  if (allow && actor !== "person") throw new MemoryIdeaError("needs-the-person", 403);
  return change(userId, id, { ...options, actor, type: "usage" }, async (row, tx) => {
    if (allow && (row.reason === "gift" || row.reason === "reference")) throw new MemoryIdeaError("not-own-wish", 409);
    if (!allow && use === "own_dates") await cancelReminders(tx, id);
    return { data: { [USE_FIELD[use]]: allow }, payload: { use, allow } };
  });
}

/** «Только для меня»: the absence of grants, one call. */
export async function setOnlyForMe(userId: string, id: string, options: ChangeOptions = {}): Promise<MemoryIdeaView> {
  return change(userId, id, { ...options, actor: options.actor ?? "person", type: "only_for_me" }, async (_row, tx) => {
    await cancelReminders(tx, id);
    return { data: { allowOwnDates: false, allowMatching: false, allowPartner: false } };
  });
}

/** Correct or remove the place. No place never blocks keeping the idea. */
export async function setPlace(userId: string, id: string, placeId: string | null, city: string | null, options: ChangeOptions = {}): Promise<MemoryIdeaView> {
  const canonicalKey = memoryCanonicalKey({ placeId });
  try {
    return await change(userId, id, { ...options, actor: "person", type: "place" }, async (row) => ({
      data: {
        placeId,
        placeProvenance: placeId ? "person" : null,
        city: clip(city, 80),
        // A link's identity survives losing a wrong place; a place's does not.
        canonicalKey: canonicalKey ?? (row.canonicalKey?.startsWith("place:") ? null : row.canonicalKey),
      },
      payload: { from: row.placeId, to: placeId },
    }));
  } catch (err) {
    if (isUniqueViolation(err)) throw new MemoryIdeaError("already-an-idea", 409);
    throw err;
  }
}

/** A plan began: the wish is remembered, so a cancelled plan restores it. */
export async function markPlanned(userId: string, id: string, matchId: string): Promise<MemoryIdeaView> {
  return change(userId, id, { actor: "system", type: "planned", idempotencyKey: `planned:${id}:${matchId}` }, async (row) => ({
    data: { intent: "planned", plannedMatchId: matchId, intentBeforePlan: row.intent === "planned" ? row.intentBeforePlan : row.intent },
    payload: { matchId },
  }));
}

/** A plan fell through. The wish returns as it was; a closed wish stays closed. */
export async function releasePlan(userId: string, matchId: string): Promise<number> {
  const rows = await prisma.memoryIdea.findMany({ where: { userId, plannedMatchId: matchId, deletedAt: null }, select: { id: true } });
  for (const { id } of rows) {
    await change(userId, id, { actor: "system", type: "plan_released", idempotencyKey: `released:${id}:${matchId}` }, async (row) => ({
      data: { intent: row.intent === "planned" ? (row.intentBeforePlan ?? "want") : row.intent, plannedMatchId: null, intentBeforePlan: null },
      payload: { matchId },
    }));
  }
  return rows.length;
}

/** Join `fromId` into `intoId`, on the person's word. Each source remembers where it came from. */
export async function mergeIdeas(userId: string, intoId: string, fromId: string, options: ChangeOptions = {}): Promise<MemoryIdeaView> {
  if (intoId === fromId) throw new MemoryIdeaError("same-idea", 400);
  const row = await prisma.$transaction(async (tx) => {
    const into = await liveIdea(tx, userId, intoId);
    const from = await liveIdea(tx, userId, fromId);
    await tx.memoryIdeaSource.updateMany({ where: { ideaId: fromId, userId }, data: { ideaId: intoId } });
    await tx.memoryReminder.updateMany({ where: { ideaId: fromId, state: "pending" }, data: { state: "cancelled" } });
    await tx.memoryIdea.updateMany({
      where: { id: fromId, userId },
      data: { deletedAt: new Date(), canonicalKey: null, version: { increment: 1 } },
    });
    await tx.memoryIdea.update({
      where: { id: intoId },
      data: { version: { increment: 1 }, canonicalKey: into.canonicalKey ?? from.canonicalKey, placeId: into.placeId ?? from.placeId, city: into.city ?? from.city },
    });
    await recordEvent(tx, into, "person", "merged", { fromId, title: from.title, kind: from.kind, reason: from.reason, intent: from.intent, usage: { allowOwnDates: from.allowOwnDates, allowMatching: from.allowMatching, allowPartner: from.allowPartner } }, options.idempotencyKey);
    return liveIdea(tx, userId, intoId);
  });
  return ideaView(row);
}

/**
 * Undo a wrong join: these sources become their own idea with no grants, because
 * a grant was given to the idea they were wrongly part of.
 */
export async function splitIdea(userId: string, id: string, sourceIds: readonly string[], title: string, options: ChangeOptions = {}): Promise<{ kept: MemoryIdeaView; split: MemoryIdeaView }> {
  const cleanTitle = requireTitle(title);
  const out = await prisma.$transaction(async (tx) => {
    const current = await liveIdea(tx, userId, id);
    const moving = current.sources.filter((s) => sourceIds.includes(s.id));
    if (moving.length === 0 || moving.length === current.sources.length) throw new MemoryIdeaError("bad-split", 400);
    const split = await tx.memoryIdea.create({
      data: { userId, kind: current.kind, title: cleanTitle, city: current.city, intent: "interested" },
    });
    await tx.memoryIdeaSource.updateMany({ where: { id: { in: moving.map((s) => s.id) }, userId }, data: { ideaId: split.id } });
    await tx.memoryIdea.update({ where: { id }, data: { version: { increment: 1 } } });
    await recordEvent(tx, current, "person", "split", { intoId: split.id, sourceIds: moving.map((s) => s.id) }, options.idempotencyKey);
    await recordEvent(tx, split, "person", "created", { splitFrom: id });
    return { kept: await liveIdea(tx, userId, id), split: await liveIdea(tx, userId, split.id) };
  });
  return { kept: ideaView(out.kept), split: ideaView(out.split) };
}

/* ── removal ─────────────────────────────────────────────────────────────── */

async function cancelReminders(tx: Tx, ideaId: string): Promise<void> {
  await tx.memoryReminder.updateMany({ where: { ideaId, state: "pending" }, data: { state: "cancelled" } });
}

/** An idea with no reason left to exist goes: its derived text and every grant with it. */
async function closeIdea(tx: Tx, userId: string, id: string, now: Date): Promise<number> {
  await cancelReminders(tx, id);
  const revoked = await tx.memoryPreference.updateMany({
    where: { userId, originIdeaId: id, revokedAt: null },
    data: { revokedAt: now, allowOwnDates: false, allowMatching: false },
  });
  await tx.memoryIdeaSource.deleteMany({ where: { ideaId: id, userId } });
  await tx.memoryIdea.updateMany({
    where: { id, userId, deletedAt: null },
    data: {
      deletedAt: now,
      canonicalKey: null,
      title: "",
      note: null,
      recipient: null,
      placeId: null,
      city: null,
      eventAt: null,
      allowOwnDates: false,
      allowMatching: false,
      allowPartner: false,
      version: { increment: 1 },
    },
  });
  // History states what happened, without the content it no longer may keep.
  await tx.memoryIdeaEvent.updateMany({ where: { ideaId: id, userId }, data: { payload: Prisma.DbNull } });
  return revoked.count;
}

export interface DeletionScope {
  sources: Record<string, number>;
  /** Wishlist positions stay, they have their own «delete». */
  wishlistPositionsKept: number;
  preferencesRevoked: number;
  remindersCancelled: number;
}

/** What «удали эту идею» will actually do, told before it is done. */
export async function deletionScope(userId: string, id: string): Promise<DeletionScope> {
  const row = await prisma.memoryIdea.findFirst({ where: { id, userId, deletedAt: null }, include: withSources });
  if (!row) throw new MemoryIdeaError("not-found", 404);
  const sources: Record<string, number> = {};
  for (const source of row.sources) sources[source.kind] = (sources[source.kind] ?? 0) + 1;
  const [preferencesRevoked, remindersCancelled] = await Promise.all([
    prisma.memoryPreference.count({ where: { userId, originIdeaId: id, revokedAt: null } }),
    prisma.memoryReminder.count({ where: { ideaId: id, state: "pending" } }),
  ]);
  return { sources, wishlistPositionsKept: sources.wishlist ?? 0, preferencesRevoked, remindersCancelled };
}

/**
 * Delete the idea, not what it was built from: a screenshot stays in the library
 * and a wishlist position stays on the list. Repeating it finds nothing to do.
 */
export async function deleteIdea(userId: string, id: string): Promise<void> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const row = await tx.memoryIdea.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true, userId: true } });
    if (!row) return;
    await recordEvent(tx, row, "person", "deleted", undefined);
    await closeIdea(tx, userId, id, now);
  });
}

/** Take one source off. The idea lives on while something else still states it. */
export async function removeSource(userId: string, ideaId: string, sourceId: string): Promise<{ ideaDeleted: boolean }> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const row = await liveIdea(tx, userId, ideaId);
    const removed = await tx.memoryIdeaSource.deleteMany({ where: { id: sourceId, ideaId, userId } });
    if (removed.count === 0) throw new MemoryIdeaError("source-not-found", 404);
    if (row.sources.length <= 1) {
      await closeIdea(tx, userId, ideaId, now);
      return { ideaDeleted: true };
    }
    await tx.memoryIdea.update({ where: { id: ideaId }, data: { version: { increment: 1 } } });
    await recordEvent(tx, row, "person", "source_removed", { kind: row.sources.find((s) => s.id === sourceId)?.kind ?? null });
    return { ideaDeleted: false };
  });
}

/**
 * A screenshot left the library: called in the same transaction that hid it. An
 * idea only those screenshots supported closes, so no hidden copy of a deleted
 * library survives as personalisation; what the person said or linked separately
 * keeps the idea alive.
 */
export async function dropScreenshotSources(tx: Tx, userId: string, screenshotItemIds: readonly string[] | "all"): Promise<void> {
  const where = screenshotItemIds === "all"
    ? { userId, kind: "screenshot" }
    : { userId, screenshotItemId: { in: [...screenshotItemIds] } };
  const rows = await tx.memoryIdeaSource.findMany({ where, select: { ideaId: true } });
  if (rows.length === 0) return;
  await tx.memoryIdeaSource.deleteMany({ where });
  const now = new Date();
  for (const ideaId of new Set(rows.map((r) => r.ideaId))) {
    const left = await tx.memoryIdeaSource.count({ where: { ideaId, userId } });
    if (left === 0) await closeIdea(tx, userId, ideaId, now);
  }
}

/** A wishlist position was removed: the idea loses that source, nothing more. */
export async function dropWishlistSource(userId: string, wishlistItemId: string): Promise<void> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const rows = await tx.memoryIdeaSource.findMany({ where: { userId, wishlistItemId }, select: { ideaId: true } });
    if (rows.length === 0) return;
    await tx.memoryIdeaSource.deleteMany({ where: { userId, wishlistItemId } });
    for (const { ideaId } of rows) {
      const left = await tx.memoryIdeaSource.count({ where: { ideaId, userId } });
      if (left === 0) await closeIdea(tx, userId, ideaId, now);
    }
  });
}

/* ── confirmed preferences ───────────────────────────────────────────────── */

export interface MemoryPreferenceView {
  id: string;
  facet: string;
  value: string;
  originIdeaId: string | null;
  usage: { ownDates: boolean; matching: boolean };
  confirmedAt: string;
}

function preferenceView(row: { id: string; facet: string; value: string; originIdeaId: string | null; allowOwnDates: boolean; allowMatching: boolean; confirmedAt: Date }): MemoryPreferenceView {
  return {
    id: row.id,
    facet: row.facet,
    value: row.value,
    originIdeaId: row.originIdeaId,
    usage: { ownDates: row.allowOwnDates, matching: row.allowMatching },
    confirmedAt: row.confirmedAt.toISOString(),
  };
}

/**
 * Something the person said about themselves, in so many words. Matching stays
 * off until a separate grant. Confirming a revoked value again is a new decision.
 */
export async function confirmPreference(userId: string, facet: MemoryPreferenceFacet, value: string, originIdeaId: string | null = null): Promise<MemoryPreferenceView> {
  const clean = clip(value, MEMORY_PREFERENCE_VALUE_MAX);
  if (!clean) throw new MemoryIdeaError("bad-value", 400);
  if (originIdeaId) await getIdea(userId, originIdeaId);
  const now = new Date();
  const row = await prisma.memoryPreference.upsert({
    where: { userId_facet_value: { userId, facet, value: clean } },
    create: { userId, facet, value: clean, originIdeaId, confirmedAt: now },
    update: { revokedAt: null, confirmedAt: now, allowOwnDates: true, allowMatching: false, ...(originIdeaId ? { originIdeaId } : {}) },
  });
  return preferenceView(row);
}

export async function setPreferenceMatching(userId: string, id: string, allow: boolean): Promise<MemoryPreferenceView> {
  const updated = await prisma.memoryPreference.updateMany({ where: { id, userId, revokedAt: null }, data: { allowMatching: allow } });
  if (updated.count === 0) throw new MemoryIdeaError("not-found", 404);
  const row = await prisma.memoryPreference.findFirstOrThrow({ where: { id, userId } });
  return preferenceView(row);
}

export async function revokePreference(userId: string, id: string): Promise<void> {
  await prisma.memoryPreference.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date(), allowOwnDates: false, allowMatching: false },
  });
}

export async function listPreferences(userId: string): Promise<MemoryPreferenceView[]> {
  const rows = await prisma.memoryPreference.findMany({ where: { userId, revokedAt: null }, orderBy: { confirmedAt: "desc" }, take: 200 });
  return rows.map(preferenceView);
}
