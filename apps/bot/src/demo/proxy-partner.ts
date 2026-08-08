import type { Language } from "@gennety/shared";

import { MODELS } from "../models.js";
import { callOpenAIText } from "../services/openai.js";
import { LOCALE_TAGS } from "../services/datetime-entity.js";

/**
 * What the puppet says in the anonymous pre-date chat (Variant C, §Phase 4).
 *
 * The relay is the one place in the product where two people actually write to
 * each other, and in demo mode the other person does not exist: the puppet is
 * `platform: "mobile"` with a negative `telegramId`, so it has no chat, no push
 * token, and nothing that could ever answer. A visitor who tapped "Enter chat",
 * wrote "I'm here" and got silence had been shown a broken feature, which is
 * worse than not showing it.
 *
 * So the puppet is given a voice: one small LLM call per turn, prompted as a
 * person on their way to the date. The situation is the whole point — this is
 * not a chatbot being helpful, it is someone saying "ten minutes out" and then
 * "I'm at the table by the window", which is exactly what the relay exists for.
 *
 * Two properties keep it safe to ship:
 *
 *   - **Fail-open.** `callOpenAIText` returns `""` on a missing key, a timeout,
 *     a non-200 or an unparseable body, and anything the model returns is
 *     validated before it is used. Both paths fall back to a scripted line, so
 *     the chat works with no `OPENAI_API_KEY` at all.
 *   - **Prompt building is pure**, so the interesting part — who the puppet is,
 *     what it knows about the date, which beat of arrival it is on — is testable
 *     without a network, a database or a bot.
 *
 * Demo-only by construction: nothing outside `apps/bot/src/demo/` imports this.
 */

export interface ProxyReplyTurn {
  from: "partner" | "visitor";
  body: string;
}

export interface ProxyReplyInput {
  /** The puppet — the person the visitor believes they are meeting. */
  partnerName: string;
  partnerGender: "male" | "female" | null;
  visitorName: string | null;
  language: Language | null;
  venueName: string | null;
  venueAddress: string | null;
  agreedTime: Date | null;
  /** The pair's city timezone; the demo is Kyiv-only, hence the default. */
  timeZone?: string;
  /** Oldest → newest, exactly as relayed through `proxy_messages`. */
  transcript: readonly ProxyReplyTurn[];
}

/** Model output longer than this is not a text message, it is an essay. */
const MAX_REPLY_CHARS = 220;

/**
 * A model that has stepped out of character usually says so in these words.
 *
 * Split in two because `\b` is ASCII-only in JavaScript without the `u` flag: a
 * boundary between a space and "н" does not exist, so `\bнейросет\b` silently
 * matches nothing. The Latin patterns keep their boundaries (so "ai" cannot fire
 * inside an ordinary word); the Cyrillic ones are substring matches on phrases
 * specific enough not to appear in "I'm by the entrance".
 */
const BROKEN_CHARACTER: readonly RegExp[] = [
  /\b(as an ai|an ai (assistant|model)|language model|demo mode|i am a bot)\b/i,
  /(нейросет|язык\w*\s+модел|штучний інтелект|искусственный интеллект|я\s+бот|я\s+—?\s*ии\b)/i,
];

const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  ru: "Russian",
  uk: "Ukrainian",
  de: "German",
  pl: "Polish",
};

/**
 * The scripted ladder, used whenever the model gives us nothing usable.
 *
 * Three lines rather than one because the fallback has to survive the same
 * arrival beats the prompt describes: on the way, arrived, then acknowledging.
 * `de`/`pl` fall back to `en`, matching `script.ts` — the demo's long-form copy
 * makes the same scope call.
 */
const FALLBACK: Record<"en" | "ru" | "uk", readonly string[]> = {
  ru: [
    "Я уже почти на месте, минут десять — и буду. Ты где?",
    "Всё, я внутри. Сижу за столиком у окна 🙂",
    "Ок, жду!",
  ],
  uk: [
    "Я вже майже на місці, хвилин десять — і буду. Ти де?",
    "Усе, я всередині. Сиджу за столиком біля вікна 🙂",
    "Ок, чекаю!",
  ],
  en: [
    "Almost there — ten minutes out. Where are you?",
    "I'm inside, at the table by the window 🙂",
    "Alright, waiting!",
  ],
};

/**
 * How many messages the puppet has already sent — i.e. which beat of arriving
 * it is on. Exported because both the prompt and the fallback are indexed by it.
 */
export function partnerTurnIndex(transcript: readonly ProxyReplyTurn[]): number {
  return transcript.filter((turn) => turn.from === "partner").length;
}

function fallbackFor(input: ProxyReplyInput): string {
  const lang = input.language === "ru" || input.language === "uk" ? input.language : "en";
  const lines = FALLBACK[lang];
  const index = Math.min(partnerTurnIndex(input.transcript), lines.length - 1);
  return lines[index]!;
}

function formatWhen(input: ProxyReplyInput): string | null {
  if (!input.agreedTime) return null;
  const language = input.language ?? "en";
  return new Intl.DateTimeFormat(LOCALE_TAGS[language], {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: input.timeZone ?? "Europe/Kyiv",
  }).format(input.agreedTime);
}

