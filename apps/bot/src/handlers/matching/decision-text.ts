/**
 * Conversational decision replies. The pitch closes with a natural question
 * ("So — want to go on a date with him?"), and the user may answer in plain
 * words instead of tapping the keyboard. This module classifies that reply
 * and turns it into the SAME mechanical confirmation the buttons provide:
 *
 *   - "yes"-intent  → a confirm card whose button is the existing
 *     `match:accept:{id}` commit (text alone never commits — the user always
 *     confirms with a tap, so an off-hand "да" can't lock an irreversible
 *     decision);
 *   - "no"-intent   → the existing decline confirmation card
 *     (`match:do:decline:{id}` / `match:keep:{id}`) — same guard as the
 *     keyboard path;
 *   - "unsure"      → a gentle "no rush" nudge, no state change;
 *   - anything else → not consumed; falls through to the menu agent.
 *
 * The blind-decision invariant is untouched: every reply is static copy that
 * reveals nothing about the partner's choice, and the actual commits reuse
 * the guarded callback handlers in decision.ts.
 *
 * Classification is keyword-first (fast, free, language-aware for all five
 * locales) with a small LLM fallback for longer/ambiguous messages; when the
 * LLM is unavailable the message simply falls through to the menu agent.
 */
import { prisma } from "@gennety/db";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import { t, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { env } from "../../config.js";
import { openaiFetch } from "../../services/openai-fetch.js";
import { buildDeclineConfirmKeyboard } from "./decision.js";

type DecisionIntent = "yes" | "no" | "unsure" | "other";

const MODEL = "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = 12_000;
/** Keyword shortcut only below this length; longer texts go to the LLM. */
const KEYWORD_MAX_LEN = 48;

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

function classifyByKeywords(text: string): DecisionIntent | null {
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

function buildGoConfirmKeyboard(matchId: string, lang: Language): InlineKeyboardMarkup {
  const goBtn: InlineKeyboardButton.CallbackButton & Record<string, unknown> = {
    text: t(lang, "matchBtnConfirmGo"),
    // Reuses the pitch keyboard's accept commit — no new decision path.
    callback_data: `match:accept:${matchId}`,
    style: "success",
    ...(env.CUSTOM_EMOJI_ACCEPT_ID ? { icon_custom_emoji_id: env.CUSTOM_EMOJI_ACCEPT_ID } : {}),
  };
  const backBtn: InlineKeyboardButton.CallbackButton = {
    text: t(lang, "matchBtnKeepDeciding"),
    callback_data: `match:keep:${matchId}`,
  };
  return { inline_keyboard: [[goBtn as InlineKeyboardButton], [backBtn]] };
}

/**
 * Try to consume a plain-text message as an answer to a live match proposal.
 * Returns `true` when handled; `false` lets the message flow on (menu agent).
 */
export async function handleProposalTextReply(ctx: BotContext): Promise<boolean> {
  const text = ctx.message?.text?.trim();
  const fromId = ctx.from?.id;
  if (!text || !fromId || text.startsWith("/")) return false;
  // Never hijack an active sub-flow (emergency reason, feedback, proxy chat,
  // report body, menu edits) — those own the user's raw text.
  if ((ctx.session.matchFlow ?? "idle") !== "idle") return false;
  if ((ctx.session.menuState ?? "idle") !== "idle") return false;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(fromId) },
    select: { id: true },
  });
  if (!user) return false;

  // The newest live proposal where THIS side hasn't decided and the pitch has
  // actually landed (pitchMessageId set for the side).
  const match = await prisma.match.findFirst({
    where: {
      status: "proposed",
      OR: [
        { userAId: user.id, acceptedByA: null, pitchMessageIdA: { not: null } },
        { userBId: user.id, acceptedByB: null, pitchMessageIdB: { not: null } },
      ],
    },
    orderBy: { dispatchedAt: "desc" },
    select: { id: true },
  });
  if (!match) return false;

  const intent =
    (text.length <= KEYWORD_MAX_LEN ? classifyByKeywords(text) : null) ??
    (await classifyViaLlm(text));

  const lang = ctx.session.language;
  switch (intent) {
    case "yes":
      await ctx.reply(t(lang, "matchTextYesConfirm"), {
        reply_markup: buildGoConfirmKeyboard(match.id, lang),
      });
      return true;
    case "no":
      // Same guarded confirmation card as the keyboard's Pass button.
      await ctx.reply(t(lang, "matchDeclineConfirmPrompt"), {
        parse_mode: "Markdown",
        reply_markup: buildDeclineConfirmKeyboard(match.id, lang),
      });
      return true;
    case "unsure":
      await ctx.reply(t(lang, "matchTextUnsure"));
      return true;
    default:
      return false;
  }
}
