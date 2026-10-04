import { prisma, Prisma } from "@gennety/db";
import {
  CHAT_SESSION_AUTO_TITLE_MAX,
  CHAT_SESSION_DIGEST_BATCH,
  CHAT_SESSION_DIGEST_CHARS,
  CHAT_SESSION_DIGEST_IDLE_MINUTES,
  CHAT_SESSION_DIGEST_MESSAGES,
  CHAT_SESSION_DIGEST_MIN_MESSAGES,
  CHAT_SESSION_DIGEST_ON_OPEN,
  CHAT_SESSION_DIGEST_RESCAN_DAYS,
  CHAT_SESSION_RETITLE_AFTER_MESSAGES,
  CHAT_SESSION_SUMMARY_MAX,
  type Language,
} from "@gennety/shared";
import { env } from "../config.js";
import { MODELS } from "../models.js";
import { callOpenAIJson } from "./openai.js";
import { createOpenAIEmbeddingClient, toPgVectorLiteral } from "./profile-analysis.js";
import { condense } from "./chat-topics.js";

/**
 * Titles and summaries of chat sessions (decision journal 2026-09-30).
 *
 * Both are written by the cheap model (`MODELS.fast`), never on the reply's
 * critical path: a turn fires them and forgets (`afterChatTurn`), and a worker
 * sweep (`workers/chat-session-digest.ts`) catches whatever that missed —
 * including every chat the migration backfilled, which starts untitled.
 *
 * - **Title** — for the history list, in the account language: the topic or
 *   intent of the conversation in 2–6 words, NOT the person's opening line
 *   (the untitled fallback already is that). Written once the chat has its
 *   first assistant reply, refreshed after it has grown by
 *   `CHAT_SESSION_RETITLE_AFTER_MESSAGES`, never once the person renamed it.
 * - **Summary** — for the agent's `search_past_chats`: English (the retrieval
 *   language), 3–6 factual sentences, embedded together with the title. One
 *   call writes both summary and title.
 *
 * Idempotent and bounded: every write is a compare-and-set on the count it was
 * computed from, a failed chat backs off in memory before it is retried, and a
 * chat that has not changed is never sent again.
 */

export interface DigestDeps {
  callJson?: typeof callOpenAIJson;
  /** One embedding for one input — `text-embedding-3-small` by default. */
  embed?: (input: string) => Promise<number[]>;
  now?: () => Date;
}

const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  ru: "Russian",
  uk: "Ukrainian",
  de: "German",
  pl: "Polish",
};

const TITLE_RULES = (language: string) => `- Write it in ${language}.
- 2 to 6 words that name what the conversation is about — its topic or the person's intent — the way a chat list names a chat.
- Never quote or paraphrase the person's first message; describe the subject instead.
- No quotation marks, no emoji, no trailing period. Sentence case: capitalise only the first word and proper names.`;

function titleSystemPrompt(language: string): string {
  return `You name one conversation between a person and Gennety, the AI matchmaking concierge of a dating app, for the person's list of past chats.

Return JSON: {"title": string}.

Title rules:
${TITLE_RULES(language)}`;
}

function summarySystemPrompt(language: string): string {
  return `You write the memory of one past conversation between a person and Gennety, the AI matchmaking concierge of a dating app. Gennety will read it later to find and recall this conversation, so it must be factual and specific.

Return JSON: {"title": string, "summary": string}.

summary:
- In English, whatever language the conversation was in.
- 3 to 6 sentences: what was discussed, what was decided or done, facts the person shared about themselves, and every person, venue, date or time mentioned — names exactly as written.
- Only what was said. No speculation, no advice, no judgement.

title:
${TITLE_RULES(language)}`;
}

const TITLE_SCHEMA = {
  name: "chat_title",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: { title: { type: "string" } },
  },
};

const SUMMARY_SCHEMA = {
  name: "chat_summary",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "summary"],
    properties: { title: { type: "string" }, summary: { type: "string" } },
  },
};

