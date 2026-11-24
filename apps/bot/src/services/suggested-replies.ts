import { createHash } from "node:crypto";
import { Prisma, prisma } from "@gennety/db";
import {
  CONCEPT_RULES,
  SUGGESTED_REPLIES,
  chipTextForbidden,
  cityKeyToTimeZone,
  isLeavingTurn,
  isValidTimeZone,
  normalizeChipText,
  t,
  tv,
  type Language,
  type SuggestedReplyKind,
} from "@gennety/shared";
import { MODELS } from "../models.js";
import { callOpenAIJson, type OpenAICallOptions } from "./openai.js";
import { moderateTextWithOpenAI } from "./profile-media-validation/openai-moderation.js";
import { agentRemindersOn, suggestedRepliesOn, suggestedRepliesPreview } from "./feature-preview.js";
import { touchChatSession } from "./chat-sessions.js";

/**
 * Suggested replies under the agent's message (decision 2026-11-19,
 * `docs/product/domains/suggested-replies.md`).
 *
 * A chip exists for three reasons only: it saves typing an answer to the
 * agent's own question, it is a real step towards a date the agent can carry
 * out, or it lets the person leave without guilt. Everything else is no chip.
 *
 * Owns everything about them — gates, the cheap model call, the filter, the
 * exit line, storage and the tap — so the persona (`prompt-builder.ts`), the
 * statuses (`chat-activity.ts`) and the tool loop (`chat-agent.ts`) stay
 * untouched. The reply is never held for the chips: the route starts
 * {@link startAppReplies} after the turn and the app asks for them.
 */

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ru: "Russian",
  uk: "Ukrainian",
  de: "German",
  pl: "Polish",
};

export interface StoredReply {
  id: string;
  kind: SuggestedReplyKind;
  text: string;
  /** For a `step`: the catalogue key it maps to. */
  step?: StepKey;
}

/** `messages.attachment` of an assistant row with chips, kind `suggested_replies`. */
export interface SuggestedRepliesAttachment {
  kind: "suggested_replies";
  items: StoredReply[];
  /** The id the person tapped, once. */
  tapped?: string | null;
  tappedAt?: string | null;
  /** Danger was seen in this chat: no chips until it ends. */
  safety?: boolean;
  at: string;
}

export interface ReplyView {
  id: string;
  kind: SuggestedReplyKind;
  text: string;
}

export function replyViews(items: readonly StoredReply[]): ReplyView[] {
  return items.map(({ id, kind, text }) => ({ id, kind, text }));
}

