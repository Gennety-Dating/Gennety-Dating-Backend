import { env } from "../config.js";
import type { Language } from "@gennety/shared";
import {
  pitchAndSynergyPrompt,
  proposeSchedulingPrompt,
  venueSelectionPrompt,
} from "@gennety/shared";
import { callOpenAIText } from "./openai.js";

/**
 * Pitch generator — produces the personalized "why you two fit" payload
 * streamed to each user when a match is proposed.
 *
 * Output is structured: alongside the prose `pitch`, the LLM returns the
 * AI Synergy Score (70..99 integer) + a 1–2 sentence positive
 * justification. The synergy fields are persisted on the `Match` row by
 * `sendMatchProposal` and surfaced to the mobile app via
 * `SerializedMatch`.
 *
 * Two modes:
 *   - OpenAI JSON-mode chat-completions when `OPENAI_API_KEY` is set.
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

export interface PitchResult {
  pitch: string;
  /** Always clamped to [70, 99] regardless of what the LLM returned. */
  synergyScore: number;
  /** 1–2 sentence positive justification, language-aware. */
  synergyReason: string;
}

export interface PitchClient {
  generate(input: PitchInput): Promise<PitchResult>;
}

const MODEL = "gpt-4.1-mini";
const MAX_TOKENS = 480;
const OPENAI_TIMEOUT_MS = 45_000;

function localeForLanguage(language: Language): string {
  switch (language) {
    case "ru":
      return "ru-RU";
    case "uk":
      return "uk-UA";
    case "de":
      return "de-DE";
    case "pl":
      return "pl-PL";
    default:
      return "en-US";
  }
}

/** Hard product invariant: visual range is always 70..99. */
export const SYNERGY_MIN = 70;
export const SYNERGY_MAX = 99;

/** Clamp + round any incoming score into the motivating band. */
export function clampSynergyScore(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : SYNERGY_MIN;
  return Math.max(SYNERGY_MIN, Math.min(SYNERGY_MAX, Math.round(n)));
}

/**
 * Real LLM pitch — kept tiny & stateless. Uses `fetch` directly to avoid
 * pulling in the `openai` package (AGENTS.md — no new deps without approval).
 *
 * Enforces JSON mode so the schema is validated by the API itself; the
 * caller still re-clamps `synergy_score` defensively.
 */
export function createOpenAIPitchClient(apiKey: string): PitchClient {
  return {
    async generate(input: PitchInput): Promise<PitchResult> {
      const system = pitchAndSynergyPrompt({
        selfFirstName: input.selfFirstName,
        otherFirstName: input.otherFirstName,
        selfSummary: input.selfSummary,
        otherSummary: input.otherSummary,
        language: input.language,
      });

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_completion_tokens: MAX_TOKENS,
          temperature: 0.7,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: "Generate the match-reveal payload now." },
          ],
        }),
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI pitch failed: ${res.status} ${body}`);
      }
      const json = (await res.json()) as {
        choices: Array<{ message: { content: string | null } }>;
      };
      const raw = json.choices[0]?.message?.content?.trim();
      if (!raw) throw new Error("OpenAI pitch returned empty content");

      const parsed = JSON.parse(raw) as {
        pitch?: unknown;
        synergy_score?: unknown;
        synergy_reason?: unknown;
      };
      const pitch = typeof parsed.pitch === "string" ? parsed.pitch.trim() : "";
      const synergyReason =
        typeof parsed.synergy_reason === "string" ? parsed.synergy_reason.trim() : "";
      if (!pitch || !synergyReason) {
        throw new Error("OpenAI pitch missing required fields");
      }
      return {
        pitch,
        synergyScore: clampSynergyScore(parsed.synergy_score),
        synergyReason,
      };
    },
  };
}

/**
 * Deterministic, language-aware pitch fallback used when no API key is set.
 * Exposed separately so tests can assert prose without invoking the LLM.
 */
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

/**
 * Stable pseudo-score for offline / fallback paths so dev runs are
 * deterministic across restarts. Hash a seed string into [70, 99].
 */
export function fallbackSynergyScore(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  }
  // Map the unsigned 32-bit hash into the visible band.
  const span = SYNERGY_MAX - SYNERGY_MIN + 1;
  return SYNERGY_MIN + (Math.abs(h) % span);
}

/** Localised generic positive justification for the fallback path. */
export function localFallbackSynergyReason(language: Language): string {
  switch (language) {
    case "ru":
      return "Ваши взгляды и ритмы дополняют друг друга — есть из чего вырасти и о чём поговорить.";
    case "uk":
      return "Ваші погляди та ритми доповнюють одне одного — є з чого зростати та про що поговорити.";
    default:
      return "Your values and rhythms quietly complement each other — there's room to grow and plenty to talk about.";
  }
}

/**
 * High-level: pick a client and produce a structured result. Never throws —
 * always returns a usable `PitchResult` so the dispatch pipeline can't be
 * blocked by a transient LLM outage.
 */
export async function generatePitch(
  input: PitchInput,
  client?: PitchClient,
  /** Stable seed for the deterministic fallback score (e.g. match.id). */
  fallbackSeed?: string,
): Promise<PitchResult> {
  const impl =
    client ?? (env.OPENAI_API_KEY ? createOpenAIPitchClient(env.OPENAI_API_KEY) : null);

  const fallback = (): PitchResult => ({
    pitch: localFallbackPitch(input),
    synergyScore: fallbackSeed
      ? fallbackSynergyScore(fallbackSeed)
      : fallbackSynergyScore(`${input.selfFirstName ?? ""}|${input.otherFirstName ?? ""}`),
    synergyReason: localFallbackSynergyReason(input.language),
  });

  if (!impl) return fallback();
  try {
    const result = await impl.generate(input);
    if (!result.pitch) return fallback();
    return {
      pitch: result.pitch,
      synergyScore: clampSynergyScore(result.synergyScore),
      synergyReason: result.synergyReason || localFallbackSynergyReason(input.language),
    };
  } catch (err) {
    console.warn("Pitch generation failed, using fallback:", err);
    return fallback();
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
  const locale = localeForLanguage(input.language);
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
    case "de":
      return `Wir haben ein paar Zeiten für dein Date mit ${input.otherFirstName} gefunden: ${slots}. Welche passt dir?`;
    case "pl":
      return `Wybraliśmy kilka terminów randki z ${input.otherFirstName}: ${slots}. Który Ci pasuje?`;
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
  const locale = localeForLanguage(input.language);
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
    case "de":
      return `Alles klar! Dein Date mit ${input.otherFirstName} findet bei ${venue} statt. Viel Spaß!`;
    case "pl":
      return `Gotowe! Twoja randka z ${input.otherFirstName} odbędzie się w ${venue}. Powodzenia!`;
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
  const locale = localeForLanguage(input.language);
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