/** Double quotes and guillemets go wherever they are. */
const DOUBLE_QUOTES = /["“”„‟«»‹›]/g;
/**
 * Single quotes only where they QUOTE — at a word edge. Inside a word they are
 * letters: Ukrainian writes «п'ятниця», English «Anna's».
 */
const EDGE_SINGLE_QUOTES = /(^|\s)['‘’‚`]+|['‘’‚`]+(?=\s|$)/g;
/** Pictographs plus the joiners and selectors that glue emoji sequences together. */
const EMOJI = /\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}/gu;
const TRAILING_PUNCTUATION = /[\s.,;:!…。]+$/u;

/**
 * Make a model-written title safe to show: no quotes, emoji, line breaks or
 * trailing period, first letter capitalised, at most
 * `CHAT_SESSION_AUTO_TITLE_MAX` characters cut on a word. `null` when nothing
 * usable is left.
 */
export function sanitizeChatTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let title = raw
    .normalize("NFC")
    .replace(EMOJI, "")
    .replace(DOUBLE_QUOTES, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(EDGE_SINGLE_QUOTES, "$1")
    .replace(/^title\s*:\s*/i, "")
    .replace(TRAILING_PUNCTUATION, "")
    .trim();
  if (title.length > CHAT_SESSION_AUTO_TITLE_MAX) {
    const cut = title.slice(0, CHAT_SESSION_AUTO_TITLE_MAX);
    const lastSpace = cut.lastIndexOf(" ");
    title = (lastSpace > CHAT_SESSION_AUTO_TITLE_MAX * 0.5 ? cut.slice(0, lastSpace) : cut)
      .replace(TRAILING_PUNCTUATION, "")
      .trim();
  }
  if (!/[\p{L}\p{N}]/u.test(title)) return null;
  return title.charAt(0).toLocaleUpperCase() + title.slice(1);
}

/** A stored summary: one paragraph, capped. `null` when empty. */
export function sanitizeChatSummary(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const flat = raw.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= CHAT_SESSION_SUMMARY_MAX) return flat;
  const cut = flat.slice(0, CHAT_SESSION_SUMMARY_MAX);
  const sentenceEnd = cut.lastIndexOf(". ");
  return sentenceEnd > CHAT_SESSION_SUMMARY_MAX * 0.6 ? cut.slice(0, sentenceEnd + 1) : cut;
}

/** Letters and digits only, lower-cased — what "the same words" means below. */
function comparable(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The sanitised title, unless it is the person's opening line again — the one
 * thing the product decision rules out (the untitled fallback already shows
 * it). Caught when the title IS the opener, or is its first three-plus words.
 */
export function acceptChatTitle(raw: unknown, opener: string | null): string | null {
  const title = sanitizeChatTitle(raw);
  if (!title) return null;
  if (!opener) return title;
  const t = comparable(title);
  const o = comparable(opener);
  if (!t || !o) return title;
  if (t === o) return null;
  if (o.startsWith(`${t} `) && t.split(" ").length >= 3) return null;
  return title;
}

export interface DigestRow {
  role: string;
  content: string;
  imageUrl: string | null;
  imageUrls: string[];
}

const DIGEST_LINE_MAX = 600;

function digestLine(row: DigestRow): string {
  const photos = row.imageUrls.length > 0 ? row.imageUrls.length : row.imageUrl ? 1 : 0;
  const text = condense(row.content ?? "", DIGEST_LINE_MAX);
  const media = photos > 1 ? `[${photos} photos]` : photos === 1 ? "[photo]" : "";
  const who = row.role === "user" ? "Person" : "Gennety";
  return `${who}: ${[text, media].filter(Boolean).join(" ")}`;
}

/**
 * The conversation as the titler / summarizer reads it, oldest first. Over the
 * character budget, the opening two lines stay (they say what the chat was
 * started for) and the newest lines fill the rest.
 */
export function renderDigestTranscript(
  rows: DigestRow[],
  maxChars: number = CHAT_SESSION_DIGEST_CHARS,
): string {
  const lines = rows.map(digestLine);
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= maxChars) return lines.join("\n");
  const head = lines.slice(0, 2);
  let budget = maxChars - head.reduce((sum, line) => sum + line.length + 1, 0) - 32;
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 2 && budget > 0; i--) {
    const line = lines[i]!;
    if (line.length + 1 > budget) break;
    tail.unshift(line);
    budget -= line.length + 1;
  }
  return [...head, "[… earlier messages omitted …]", ...tail].join("\n");
}

interface DigestInput {
  session: {
    id: string;
    userId: string;
    title: string | null;
    titleByUser: boolean;
    titledAtCount: number;
    summarizedAtCount: number;
  };
  language: Language;
  /** Non-system messages in the chat. */
  count: number;
  rows: DigestRow[];
  hasAssistant: boolean;
  /** The person's first line — what a title must not simply repeat. */
  opener: string | null;
}

async function loadDigestInput(sessionId: string): Promise<DigestInput | null> {
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      title: true,
      titleByUser: true,
      titledAtCount: true,
      summarizedAtCount: true,
      user: { select: { language: true } },
    },
  });
  if (!session) return null;
  const where = { sessionId, role: { not: "system" as const } };
  const [count, newest] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: CHAT_SESSION_DIGEST_MESSAGES,
      select: { role: true, content: true, imageUrl: true, imageUrls: true },
    }),
  ]);
  const rows = newest.reverse();
  let opener = rows.find((row) => row.role === "user" && row.content.trim())?.content ?? null;
  if (count > rows.length) {
    const first = await prisma.message.findFirst({
      where: { sessionId, role: "user", NOT: { content: "" } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { content: true },
    });
    opener = first?.content ?? opener;
  }
  const { user, ...rest } = session;
  return {
    session: rest,
    language: (user.language ?? "en") as Language,
    count,
    rows,
    hasAssistant: rows.some((row) => row.role === "assistant"),
    opener,
  };
}

/**
 * Is an automatic title due? Never over a hand-set one; the first once the
 * chat has its first assistant reply; a refresh once it has grown by
 * `CHAT_SESSION_RETITLE_AFTER_MESSAGES` since the last titling.
 */
export function titleDue(
  session: { title: string | null; titleByUser: boolean; titledAtCount: number },
  count: number,
  hasAssistant: boolean,
): boolean {
  if (session.titleByUser) return false;
  if (count < CHAT_SESSION_DIGEST_MIN_MESSAGES) return false;
  if (session.title === null) return hasAssistant && session.titledAtCount < count;
  return count - session.titledAtCount >= CHAT_SESSION_RETITLE_AFTER_MESSAGES;
}

/** Is the summary stale — has the chat grown since it was written? */
export function summaryDue(session: { summarizedAtCount: number }, count: number): boolean {
  return count >= CHAT_SESSION_DIGEST_MIN_MESSAGES && session.summarizedAtCount < count;
}

export type DigestOutcome = "titled" | "summarized" | "rejected" | "skipped" | "failed";

/**
 * Title one chat if a title is due. A model answer that is unusable (empty, or
 * the opening line again) still records the attempt — `titledAtCount` moves —
 * so the same conversation is not sent again until it has grown. A failed call
 * records nothing and is retried.
 */
export async function maybeTitleChatSession(
  sessionId: string,
  deps: DigestDeps = {},
): Promise<DigestOutcome> {
  const input = await loadDigestInput(sessionId);
  if (!input || !titleDue(input.session, input.count, input.hasAssistant)) return "skipped";
  const call = deps.callJson ?? callOpenAIJson;
  const answer = await call<{ title?: unknown }>(
    titleSystemPrompt(LANGUAGE_NAMES[input.language] ?? "English"),
    renderDigestTranscript(input.rows),
    { model: MODELS.fast, maxTokens: 60, jsonSchema: TITLE_SCHEMA },
  );
  if (!answer) return "failed";
  const title = acceptChatTitle(answer.title, input.opener);
  // CAS on the count this title was computed from, and never over a rename
  // that landed while the model was thinking.
  await prisma.chatSession.updateMany({
    where: { id: sessionId, titleByUser: false, titledAtCount: input.session.titledAtCount },
    data: { ...(title ? { title } : {}), titledAtCount: input.count },
  });
  return title ? "titled" : "rejected";
}

let defaultEmbed: ((input: string) => Promise<number[]>) | null = null;

function embedder(deps: DigestDeps): ((input: string) => Promise<number[]>) | null {
  if (deps.embed) return deps.embed;
  if (!env.OPENAI_API_KEY) return null;
  if (!defaultEmbed) {
    const client = createOpenAIEmbeddingClient(env.OPENAI_API_KEY);
    defaultEmbed = (input) => client.embed(input);
  }
  return defaultEmbed;
}

/**
 * Summarize one chat whose summary is stale, re-title it in the same call
 * (unless the person named it), and embed title + summary for search.
 *
 * Nothing is written unless the embedding landed too: a summary the search
 * cannot find is worse than none, because "unsummarized" is what the keyword
 * fallback covers. One statement, CAS on `summarized_at_count`, and the title
 * guarded by `title_by_user` inside it — a rename mid-call wins.
 */
export async function summarizeChatSession(
  sessionId: string,
  deps: DigestDeps = {},
): Promise<DigestOutcome> {
  const input = await loadDigestInput(sessionId);
  if (!input) return "skipped";
  if (!summaryDue(input.session, input.count)) {
    // A fresh summary with a title still owed — only reachable by hand-edited
    // rows, but a sweep must never pick the same chat forever for nothing.
    return titleDue(input.session, input.count, input.hasAssistant)
      ? maybeTitleChatSession(sessionId, deps)
      : "skipped";
  }
  const embed = embedder(deps);
  if (!embed) return "failed";
  const call = deps.callJson ?? callOpenAIJson;
  const answer = await call<{ title?: unknown; summary?: unknown }>(
    summarySystemPrompt(LANGUAGE_NAMES[input.language] ?? "English"),
    renderDigestTranscript(input.rows),
    { model: MODELS.fast, maxTokens: 450, jsonSchema: SUMMARY_SCHEMA },
  );
  if (!answer) return "failed";
  const summary = sanitizeChatSummary(answer.summary);
  if (!summary) return "failed";
  const title = input.session.titleByUser ? null : acceptChatTitle(answer.title, input.opener);

  let vector: number[];
  try {
    vector = await embed([title ?? input.session.title ?? "", summary].filter(Boolean).join("\n"));
  } catch (err) {
    console.warn(`[chat-digest] embedding failed for ${sessionId}:`, err);
    return "failed";
  }

  await prisma.$executeRaw`
    UPDATE chat_sessions SET
      summary = ${summary},
      summary_embedding = ${toPgVectorLiteral(vector)}::vector,
      summarized_at_count = ${input.count},
      title = CASE WHEN title_by_user OR ${title}::text IS NULL THEN title ELSE ${title}::text END,
      titled_at_count = CASE WHEN title_by_user THEN titled_at_count ELSE ${input.count} END
    WHERE id = ${sessionId}::uuid AND summarized_at_count = ${input.session.summarizedAtCount}
  `;
  return "summarized";
}

/* ── Backoff ───────────────────────────────────────────────── */

const RETRY_BASE_MS = 10 * 60 * 1000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1000;
const BACKOFF_ENTRIES_MAX = 5_000;

/**
 * Chats whose digest failed, and when they may be tried again. In memory on
 * purpose: a restart forgetting it costs one retry per chat, and a column for
 * it would be a migration for a cost bound. Doubles per failure, capped at a
 * day, so a chat the model keeps refusing costs one call a day, not one a tick.
 */
const failures = new Map<string, { attempts: number; retryAt: number }>();

function recordOutcome(sessionId: string, outcome: DigestOutcome, now: number): void {
  if (outcome !== "failed") {
    failures.delete(sessionId);
    return;
  }
  if (failures.size >= BACKOFF_ENTRIES_MAX) failures.clear();
  const attempts = (failures.get(sessionId)?.attempts ?? 0) + 1;
  const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
  failures.set(sessionId, { attempts, retryAt: now + delay });
}

function backedOffIds(now: number): string[] {
  return [...failures.entries()].filter(([, e]) => e.retryAt > now).map(([id]) => id);
}

/** Test seam: forget every recorded failure. */
export function resetChatDigestBackoff(): void {
  failures.clear();
}

/* ── Picking the chats to digest ───────────────────────────── */

/** `timestamp(3)` columns hold UTC wall time; compare against the same. */
function utcWallTime(at: Date): Prisma.Sql {
  return Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/**
 * Chats owing a summary (or, unreachable in practice, a first title), freshest
 * first. A summarized chat quiet for `CHAT_SESSION_DIGEST_RESCAN_DAYS` is not
 * even counted: any new message would have moved its `updated_at` inside that
 * window, so its summary cannot be stale.
 */
async function findChatsToDigest(opts: {
  scope: Prisma.Sql;
  exclude: string[];
  limit: number;
  now: Date;
}): Promise<string[]> {
  const rescanFrom = new Date(opts.now.getTime() - CHAT_SESSION_DIGEST_RESCAN_DAYS * 86_400_000);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s.id
    FROM chat_sessions s
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n
      FROM messages m
      WHERE m.session_id = s.id AND m.role <> 'system'
    ) c
    WHERE ${opts.scope}
      AND (s.summary IS NULL OR s.updated_at > ${utcWallTime(rescanFrom)})
      AND c.n >= ${CHAT_SESSION_DIGEST_MIN_MESSAGES}
      AND (
        s.summarized_at_count < c.n
        OR (NOT s.title_by_user AND s.title IS NULL AND s.titled_at_count < c.n)
      )
      AND NOT (s.id = ANY(${opts.exclude}::uuid[]))
    ORDER BY s.updated_at DESC
    LIMIT ${opts.limit}
  `;
  return rows.map((row) => row.id);
}

async function digestAll(ids: string[], deps: DigestDeps, now: number): Promise<DigestOutcome[]> {
  const outcomes: DigestOutcome[] = [];
  // One at a time: this runs beside live turns, and a burst of parallel calls
  // is exactly what would slow the replies it must never touch.
  for (const id of ids) {
    let outcome: DigestOutcome;
    try {
      outcome = await summarizeChatSession(id, deps);
    } catch (err) {
      console.warn(`[chat-digest] ${id} failed:`, err);
      outcome = "failed";
    }
    recordOutcome(id, outcome, now);
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * A turn just opened a new chat: summarize the person's other chats whose
 * summary is stale — most often the one they just left — so the new chat's
 * `search_past_chats` can find them. A few at most; the sweep does the rest.
 */
export async function summarizeStaleChatSessions(
  userId: string,
  opts: { excludeSessionId: string; limit?: number },
  deps: DigestDeps = {},
): Promise<DigestOutcome[]> {
  const now = (deps.now ?? (() => new Date()))();
  const ids = await findChatsToDigest({
    scope: Prisma.sql`s.user_id = ${userId}::uuid`,
    exclude: [opts.excludeSessionId, ...backedOffIds(now.getTime())],
    limit: opts.limit ?? CHAT_SESSION_DIGEST_ON_OPEN,
    now,
  });
  return digestAll(ids, deps, now.getTime());
}

export interface ChatDigestSweepResult {
  scanned: number;
  summarized: number;
  failed: number;
}

/**
 * The worker's pass: chats quiet for `CHAT_SESSION_DIGEST_IDLE_MINUTES` that
 * owe a summary or a title, freshest first, a small batch per tick. After a
 * deploy this is what titles and summarizes the backfilled history.
 */
export async function sweepChatSessionDigests(
  deps: DigestDeps & { batch?: number } = {},
): Promise<ChatDigestSweepResult> {
  if (!deps.embed && !env.OPENAI_API_KEY) return { scanned: 0, summarized: 0, failed: 0 };
  const now = (deps.now ?? (() => new Date()))();
  const idleSince = new Date(now.getTime() - CHAT_SESSION_DIGEST_IDLE_MINUTES * 60_000);
  const ids = await findChatsToDigest({
    scope: Prisma.sql`s.updated_at < ${utcWallTime(idleSince)}`,
    exclude: backedOffIds(now.getTime()),
    limit: deps.batch ?? CHAT_SESSION_DIGEST_BATCH,
    now,
  });
  const outcomes = await digestAll(ids, deps, now.getTime());
  return {
    scanned: ids.length,
    summarized: outcomes.filter((o) => o === "summarized" || o === "titled").length,
    failed: outcomes.filter((o) => o === "failed").length,
  };
}

/**
 * Everything a finished turn owes the chat's memory, fired and forgotten: the
 * title (first or refreshed), and — when the turn opened a new chat — the
 * summaries of the person's other chats. Errors are logged, never thrown: the
 * reply has already been written and must not wait on any of this.
 */
export function afterChatTurn(input: {
  userId: string;
  sessionId: string;
  openedNewSession: boolean;
}): void {
  void maybeTitleChatSession(input.sessionId).catch((err: unknown) => {
    console.warn(`[chat-digest] title for ${input.sessionId} failed:`, err);
  });
  if (input.openedNewSession) {
    void summarizeStaleChatSessions(input.userId, { excludeSessionId: input.sessionId }).catch(
      (err: unknown) => {
        console.warn(`[chat-digest] summaries for ${input.userId} failed:`, err);
      },
    );
  }
}