export function readSuggestedReplies(raw: unknown): SuggestedRepliesAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<SuggestedRepliesAttachment>;
  if (value.kind !== "suggested_replies" || !Array.isArray(value.items)) return null;
  const items = value.items.filter(
    (item): item is StoredReply =>
      Boolean(item) &&
      typeof item.id === "string" &&
      typeof item.text === "string" &&
      ["answer", "step", "clarify", "close"].includes(item.kind as string),
  );
  return {
    kind: "suggested_replies",
    items,
    tapped: typeof value.tapped === "string" ? value.tapped : null,
    tappedAt: typeof value.tappedAt === "string" ? value.tappedAt : null,
    safety: value.safety === true,
    at: typeof value.at === "string" ? value.at : new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Steps towards offline — only what the agent can do right now
// ---------------------------------------------------------------------------

export type StepKey = "my_date" | "venue_change" | "date_feedback" | "events" | "remind";

export interface DateFacts {
  /** A booked date still ahead. */
  scheduledDate: boolean;
  /** A date in the last three days with no feedback of theirs yet. */
  recentDateWithoutFeedback: boolean;
}

export type Surface = "app" | "telegram";

const STEP_INTENTS: Record<StepKey, string> = {
  my_date: "ask where and when their booked date is (place and time)",
  venue_change: "ask to change the place of their booked date",
  date_feedback: "tell the agent how their recent date went",
  events: "ask what is on this weekend or check an event they mentioned",
  remind: "ask to be reminded later of the one concrete thing the reply told them to do (e.g. «Напомни в пятницу»), only when the reply named such an action and a moment",
};

/** Steps the person could take through the agent on this turn. */
export function availableSteps(
  facts: DateFacts,
  options: { surface: Surface; eventsTool: boolean; reminders?: boolean },
): StepKey[] {
  const steps: StepKey[] = [];
  if (facts.scheduledDate) steps.push("my_date", "venue_change");
  if (facts.recentDateWithoutFeedback) steps.push("date_feedback");
  if (options.surface === "app" && options.eventsTool) steps.push("events");
  // Personal reminders (decision 2026-11-20): the agent has `set_reminder`.
  if (options.reminders) steps.push("remind");
  return steps;
}

const RECENT_DATE_MS = 3 * 24 * 60 * 60 * 1000;

export async function loadDateFacts(userId: string, now: Date = new Date()): Promise<DateFacts> {
  const matches = await prisma.match.findMany({
    where: {
      OR: [{ userAId: userId }, { userBId: userId }],
      status: { in: ["scheduled", "completed"] },
      agreedTime: { gte: new Date(now.getTime() - RECENT_DATE_MS) },
    },
    select: { userAId: true, status: true, agreedTime: true, feedbackByA: true, feedbackByB: true },
    take: 5,
  });
  let scheduledDate = false;
  let recentDateWithoutFeedback = false;
  for (const m of matches) {
    const mine = m.userAId === userId ? m.feedbackByA : m.feedbackByB;
    if (m.status === "scheduled" && m.agreedTime && m.agreedTime > now) scheduledDate = true;
    if (m.agreedTime && m.agreedTime <= now && !mine) recentDateWithoutFeedback = true;
  }
  return { scheduledDate, recentDateWithoutFeedback };
}

// ---------------------------------------------------------------------------
// Gates — code decides first
// ---------------------------------------------------------------------------

/** Stable 10% of people who get no chips, for the comparison (spec Phase 4). */
export function inHoldout(userId: string, percent: number = SUGGESTED_REPLIES.holdoutPercent): boolean {
  if (suggestedRepliesPreview(userId)) return false;
  const byte = createHash("sha256").update(`suggested-replies:${userId.toLowerCase()}`).digest()[0]!;
  return (byte * 100) / 256 < percent;
}

/** The person's zone: the profile's own, else the home city's. */
export function personTimeZone(profile: { timeZone?: string | null; homeCityKey?: string | null } | null | undefined): string {
  const own = profile?.timeZone?.trim();
  if (own && isValidTimeZone(own)) return own;
  return cityKeyToTimeZone(profile?.homeCityKey ?? null);
}

export function localHour(now: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(now);
  return Number(hour) % 24;
}

export function isNight(now: Date, timeZone: string): boolean {
  const h = localHour(now, timeZone);
  return h >= SUGGESTED_REPLIES.nightFromHour || h < SUGGESTED_REPLIES.nightToHour;
}

export interface GateFacts {
  enabled: boolean;
  holdout: boolean;
  /** The reply carries a card or a button — that is already the next step. */
  replyHasCard: boolean;
  userText: string;
  safetyLatched: boolean;
  /** Shown-and-ignored sets on the agent's previous replies, newest first, counted in a row. */
  ignoredInARow: number;
  /** The person's turns in this chat, this one included. */
  turnsInChat: number;
  chatStartedAt: Date | null;
  now: Date;
  timeZone: string;
}

export type GateVerdict =
  | { ask: false; reason: string }
  | { ask: true; wantExit: boolean; night: boolean };

export function chipsGate(f: GateFacts): GateVerdict {
  if (!f.enabled) return { ask: false, reason: "off" };
  if (f.holdout) return { ask: false, reason: "holdout" };
  if (f.replyHasCard) return { ask: false, reason: "card" };
  if (f.safetyLatched) return { ask: false, reason: "safety" };
  // Agent concept rule 6: one warm line and nothing after it — not even the exit.
  if (isLeavingTurn(f.userText)) return { ask: false, reason: "leaving" };
  if (f.ignoredInARow >= SUGGESTED_REPLIES.ignoredInARowStop) return { ask: false, reason: "ignored" };
  const night = isNight(f.now, f.timeZone);
  const long =
    f.turnsInChat >= SUGGESTED_REPLIES.exitAfterTurns ||
    (f.chatStartedAt !== null && f.now.getTime() - f.chatStartedAt.getTime() >= SUGGESTED_REPLIES.exitAfterMs);
  return { ask: true, wantExit: long || night, night };
}

// ---------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------

export interface ModelChip {
  kind: "answer" | "step" | "clarify";
  text: string;
  step: StepKey | "none";
}

export interface ModelVerdict {
  show: boolean;
  /** The person is upset or sharing something personal: nothing at all, not even the exit. */
  quiet: boolean;
  /** Danger, crisis, a minor: nothing for the rest of this chat. */
  safety: boolean;
  chips: ModelChip[];
}

const VERDICT_SCHEMA = {
  name: "suggested_replies",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["show", "quiet", "safety", "chips"],
    properties: {
      show: { type: "boolean" },
      quiet: { type: "boolean" },
      safety: { type: "boolean" },
      chips: {
        type: "array",
        maxItems: SUGGESTED_REPLIES.maxModelChips,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "text", "step"],
          properties: {
            kind: { type: "string", enum: ["answer", "step", "clarify"] },
            text: { type: "string" },
            step: { type: "string", enum: ["none", "my_date", "venue_change", "date_feedback", "events", "remind"] },
          },
        },
      },
    },
  },
} as const;

