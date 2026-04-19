import { env } from "../config.js";
import type { Language } from "@gennety/shared";
import { proposeSchedulingPrompt, venueSelectionPrompt } from "@gennety/shared";
import { callOpenAIText } from "./openai.js";

/**
 * Pitch generator — produces the personalized "why you two fit" paragraph
 * streamed to each user when a match is proposed.
 *
 * Two modes:
 *   - OpenAI chat-completions when `OPENAI_API_KEY` is set.
 *   - Deterministic local fallback otherwise (so dev + tests never fail).
 *
 * The fallback is intentionally short and generic — it is never shown in
 * production, only during offline dev runs.
 */

export interface PitchInput {
  selfFirstName: string | null;
  otherFirstName: string | null;
  selfSummary: string | null;
  otherSummary: string | null;
  language: Language;
}

export interface PitchClient {
  generate(input: PitchInput): Promise<string>;
}

const MODEL = "gpt-5.4-mini";
const MAX_TOKENS = 240;

/**
 * Real LLM pitch — kept tiny & stateless. Uses `fetch` directly to avoid
 * pulling in the `openai` package (AGENTS.md — no new deps without approval).
 */
export function createOpenAIPitchClient(apiKey: string): PitchClient {
  return {
    async generate(input: PitchInput): Promise<string> {
      const system = `You write short, warm match pitches for a university dating bot.
Reply with 2–3 sentences max, in ${input.language}. Second-person ("you").
Mention one concrete compatibility point. Never promise anything.`;
      const user = [
        `Reader: ${input.selfFirstName ?? "User"}`,
        `Reader bio: ${input.selfSummary ?? "(no bio)"}`,
        `Match: ${input.otherFirstName ?? "Someone"}`,
        `Match bio: ${input.otherSummary ?? "(no bio)"}`,
      ].join("\n");

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_completion_tokens: MAX_TOKENS,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI pitch failed: ${res.status} ${body}`);
      }
      const json = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return json.choices[0]?.message?.content?.trim() ?? "";
    },
  };
}

/** Deterministic, language-aware fallback used when no API key is set. */
export function localFallbackPitch(input: PitchInput): string {
  const other = input.otherFirstName ?? "someone";
  switch (input.language) {
    case "ru":
      return `Мы нашли для вас совпадение: ${other}. Наш ИИ считает, что у вас совпадают ценности и темп общения. Готовы познакомиться?`;
    case "uk":
      return `Ми знайшли для вас метч: ${other}. Наш ШІ вважає, що у вас збігаються цінності та темп спілкування. Готові познайомитись?`;
    default:
      return `We found a match for you: ${other}. Our AI thinks your values and communication rhythms line up nicely. Want to meet?`;
  }
}

/** High-level: pick a client and produce a pitch, never throws. */
export async function generatePitch(
  input: PitchInput,
  client?: PitchClient,
): Promise<string> {
  const impl =
    client ?? (env.OPENAI_API_KEY ? createOpenAIPitchClient(env.OPENAI_API_KEY) : null);
  if (!impl) return localFallbackPitch(input);
  try {
    const text = await impl.generate(input);
    return text || localFallbackPitch(input);
  } catch (err) {
    console.warn("Pitch generation failed, using fallback:", err);
    return localFallbackPitch(input);
  }
}

/**
 * Split a long pitch into 2–4 draft chunks for `sendMessageDraft` streaming.
 *
 * We split on sentence boundaries and pad forward so each successive chunk
 * contains the previous text + the next sentence — this matches the
 * "growing draft" UX that `sendMessageDraft` produces on Telegram clients.
 */
export function splitPitchIntoDrafts(pitch: string): string[] {
  const sentences = pitch
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length <= 1) return [pitch];

  const drafts: string[] = [];
  let acc = "";
  for (const s of sentences) {
    acc = acc ? `${acc} ${s}` : s;
    drafts.push(acc);
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Scheduling proposal message (Phase 3, iterations 1 & 2)
// ---------------------------------------------------------------------------

export interface SchedulingProposalInput {
  selfFirstName: string;
  otherFirstName: string;
  selfSummary: string | null;
  otherSummary: string | null;
  language: Language;
  iteration: number;
  proposedSlots: Date[];
}

/** Deterministic fallback for scheduling proposals (no API key). */
function localFallbackSchedulingProposal(input: SchedulingProposalInput): string {
  const locale = input.language === "ru" ? "ru-RU" : input.language === "uk" ? "uk-UA" : "en-US";
  const slots = input.proposedSlots
    .map((s) =>
      s.toLocaleString(locale, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    )
    .join(", ");

  switch (input.language) {
    case "ru":
      return `Мы подобрали несколько вариантов времени для вашей встречи с ${input.otherFirstName}: ${slots}. Какой вам подходит?`;
    case "uk":
      return `Ми підібрали кілька варіантів часу для вашої зустрічі з ${input.otherFirstName}: ${slots}. Який вам підходить?`;
    default:
      return `We've picked a few time options for your date with ${input.otherFirstName}: ${slots}. Which one works for you?`;
  }
}

/**
 * Generate a personalized scheduling proposal message using the LLM.
 * Falls back to a deterministic local template if the API is unavailable.
 */
export async function generateSchedulingProposal(
  input: SchedulingProposalInput,
): Promise<string> {
  const locale = input.language === "ru" ? "ru-RU" : input.language === "uk" ? "uk-UA" : "en-US";
  const slotLabels = input.proposedSlots.map((s) =>
    s.toLocaleString(locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }),
  );

  const systemPrompt = proposeSchedulingPrompt({
    selfFirstName: input.selfFirstName,
    otherFirstName: input.otherFirstName,
    selfSummary: input.selfSummary,
    otherSummary: input.otherSummary,
    language: input.language,
    iteration: input.iteration,
    proposedSlots: slotLabels,
  });

  const text = await callOpenAIText(systemPrompt, "Generate the scheduling message now.");
  return text || localFallbackSchedulingProposal(input);
}

