import { prisma, type Prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import {
  answerNativeProfilerQuestion,
  getNativeProfilerBatch,
  nativeProfilerQuestionOpen,
  userLanguage,
  type NativeProfilerQuestion,
} from "./profiler-native.js";
import { profilerContextMarkdown } from "./profiler-context.js";
import { touchChatSession } from "./chat-sessions.js";

/**
 * The Profiler inside the app's chat with Gennety (decision journal
 * 2026-11-13, founder: the «about you» questions leave «Сегодня» for the chat).
 *
 * The question is an ordinary `assistant` row of the chat, marked in
 * `attachment` as `{ kind: "profiler_question", questionId }`. The person's
 * next message in that chat, while the question is still live, IS the answer:
 * `POST /v1/chat/message` hands it here instead of to the concierge, records
 * it through the same `answerNativeProfilerQuestion` the «Сегодня» path uses
 * (one claim, one answer row, Telegram copy retired), and writes the next
 * question — or the closing line — as the reply. No model call, no tokens.
 *
 * Rows stay in the chat: the history reads them back after a reload, and the
 * concierge sees what was asked and answered on its next turn.
 */

export const PROFILER_CHAT_KIND = "profiler_question";

export interface ProfilerChatAttachment {
  kind: typeof PROFILER_CHAT_KIND;
  questionId: string;
}

export interface ProfilerChatRow {
  id: string;
  role: "assistant" | "user";
  content: string;
  imageUrl: string | null;
  createdAt: Date;
}

/** The marker on a stored row, or null for every other attachment. */
export function readProfilerChatAttachment(raw: unknown): ProfilerChatAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.kind !== PROFILER_CHAT_KIND || typeof value.questionId !== "string") return null;
  return { kind: PROFILER_CHAT_KIND, questionId: value.questionId };
}

/**
 * The question as chat text: the context card as plain lines, the question,
 * and — for a closed question, where only the listed answers count — the
 * options numbered, so a «2» or the option's words answer it.
 */