export function chipsSystemPrompt(input: { language: Language; steps: readonly StepKey[]; night: boolean }): string {
  const steps = input.steps.length
    ? input.steps.map((key) => `- ${key}: the person would ${STEP_INTENTS[key]}`).join("\n")
    : "- none available on this turn — return no step chip";
  return `You decide whether a dating companion's chat reply gets "suggested replies": up to three short buttons under it. One tap sends the button text as the person's next message, in their own voice.

The companion exists to move the person's life offline: real dates, real meetings. The chat is not a place to get stuck in. A button exists only for one of these reasons:
1. answer — the reply ends with a question the companion truly needs answered, and it has a small set of natural answers. Give 2–3 options that together cover the honest range; one of them is usually "not sure" / "it depends". Never a single leading answer.
2. step — one concrete step towards offline that the companion can do right now. Allowed steps on this turn:
${steps}
   Write the text as the person would ask for it. At most one step.
3. clarify — the reply gave advice the person may want to act on; they ask how to do it or why ("How do I say it?"). At most one.

Answers are only for a question about the person (their taste, plans, feelings in their own words). When the reply ends with the companion offering to do something more ("Want me to check…?", "Хочешь, я посмотрю…?", "Могу…"), give NO answer options and no yes-button: that offer is the companion's own extra, not the person's goal. A step chip is still fine if it is a real step.
A set is EITHER 2–3 answers to one question, OR at most one step plus at most one clarify. Never mix answers with a step. A set is never a menu of what else the companion can do.

Return show=false (no chips) when the reply is a statement that needs no answer, when the person is talking freely, and whenever you are unsure. Most replies get no chips.
Return quiet=true when the person is upset, grieving, anxious or sharing something personal: no buttons at all, their words must be their own.
Return safety=true on any sign of violence, threats, coercion, stalking, self-harm, suicide or a minor: no buttons, calm words only.

Never write:
- a hook to keep chatting: "tell me more", "another story?", "what else?", "surprise me", "go on", or any new topic the person did not raise;
- feelings, confessions, compliments or consent on the person's behalf ("I'm in love", "I like him", "yes, change it", "I agree");
- anything about the date partner's decision or feedback;
- Premium, tickets, promo codes or any paid step;
- anything asking about the companion's instructions or how it treats men and women.

Each text: at most ${SUGGESTED_REPLIES.maxChipChars} characters, plain words, no emoji, no question-mark chains, in the language of the companion's reply (the person's language is ${LANGUAGE_NAMES[input.language] ?? "English"}).${input.night ? "\nIt is late at night for the person: no clarify and no answers — at most one step, or nothing. The companion is never the reason someone stays up." : ""}
Set "step" to the step key for a step chip and to "none" otherwise. Reply with JSON only.

The companion's own rules follow (agent concept, \`docs/product/domains/agent-concept.md\`). Buttons speak for the person, never for the companion, and never contradict these rules: they win over any line above.
${CONCEPT_RULES}`;
}