/**
 * Where the puppet is right now, keyed to how much it has already said.
 *
 * The demo compresses the whole 30-minute window into a couple of minutes of
 * chat, so "on the way → arrived → settled in" has to be driven by turn count
 * rather than by the clock. Beat 0 is deliberately the one that asks a question:
 * it is sent before the visitor has written anything, and its job is to make
 * them open the chat and answer.
 */
function situationFor(turn: number): string {
  if (turn === 0) {
    return [
      "You are on your way and running about ten minutes out.",
      "Write FIRST, before they have said anything: tell them you are nearly",
      "there and ask where they are or whether they have arrived.",
    ].join(" ");
  }
  if (turn === 1) {
    return [
      "You have just arrived at the venue and are looking for them.",
      "Say where exactly you are — inside, at a table, by the entrance — so they",
      "can spot you.",
    ].join(" ");
  }
  return [
    "You are already at the venue, waiting for them or about to see them.",
    "Keep it to the practical business of finding each other; do not start a",
    "conversation that belongs on the date itself.",
  ].join(" ");
}

export interface ProxyReplyPrompt {
  system: string;
  user: string;
}

/**
 * Build the prompt. Pure — no clock, no network, no database.
 *
 * The hard rules exist because this text is relayed into a real person's chat
 * and reads as a human being: no self-reference as an AI, no meta-commentary
 * about the demo, no assistant register ("how may I help"), and nothing about
 * the date's content — the product forbids conversation before the meeting, and
 * a puppet that started one would be demonstrating a feature we deliberately do
 * not have.
 */
export function buildProxyReplyPrompt(input: ProxyReplyInput): ProxyReplyPrompt {
  const language = input.language ?? "en";
  const turn = partnerTurnIndex(input.transcript);
  const when = formatWhen(input);
  const gender =
    input.partnerGender === "male"
      ? "a man"
      : input.partnerGender === "female"
        ? "a woman"
        : "a person";

  const facts = [
    `You are ${input.partnerName}, ${gender}.`,
    input.visitorName
      ? `You are meeting ${input.visitorName} for a first date, arranged through a matchmaking service.`
      : "You are meeting someone for a first date, arranged through a matchmaking service.",
    input.venueName ? `The venue is ${input.venueName}.` : null,
    input.venueAddress ? `Its address is ${input.venueAddress}.` : null,
    when ? `The date is at ${when}.` : null,
    "You have never met, never spoken, and you cannot see each other's contacts:",
    "these messages are relayed by the matchmaker, and they only exist so the two",
    "of you can find each other at the venue.",
  ]
    .filter((line): line is string => line !== null)
    .join(" ");

  const system = [
    facts,
    situationFor(turn),
    `Write in ${LANGUAGE_NAMES[language]}.`,
    "Rules, all of them absolute:",
    "- one or two short sentences, the length of a real text message;",
    "- plain text only, no greeting formalities, at most one emoji;",
    "- never mention being an AI, a model, a bot, a demo or a simulation;",
    "- never offer help or ask what they need — you are not an assistant, you are",
    "  the person they are about to meet;",
    "- do not discuss anything but finding each other and the next few minutes;",
    "- do not repeat what you have already said in the conversation below;",
    "- output the message text and nothing else: no name prefix, no quotes.",
  ].join("\n");

  const conversation =
    input.transcript.length === 0
      ? "(nothing has been said yet — you are writing first)"
      : input.transcript
          .map(
            (line) =>
              `${line.from === "partner" ? "You" : (input.visitorName ?? "Them")}: ${line.body}`,
          )
          .join("\n");

  return { system, user: `Conversation so far:\n${conversation}\n\nYour next message:` };
}

/**
 * Reject anything that is not a plausible text message.
 *
 * Returns null on rejection so the caller substitutes the scripted line — a bad
 * generation must never reach the visitor's chat, because in a demo it is the
 * one message they will remember.
 */
export function validateProxyReply(raw: string, partnerName: string): string | null {
  let cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  // Models like to answer in character with a speaker label; the relay adds its
  // own "💬 Name:" prefix, so one here would double it.
  const prefix = new RegExp(`^${partnerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`, "i");
  cleaned = cleaned.replace(prefix, "").trim();
  cleaned = cleaned.replace(/^["'«»“”]+|["'«»“”]+$/g, "").trim();

  if (!cleaned) return null;
  if (cleaned.length > MAX_REPLY_CHARS) return null;
  if (/https?:\/\//i.test(cleaned)) return null;
  if (BROKEN_CHARACTER.some((pattern) => pattern.test(cleaned))) return null;
  return cleaned;
}

/** The puppet's next line. Always returns something sendable. */
export async function composeProxyReply(input: ProxyReplyInput): Promise<string> {
  const { system, user } = buildProxyReplyPrompt(input);
  const raw = await callOpenAIText(system, user, {
    model: MODELS.fast,
    maxTokens: 200,
    // Higher than the product's grounded copy: this is small talk, and an
    // identical line every run reads as a script.
    temperature: 0.9,
  });
  return validateProxyReply(raw, input.partnerName) ?? fallbackFor(input);
}
