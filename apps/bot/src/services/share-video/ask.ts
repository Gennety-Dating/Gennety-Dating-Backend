import type { Language } from "@gennety/shared";
import { MODELS } from "../../models.js";
import { callOpenAIText } from "../openai.js";
import type { ShareVideo, ShareVideoGrounding } from "./read.js";

/**
 * A question about a shared video, answered in the iOS share sheet (decision
 * journal 2026-10-24: the answer lives in the sheet, not in the chat).
 *
 * Grounded ONLY on what the read saw — caption, cover description, title,
 * the item — plus the person's city for "where / near me" questions. The model
 * is told to say plainly when the video does not show the answer: a confident
 * made-up address is worse than "the video doesn't say".
 */

export const SHARE_ASK_QUESTION_MAX = 300;
export const SHARE_ASK_HISTORY_MAX = 4;
export const SHARE_ASK_ANSWER_MAX = 600;

export interface ShareAskTurn {
  question: string;
  answer: string;
}

export interface ShareAskInput {
  video: ShareVideo;
  grounding: ShareVideoGrounding;
  question: string;
  history: readonly ShareAskTurn[];
  language: Language;
  cityKey: string | null;
}

export interface ShareAskDeps {
  complete?: (system: string, user: string) => Promise<string>;
}

const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: "English",
  ru: "Russian",
  uk: "Ukrainian",
  de: "German",
  pl: "Polish",
};

export function askSystemPrompt(input: ShareAskInput): string {
  const { video, grounding } = input;
  const facts = [
    `Platform: ${video.platform}`,
    video.author ? `Author: ${video.author}` : null,
    video.title ? `What it is about: ${video.title}` : null,
    video.summary ? `Summary: ${video.summary}` : null,
    grounding.caption ? `Caption: "${grounding.caption.slice(0, 600)}"` : null,
    grounding.coverDescription ? `Cover frame: ${grounding.coverDescription}` : null,
    video.item
      ? `Thing in it: ${video.item.title}${video.item.brand ? ` (${video.item.brand})` : ""}, a ${video.item.kind}`
      : null,
    input.cityKey ? `The person lives in: ${input.cityKey}` : null,
  ].filter((line): line is string => line !== null);
  return [
    "You are Gennety, a warm, concise dating concierge. Someone shared a short video and asks",
    "about it. You know only these facts — you have NOT watched the video:",
    "",
    ...facts,
    "",
    `Answer in ${LANGUAGE_NAMES[input.language]}, in 1–3 short sentences, plain text, no markdown,`,
    "no lists. If the facts do not contain the answer, say so honestly and, where it helps,",
    "suggest what they could check — never invent addresses, prices, opening hours or names.",
    "General knowledge about a well-known brand or venue named in the facts is fine.",
  ].join("\n");
}

function userTurn(input: ShareAskInput): string {
  const past = input.history
    .slice(-SHARE_ASK_HISTORY_MAX)
    .map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`)
    .join("\n\n");
  return past ? `${past}\n\nQ: ${input.question}` : input.question;
}

/** Strip the markdown a model sometimes adds anyway; cap the length. */
export function tidyAnswer(raw: string): string {
  const plain = raw
    .replace(/\*\*|__|`/gu, "")
    .replace(/^\s*[-*•]\s+/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (plain.length <= SHARE_ASK_ANSWER_MAX) return plain;
  return `${plain.slice(0, SHARE_ASK_ANSWER_MAX - 1).trimEnd()}…`;
}

export async function answerShareVideoQuestion(
  input: ShareAskInput,
  deps: ShareAskDeps = {},
): Promise<string | null> {
  const complete =
    deps.complete ??
    ((system: string, user: string) =>
      callOpenAIText(system, user, { model: MODELS.fast, maxTokens: 300, temperature: 0.4 }));
  const raw = await complete(askSystemPrompt(input), userTurn(input)).catch(() => "");
  const answer = tidyAnswer(raw);
  return answer || null;
}