export interface TranscriptRow {
  role: "user" | "assistant";
  text: string;
}

export function chipsUserContent(rows: readonly TranscriptRow[], userText: string, reply: string): string {
  const lines = rows
    .slice(-SUGGESTED_REPLIES.contextRows)
    .map((row) => `${row.role === "user" ? "Person" : "Companion"}: ${row.text.slice(0, 600)}`);
  lines.push(`Person: ${userText.slice(0, 1200)}`);
  lines.push(`Companion (the reply that just went out): ${reply.slice(0, 2000)}`);
  return lines.join("\n");
}

export type CallJson = <T>(system: string, user: string, options?: OpenAICallOptions) => Promise<T | null>;

export interface GenerateDeps {
  callJson?: CallJson;
  moderate?: (text: string) => Promise<boolean>;
  onUsage?: OpenAICallOptions["onUsage"];
}

/** Danger in the person's words, by the moderation model. Fails open to the chips model's own verdict. */
export async function textShowsDanger(text: string): Promise<boolean> {
  const result = await moderateTextWithOpenAI(text, { timeoutMs: SUGGESTED_REPLIES.modelTimeoutMs });
  if (!result.ok) return false;
  return result.signals.some((signal) =>
    /^(self-harm|violence|sexual\/minors|harassment\/threatening|hate\/threatening)/.test(signal.category),
  );
}

// ---------------------------------------------------------------------------
// The set — code has the last word
// ---------------------------------------------------------------------------

function chipTextOk(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || [...trimmed].length > SUGGESTED_REPLIES.maxChipChars) return false;
  if (!normalizeChipText(trimmed)) return false; // emoji or punctuation only
  if (/\?{2,}|!{2,}/.test(trimmed)) return false;
  return !chipTextForbidden(trimmed);
}

export interface BuildSetInput {
  verdict: ModelVerdict | null;
  wantExit: boolean;
  night: boolean;
  steps: readonly StepKey[];
  language: Language;
}

/**
 * The chips to show, or an empty list. `safety` tells the caller to latch the
 * chat. Every rule of the spec that code can check is checked here, whatever
 * the model returned.
 */