// ---------------------------------------------------------------------------
// Venue confirmation message (Phase 3, after venue selected)
// ---------------------------------------------------------------------------

export interface VenueMessageInput {
  selfFirstName: string;
  otherFirstName: string;
  selfSummary: string | null;
  otherSummary: string | null;
  venueName: string;
  venueAddress: string;
  agreedTime: Date;
  language: Language;
}

/** Deterministic venue confirmation fallback. */
function localFallbackVenueMessage(input: VenueMessageInput): string {
  const venue = `${input.venueName} — ${input.venueAddress}`;
  switch (input.language) {
    case "ru":
      return `Всё готово! Ваше свидание с ${input.otherFirstName} состоится в ${venue}. Удачи!`;
    case "uk":
      return `Все готово! Ваше побачення з ${input.otherFirstName} відбудеться в ${venue}. Удачі!`;
    default:
      return `All set! Your date with ${input.otherFirstName} is at ${venue}. Have a wonderful time!`;
  }
}

/**
 * Generate a venue confirmation message using the LLM. Falls back to a
 * simple template when the API is unavailable.
 */
export async function generateVenueMessage(
  input: VenueMessageInput,
): Promise<string> {
  const locale = input.language === "ru" ? "ru-RU" : input.language === "uk" ? "uk-UA" : "en-US";
  const timeLabel = input.agreedTime.toLocaleString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  const systemPrompt = venueSelectionPrompt({
    selfFirstName: input.selfFirstName,
    otherFirstName: input.otherFirstName,
    selfSummary: input.selfSummary,
    otherSummary: input.otherSummary,
    venueName: input.venueName,
    venueAddress: input.venueAddress,
    agreedTime: timeLabel,
    language: input.language,
  });

  const text = await callOpenAIText(systemPrompt, "Generate the venue confirmation message now.");
  return text || localFallbackVenueMessage(input);
}