export function profilerChatText(
  question: NativeProfilerQuestion,
  language: Language,
  timeZone: string | null,
): string {
  const parts: string[] = [];
  if (question.context) {
    const quote = profilerContextMarkdown(question.context, language, timeZone)
      .split("\n")
      .map((line) => line.replace(/^>\s?/, ""))
      .join("\n");
    if (quote.trim()) parts.push(quote);
  }
  parts.push(question.text);
  if (question.input?.closed && question.input.options.length > 0) {
    parts.push(question.input.options.map((option, i) => `${i + 1}. ${option.text}`).join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * Which option a typed reply names: its number («2», «2.») or its words,
 * case-insensitively. Null when it names none — the words then go as the
 * person's own answer.
 */
export function matchProfilerOption(
  question: NativeProfilerQuestion,
  text: string,
  language: Language,
): string | null {
  const options = question.input?.options ?? [];
  if (options.length === 0) return null;
  const typed = text.trim().replace(/[.)\s]+$/u, "").toLocaleLowerCase(language);
  if (!typed) return null;
  const number = /^\d+$/u.test(typed) ? Number(typed) : NaN;
  if (Number.isInteger(number) && number >= 1 && number <= options.length) {
    return options[number - 1]!.id;
  }
  const named = options.find((option) => option.text.trim().toLocaleLowerCase(language) === typed);
  return named?.id ?? null;
}

/**
 * Openers that start a question to Gennety rather than an answer about
 * oneself, per language. Whole words at the very start of the message.
 */
const ASIDE_OPENERS: readonly RegExp[] = [
  // Bare «когда» / «где» / «when» start answers too («когда устаю — гуляю»,
  // «where the music is good»), so only the forms that ask.
  /^(почему|зачем|сколько|можешь|можно ли|скажи|расскажи|покажи|объясни|подскажи|что такое|а где|а когда|а почему|когда будет|когда будут|когда при[дш]|где мо[йяеи])(?=[\s,?!.]|$)/iu,
  /^(чому|навіщо|скільки|можеш|скажи|розкажи|покажи|поясни|підкажи|що таке|а де|а коли|а чому|коли буде|коли будуть|де мо[їяє])(?=[\s,?!.]|$)/iu,
  /^(why|how many|how much|how long|how do|how does|can you|could you|will you|is there|are there|do i|did i|tell me|show me|explain|when is|when will|when do|where is|where are)(?=[\s,?!.]|$)/iu,
  /^(warum|wie viel|wie lange|kannst du|gibt es|erkl\u00e4r|sag mir|zeig mir|wann ist|wann kommt|wo ist)(?=[\s,?!.]|$)/iu,
  /^(dlaczego|po co|ile|czy|mo\u017cesz|powiedz|poka\u017c|wyja\u015bnij|kiedy b\u0119dzie|gdzie jest)(?=[\s,?!.]|$)/iu,
];

/**
 * The product's own nouns, grouped by subject. A reply naming one is about the
 * product — unless the question itself is about the same thing (a question on
 * the person's ideal date is answered with «date»).
 */
const ASIDE_TOPICS: readonly RegExp[] = [
  // The match / the search. Not «матч» or «pair»: a football match and «пару
  // дней» are answers too.
  /(м[эе]тч|подбор|\bmatch(?:es|ed)?\b|dopasowan)/iu,
  // The date that is booked
  /(свидани|побачен|\bdates?\b|randk)/iu,
  // Tickets and Premium
  /(билет|квит[ко]|\btickets?\b|\bbilet|premium|преміум|премиум|подписк|підписк|subskrypc)/iu,
  // The meeting place, only as the product names it: places in general are
  // what half the questions ask about.
  /(место встречи|місце зустрічі|meeting place|\bvenue|treffpunkt|miejsce spotkania)/iu,
];

/**
 * Is a message typed under an open «about you» question really something else
 * — a question to Gennety, or talk about the match, the date, tickets or the
 * venue — that the concierge must answer (app audit 2026-11-15)? Before this,
 * whatever came next was stored as the answer: «когда будет пара?» became the
 * person's view on travel, and they got the next question instead of a reply.
 *
 * Deliberately a cheap rule, no model call: a message that is plainly a
 * question, or names a product subject the question is not about. Anything
 * else stays the answer, as before.
 */
export function profilerReplyIsAside(text: string, questionText: string): boolean {
  const reply = text.trim();
  if (!reply) return false;
  if (reply.includes("?")) return true;
  const head = reply.toLocaleLowerCase();
  if (ASIDE_OPENERS.some((opener) => opener.test(head))) return true;
  return ASIDE_TOPICS.some((topic) => topic.test(reply) && !topic.test(questionText));
}

async function profileTimeZone(userId: string): Promise<string | null> {
  const profile = await prisma.profile.findUnique({ where: { userId }, select: { timeZone: true } });
  return profile?.timeZone ?? null;
}

async function writeQuestion(
  userId: string,
  sessionId: string,
  question: NativeProfilerQuestion,
  language: Language,
): Promise<ProfilerChatRow> {
  const attachment: ProfilerChatAttachment = { kind: PROFILER_CHAT_KIND, questionId: question.id };
  const row = await prisma.message.create({
    data: {
      userId,
      sessionId,
      role: "assistant",
      content: profilerChatText(question, language, await profileTimeZone(userId)),
      attachment: attachment as unknown as Prisma.InputJsonValue,
    },
  });
  await touchChatSession(sessionId, row.createdAt).catch(() => undefined);
  return row as ProfilerChatRow;
}

/** The newest visible row of the chat. */
async function latestRow(userId: string, sessionId: string) {
  return prisma.message.findFirst({
    where: { userId, sessionId, role: { not: "system" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, role: true, attachment: true },
  });
}

/**
 * `POST /v1/chat/profiler`: put the due question into this chat.
 *
 * Null when there is nothing to ask, or when the chat already ends with that
 * very question (a second open of the chat must not ask twice).
 */
export async function postDueProfilerQuestion(
  userId: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<ProfilerChatRow | null> {
  const batch = await getNativeProfilerBatch(userId, now);
  const question = batch.question;
  if (!question) return null;
  const latest = await latestRow(userId, sessionId);
  if (latest?.role === "assistant" && readProfilerChatAttachment(latest.attachment)?.questionId === question.id) {
    return null;
  }
  return writeQuestion(userId, sessionId, question, await userLanguage(userId));
}

/**
 * The question this chat is waiting on: the chat ends with a question row and
 * that question can still be answered. Null otherwise — the message is then
 * an ordinary turn for the concierge.
 */
export async function openProfilerQuestionInChat(userId: string, sessionId: string): Promise<string | null> {
  const latest = await latestRow(userId, sessionId);
  if (latest?.role !== "assistant") return null;
  const marker = readProfilerChatAttachment(latest.attachment);
  if (!marker) return null;
  return (await nativeProfilerQuestionOpen(userId, marker.questionId)) ? marker.questionId : null;
}

/**
 * The person's message as the answer to `questionId`. Null when the answer was
 * not taken (the question stopped being live in between) — nothing is written
 * then, and the route runs the concierge's turn as usual.
 */
export async function answerProfilerInChat(input: {
  userId: string;
  sessionId: string;
  questionId: string;
  text: string;
  now?: Date;
}): Promise<{ user: ProfilerChatRow; reply: ProfilerChatRow } | null> {
  const { userId, sessionId, questionId, text } = input;
  const now = input.now ?? new Date();
  const language = await userLanguage(userId);
  const batch = await getNativeProfilerBatch(userId, now);
  const live = batch.question?.id === questionId ? batch.question : batch.later?.find((q) => q.id === questionId);
  const optionId = live ? matchProfilerOption(live, text, language) : null;
  // A question or a product aside goes to the concierge; the profiler
  // question stays open behind it (it is no longer the chat's last row, so the
  // next message is an ordinary turn too, and «Сегодня» still asks it).
  if (!optionId && profilerReplyIsAside(text, live?.text ?? "")) return null;
  const closed = live?.input?.closed === true;

  const result = await answerNativeProfilerQuestion(
    userId,
    questionId,
    optionId
      ? { kind: "text", text: closed ? "" : text, optionIds: [optionId], source: closed ? "tap" : "both" }
      : { kind: "text", text, source: "text" },
    now,
  );
  if (!result.ok) return null;

  const user = await prisma.message.create({
    data: { userId, sessionId, role: "user", content: text },
  });
  let reply: ProfilerChatRow;
  if (result.outcome === "next") {
    reply = await writeQuestion(userId, sessionId, result.question, language);
  } else {
    const row = await prisma.message.create({
      data: {
        userId,
        sessionId,
        role: "assistant",
        content: t(language, result.outcome === "paused" ? "profilerRefusalAck" : "profilerSeriesDone"),
      },
    });
    await touchChatSession(sessionId, row.createdAt).catch(() => undefined);
    reply = row as ProfilerChatRow;
  }
  return { user: user as ProfilerChatRow, reply };
}