export function buildChipSet(input: BuildSetInput): { items: StoredReply[]; safety: boolean } {
  const { verdict } = input;
  if (verdict?.safety) return { items: [], safety: true };
  if (verdict?.quiet) return { items: [], safety: false };

  const seen = new Set<string>();
  const fresh = (verdict?.show ? verdict.chips : []).filter((chip) => {
    if (!chipTextOk(chip.text)) return false;
    const key = normalizeChipText(chip.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let answers = fresh.filter((c) => c.kind === "answer");
  let step = fresh.find((c) => c.kind === "step" && c.step !== "none" && input.steps.includes(c.step as StepKey));
  let clarify = fresh.find((c) => c.kind === "clarify");

  let picked: ModelChip[];
  if (input.night) {
    answers = [];
    clarify = undefined;
  }
  if (answers.length >= SUGGESTED_REPLIES.minAnswers) {
    // One shape only: answers to one question, never mixed with a step.
    picked = answers.slice(0, SUGGESTED_REPLIES.maxAnswers);
  } else {
    picked = [step, clarify].filter((c): c is ModelChip => Boolean(c));
  }
  if (input.night && picked.length > 1) picked = picked.slice(0, 1);
  step = undefined;

  const items: StoredReply[] = picked.map((chip, i) => ({
    id: `r${i + 1}`,
    kind: chip.kind,
    text: chip.text.trim(),
    ...(chip.kind === "step" && chip.step !== "none" ? { step: chip.step as StepKey } : {}),
  }));
  if (input.wantExit) {
    const exit: StoredReply = { id: "close", kind: "close", text: t(input.language, "repliesCloseChip") };
    if (input.night) items.unshift(exit);
    else items.push(exit);
  }
  return { items, safety: false };
}

export interface GenerateInput {
  language: Language;
  rows: readonly TranscriptRow[];
  userText: string;
  reply: string;
  steps: readonly StepKey[];
  wantExit: boolean;
  night: boolean;
}

/** Model + moderation in parallel, then the code filter. Never throws; fails closed. */
export async function generateChipSet(
  input: GenerateInput,
  deps: GenerateDeps = {},
): Promise<{ items: StoredReply[]; safety: boolean }> {
  const call = deps.callJson ?? callOpenAIJson;
  const moderate = deps.moderate ?? textShowsDanger;
  const [verdict, danger] = await Promise.all([
    call<ModelVerdict>(
      chipsSystemPrompt({ language: input.language, steps: input.steps, night: input.night }),
      chipsUserContent(input.rows, input.userText, input.reply),
      {
        model: MODELS.fast,
        maxTokens: SUGGESTED_REPLIES.maxOutputTokens,
        temperature: 0.3,
        jsonSchema: VERDICT_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
        timeoutMs: SUGGESTED_REPLIES.modelTimeoutMs,
        ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
      },
    ).catch(() => null),
    moderate(input.userText).catch(() => false),
  ]);
  if (danger) return { items: [], safety: true };
  // No verdict (timeout, bad JSON): no chips of the model's — the exit alone
  // still shows on a long chat, which needs no model.
  return buildChipSet({ verdict, wantExit: input.wantExit, night: input.night, steps: input.steps, language: input.language });
}

// ---------------------------------------------------------------------------
// The exit — a code-owned line, no model call
// ---------------------------------------------------------------------------

export function closeLine(language: Language, now: Date, timeZone: string): string {
  const h = localHour(now, timeZone);
  if (h >= SUGGESTED_REPLIES.nightFromHour || h < SUGGESTED_REPLIES.nightToHour) return tv(language, "repliesCloseLineNight");
  if (h >= 18) return t(language, "repliesCloseLineEvening");
  return tv(language, "repliesCloseLineDay");
}

// ---------------------------------------------------------------------------
// App chat: start after the turn, poll, history, tap
// ---------------------------------------------------------------------------

/** Chips calls still running, by assistant message id (one PM2 process, like `chat-activity`). */
const inFlight = new Map<string, Promise<StoredReply[]>>();

export interface AppTurnFacts {
  userId: string;
  sessionId: string;
  messageId: string;
  userText: string;
  reply: string;
  replyHasCard: boolean;
  /** The build listed `replies` in `X-Gennety-Chat-Cards`. */
  buildDraws: boolean;
  /** `check_event` was in this turn's tools. */
  eventsTool: boolean;
  now?: Date;
}

async function appGateFacts(f: AppTurnFacts, now: Date): Promise<GateFacts> {
  const [profile, rows, firstRow, userTurns] = await Promise.all([
    prisma.profile.findUnique({ where: { userId: f.userId }, select: { homeCityKey: true, timeZone: true } }),
    prisma.message.findMany({
      where: { sessionId: f.sessionId, role: "assistant", id: { not: f.messageId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 40,
      select: { attachment: true },
    }),
    prisma.message.findFirst({
      where: { sessionId: f.sessionId },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.message.count({ where: { sessionId: f.sessionId, role: "user" } }),
  ]);
  const sets = rows.map((row) => readSuggestedReplies(row.attachment));
  let ignored = 0;
  for (const set of sets) {
    if (!set || set.items.length === 0) break;
    if (set.tapped) break;
    ignored++;
  }
  return {
    enabled: suggestedRepliesOn(f.userId),
    holdout: inHoldout(f.userId),
    replyHasCard: f.replyHasCard,
    userText: f.userText,
    safetyLatched: sets.some((set) => set?.safety === true),
    ignoredInARow: ignored,
    turnsInChat: userTurns,
    chatStartedAt: firstRow?.createdAt ?? null,
    now,
    timeZone: personTimeZone(profile),
  };
}

async function transcriptBefore(sessionId: string, messageId: string): Promise<TranscriptRow[]> {
  const rows = await prisma.message.findMany({
    where: { sessionId, role: { in: ["user", "assistant"] }, id: { not: messageId } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: SUGGESTED_REPLIES.contextRows + 1,
    select: { role: true, content: true },
  });
  // The newest user row is this turn's own text — the prompt carries it apart.
  return rows
    .slice(1)
    .reverse()
    .filter((row) => row.content.trim())
    .map((row) => ({ role: row.role === "user" ? "user" : "assistant", text: row.content }));
}

async function storeSet(messageId: string, set: { items: StoredReply[]; safety: boolean }, now: Date): Promise<void> {
  if (set.items.length === 0 && !set.safety) return;
  const attachment: SuggestedRepliesAttachment = {
    kind: "suggested_replies",
    items: set.items,
    tapped: null,
    ...(set.safety ? { safety: true } : {}),
    at: now.toISOString(),
  };
  // Never over a card: a reply with a card never gets chips, and this keeps it so.
  await prisma.message.updateMany({
    where: { id: messageId, attachment: { equals: Prisma.DbNull } },
    data: { attachment: attachment as unknown as Prisma.InputJsonValue },
  });
}

/**
 * Decide the gates synchronously enough to answer `repliesPending`, and start
 * the chips call in the background. `false` = no chips for this reply, do not
 * tell the app to ask.
 */
export async function startAppReplies(f: AppTurnFacts, deps: GenerateDeps = {}): Promise<boolean> {
  if (!f.buildDraws || !suggestedRepliesOn(f.userId)) return false;
  const now = f.now ?? new Date();
  let verdict: GateVerdict;
  try {
    verdict = chipsGate(await appGateFacts(f, now));
  } catch (err) {
    console.warn("[replies] gate failed:", err);
    return false;
  }
  if (!verdict.ask) {
    console.info(`[replies] app skip reason=${verdict.reason}`);
    return false;
  }
  const { wantExit, night } = verdict;
  const job = (async (): Promise<StoredReply[]> => {
    const [facts, rows, account] = await Promise.all([
      loadDateFacts(f.userId, now),
      transcriptBefore(f.sessionId, f.messageId),
      prisma.user.findUnique({ where: { id: f.userId }, select: { language: true } }),
    ]);
    const language = (account?.language ?? "en") as Language;
    const steps = availableSteps(facts, { surface: "app", eventsTool: f.eventsTool, reminders: agentRemindersOn(f.userId) });
    const set = await generateChipSet(
      { language, rows, userText: f.userText, reply: f.reply, steps, wantExit, night },
      deps,
    );
    await storeSet(f.messageId, set, now);
    console.info(`[replies] app shown=${set.items.length} kinds=${set.items.map((i) => i.kind).join(",")}${set.safety ? " safety=1" : ""}`);
    return set.items;
  })().catch((err: unknown) => {
    console.warn("[replies] app generation failed:", err);
    return [] as StoredReply[];
  });
  inFlight.set(f.messageId, job);
  void job.finally(() => {
    setTimeout(() => inFlight.delete(f.messageId), 60_000).unref?.();
  });
  return true;
}

/** Chips of the caller's message, only while it is the newest row of its chat. */
export async function appRepliesFor(
  userId: string,
  messageId: string,
  waitMs: number = SUGGESTED_REPLIES.pollWaitMs,
): Promise<ReplyView[] | null> {
  const row = await prisma.message.findUnique({
    where: { id: messageId },
    select: { userId: true, role: true, sessionId: true, createdAt: true },
  });
  if (!row || row.userId !== userId) return null;
  if (row.role !== "assistant") return [];
  const pending = inFlight.get(messageId);
  if (pending) {
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, waitMs))]);
  }
  const [fresh, newer] = await Promise.all([
    prisma.message.findUnique({ where: { id: messageId }, select: { attachment: true } }),
    row.sessionId
      ? prisma.message.count({ where: { sessionId: row.sessionId, createdAt: { gt: row.createdAt } } })
      : Promise.resolve(0),
  ]);
  if (newer > 0) return [];
  const set = readSuggestedReplies(fresh?.attachment);
  if (!set || set.tapped) return [];
  return replyViews(set.items);
}

/** For `/v1/chat/history`: the chips of the newest row of a page that is the end of its chat. */
export function historyReplies(
  rows: ReadonlyArray<{ id: string; role: string; attachment: unknown }>,
  isNewestOfChat: boolean,
): { id: string; replies: ReplyView[] } | null {
  if (!isNewestOfChat || rows.length === 0) return null;
  const last = rows[rows.length - 1]!;
  if (last.role !== "assistant") return null;
  const set = readSuggestedReplies(last.attachment);
  if (!set || set.tapped || set.items.length === 0) return null;
  return { id: last.id, replies: replyViews(set.items) };
}

export interface TapInput {
  userId: string;
  sessionId: string | null;
  messageId: unknown;
  id: unknown;
  text: string;
}

/**
 * A chip tap the server can trust: it names a chip stored on the newest agent
 * row of this chat, and its text is the chip's. Marks the set tapped. Anything
 * else is `null` and the turn is an ordinary typed message.
 */
export async function claimTap(input: TapInput): Promise<StoredReply | null> {
  if (typeof input.messageId !== "string" || typeof input.id !== "string" || !input.sessionId) return null;
  const newest = await prisma.message.findFirst({
    where: { sessionId: input.sessionId, userId: input.userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, role: true, attachment: true },
  });
  if (!newest || newest.id !== input.messageId.toLowerCase() || newest.role !== "assistant") return null;
  const set = readSuggestedReplies(newest.attachment);
  if (!set || set.tapped) return null;
  const chip = set.items.find((item) => item.id === input.id);
  if (!chip || normalizeChipText(chip.text) !== normalizeChipText(input.text)) return null;
  const tappedAt = new Date().toISOString();
  await prisma.message.update({
    where: { id: newest.id },
    data: { attachment: { ...set, tapped: chip.id, tappedAt } as unknown as Prisma.InputJsonValue },
  });
  console.info(`[replies] app tap kind=${chip.kind}`);
  return chip;
}

/** The `close` tap: the person's row and a code-owned line, no model call. */
export async function answerCloseTap(input: {
  userId: string;
  sessionId: string;
  text: string;
  language: Language;
  now?: Date;
}): Promise<{ id: string; content: string; createdAt: Date; userMessageId: string }> {
  const now = input.now ?? new Date();
  const profile = await prisma.profile.findUnique({ where: { userId: input.userId }, select: { homeCityKey: true, timeZone: true } });
  const line = closeLine(input.language, now, personTimeZone(profile));
  const asked = await prisma.message.create({
    data: { userId: input.userId, sessionId: input.sessionId, role: "user", content: input.text, imageUrls: [] },
  });
  const reply = await prisma.message.create({
    data: { userId: input.userId, sessionId: input.sessionId, role: "assistant", content: line, imageUrls: [] },
  });
  await touchChatSession(input.sessionId, reply.createdAt).catch(() => undefined);
  return { id: reply.id, content: reply.content, createdAt: reply.createdAt, userMessageId: asked.id };
}

// ---------------------------------------------------------------------------
// Telegram: a reply keyboard under the agent's last bubble
// ---------------------------------------------------------------------------

/** Six quiet hours end a Telegram agent conversation, as chats end in the app. */
const TELEGRAM_CHAT_GAP_MS = 6 * 60 * 60 * 1000;

export interface TelegramRepliesSession {
  agentReplies?: { items: Array<{ id: string; kind: SuggestedReplyKind; text: string }>; at: number } | null;
  agentRepliesIgnored?: number;
  agentRepliesSafetyAt?: number | null;
  agentChatStartedAt?: number | null;
  agentChatTurns?: number;
  agentChatLastAt?: number | null;
}

/**
 * Called with every free-text turn before the agent runs. Counts the
 * conversation, and returns the chip the text is, if it is one of the set the
 * bot put up. Telegram sends a keyboard tap as plain text, so the match on the
 * set kept in the session is the only way to tell a tap from typing.
 */
export function telegramTurnBegins(session: TelegramRepliesSession, text: string, now: number = Date.now()): StoredReply | null {
  if (!session.agentChatLastAt || now - session.agentChatLastAt > TELEGRAM_CHAT_GAP_MS) {
    session.agentChatStartedAt = now;
    session.agentChatTurns = 0;
  }
  session.agentChatTurns = (session.agentChatTurns ?? 0) + 1;
  session.agentChatLastAt = now;

  const up = session.agentReplies?.items ?? [];
  const chip = up.find((item) => normalizeChipText(item.text) === normalizeChipText(text)) ?? null;
  if (up.length > 0) session.agentRepliesIgnored = chip ? 0 : (session.agentRepliesIgnored ?? 0) + 1;
  session.agentReplies = null;
  if (chip) console.info(`[replies] telegram tap kind=${chip.kind}`);
  return chip ? { id: chip.id, kind: chip.kind, text: chip.text } : null;
}

export interface TelegramTurnFacts {
  userId: string;
  language: Language;
  userText: string;
  reply: string;
  hasAction: boolean;
  /** The conversation before this turn, oldest first, text only. */
  rows: readonly TranscriptRow[];
  homeCityKey: string | null;
  timeZone?: string | null;
  now?: Date;
}

export type TelegramKeyboard =
  | { reply_markup: { keyboard: Array<Array<{ text: string }>>; resize_keyboard: true; one_time_keyboard: true; is_persistent: false } }
  | { reply_markup: { remove_keyboard: true } }
  | Record<string, never>;

/**
 * The chips for this reply as the last bubble's markup. Never throws: any
 * failure is no chips. Mutates the session (the set, the safety latch).
 */
export async function telegramReplies(
  session: TelegramRepliesSession,
  f: TelegramTurnFacts,
  deps: GenerateDeps = {},
): Promise<TelegramKeyboard> {
  const hadKeyboard = session.agentReplies !== null && session.agentReplies !== undefined;
  const none = (): TelegramKeyboard => (hadKeyboard ? { reply_markup: { remove_keyboard: true } } : {});
  try {
    const now = f.now ?? new Date();
    const verdict = chipsGate({
      enabled: suggestedRepliesOn(f.userId),
      holdout: inHoldout(f.userId),
      replyHasCard: f.hasAction,
      userText: f.userText,
      safetyLatched: Boolean(session.agentRepliesSafetyAt && now.getTime() - session.agentRepliesSafetyAt < TELEGRAM_CHAT_GAP_MS),
      ignoredInARow: session.agentRepliesIgnored ?? 0,
      turnsInChat: session.agentChatTurns ?? 1,
      chatStartedAt: session.agentChatStartedAt ? new Date(session.agentChatStartedAt) : null,
      now,
      timeZone: personTimeZone({ timeZone: f.timeZone ?? null, homeCityKey: f.homeCityKey }),
    });
    if (!verdict.ask) {
      if (verdict.reason !== "off") console.info(`[replies] telegram skip reason=${verdict.reason}`);
      return none();
    }
    const facts = await loadDateFacts(f.userId, now);
    const steps = availableSteps(facts, { surface: "telegram", eventsTool: false, reminders: agentRemindersOn(f.userId) });
    const set = await generateChipSet(
      { language: f.language, rows: f.rows, userText: f.userText, reply: f.reply, steps, wantExit: verdict.wantExit, night: verdict.night },
      deps,
    );
    if (set.safety) session.agentRepliesSafetyAt = now.getTime();
    console.info(`[replies] telegram shown=${set.items.length} kinds=${set.items.map((i) => i.kind).join(",")}${set.safety ? " safety=1" : ""}`);
    if (set.items.length === 0) return none();
    session.agentReplies = { items: replyViews(set.items), at: now.getTime() };
    return {
      reply_markup: {
        keyboard: set.items.map((item) => [{ text: item.text }]),
        resize_keyboard: true,
        one_time_keyboard: true,
        is_persistent: false,
      },
    };
  } catch (err) {
    console.warn("[replies] telegram failed:", err);
    session.agentReplies = null;
    return none();
  }
}

/** Text-only turns of the Telegram agent's stored history, without this turn's pair. */
export function telegramTranscript(history: ReadonlyArray<{ role: string; content?: unknown }>): TranscriptRow[] {
  const rows = history
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role as "user" | "assistant", text: m.content as string }));
  // The last user row and the reply after it are this turn's.
  let cut = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.role === "user") {
      cut = i;
      break;
    }
  }
  return rows.slice(0, cut).slice(-SUGGESTED_REPLIES.contextRows);
}
