/**
 * Classification of a free-text answer to the match-decision question
 * ("So — want to go on a date with him/her?"). Shared by the Telegram
 * conversational-decision handler (`handlers/matching/decision-text.ts`)
 * and the mobile endpoint `POST /v1/matches/:id/decision-intent` — both
 * surfaces enforce the same product rule: text alone NEVER commits, the
 * classified intent only selects which guarded confirmation UI to show.
 *
 * Keyword-first (fast, free, language-aware for all five locales) with a
 * small LLM fallback for longer/ambiguous messages; when the LLM is
 * unavailable the intent degrades to "other" (caller falls through).
 */
import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { openaiFetch } from "./openai-fetch.js";

export type DecisionIntent = "yes" | "no" | "unsure" | "other";

const MODEL = "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = 12_000;
/** Keyword shortcut only below this length; longer texts go to the LLM. */
export const KEYWORD_MAX_LEN = 48;

/** Negations first — "не хочу" must not match the bare "хочу" yes-pattern. */
const NO_PATTERNS = [
  "не хочу", "не пойду", "не пiду", "не піду", "не в этот раз", "не цього разу",
  "нет", "неа", "ні", "нi", "no", "nope", "nein", "nie", "pass", "пас",
  "skip", "не буду", "откажусь", "відмовлюсь", "not this time",
];

const YES_PATTERNS = [
  "да", "иду", "пойду", "хочу", "конечно", "давай", "го ", "погнали",
  "yes", "yep", "yeah", "sure", "of course", "i'm in", "im in",
  "так", "піду", "пiду", "авжеж", "звісно", "хочу піти",
  "ja", "gerne", "klar", "tak", "chcę", "chce", "оk", "ok", "ок", "окей",
];

export function classifyDecisionKeywords(text: string): DecisionIntent | null {
  const lower = ` ${text.toLowerCase().replace(/[!.,?()"']/g, " ").trim()} `;
  if (lower.trim().length === 0) return null;
  for (const p of NO_PATTERNS) {
    if (lower.includes(` ${p} `) || lower.trim() === p) return "no";
  }
  for (const p of YES_PATTERNS) {
    if (lower.includes(` ${p.trim()} `) || lower.trim() === p.trim()) return "yes";
  }
  const unsureMarkers = ["не знаю", "подумаю", "не уверен", "не впевнен", "maybe", "не вирішив", "hmm", "хм"];
  for (const p of unsureMarkers) if (lower.includes(p)) return "unsure";
  return null;
}

async function classifyViaLlm(text: string): Promise<DecisionIntent> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return "other";
  try {
    const res = await openaiFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_completion_tokens: 16,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'The user was just asked whether they want to go on the proposed date. Classify their reply. Return JSON {"intent":"yes"|"no"|"unsure"|"other"}. "other" = the message is about something else entirely (a question, profile edit, etc.).',
          },
          { role: "user", content: text.slice(0, 400) },
        ],
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });
    if (!res.ok) return "other";
    const json = (await res.json()) as { choices: Array<{ message: { content: string | null } }> };
    const parsed = JSON.parse(json.choices[0]?.message?.content ?? "{}") as { intent?: unknown };
    return parsed.intent === "yes" || parsed.intent === "no" || parsed.intent === "unsure"
      ? parsed.intent
      : "other";
  } catch {
    return "other";
  }
}

/** Combined strategy: keyword fast-path for short texts, LLM for the rest. */
export async function classifyDecisionIntent(text: string): Promise<DecisionIntent> {
  return (
    (text.length <= KEYWORD_MAX_LEN ? classifyDecisionKeywords(text) : null) ??
    (await classifyViaLlm(text))
  );
}

/**
 * Mobile-facing gate + classification (`POST /v1/matches/:id/decision-intent`):
 * classify only when the caller is a participant of THIS match, the proposal
 * is still open, and their side hasn't decided yet. Returns null otherwise —
 * the route answers 404 and the classifier (and its LLM spend) never runs
 * for stale or foreign matches.
 */
export async function classifyMatchDecisionForUser(
  matchId: string,
  userId: string,
  text: string,
): Promise<DecisionIntent | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      userAId: true,
      userBId: true,
      status: true,
      acceptedByA: true,
      acceptedByB: true,
    },
  });
  if (!match || match.status !== "proposed") return null;
  const side = match.userAId === userId ? "A" : match.userBId === userId ? "B" : null;
  if (!side) return null;
  const alreadyDecided = side === "A" ? match.acceptedByA !== null : match.acceptedByB !== null;
  if (alreadyDecided) return null;
  return classifyDecisionIntent(text);
}
