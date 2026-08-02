/**
 * Post-onboarding LLM agent (Menu Agent / LLM Router).
 *
 * Handles free-form messages from completed users by:
 *   1. Building a dynamic system prompt (DB knowledge + user context)
 *   2. Calling OpenAI with tool definitions for profile editing
 *   3. Executing tool calls and returning the reply
 *
 * Conversation history is stored on User.messageHistory (same column as
 * onboarding, but the system prompt is rebuilt fresh each session).
 */

import { prisma, Prisma, type Theme } from "@gennety/db";
import { openaiFetch } from "./openai-fetch.js";
import {
  MAX_BIO_LENGTH,
  MAX_PARTNER_PREFERENCES_LENGTH,
  MAX_MAJOR_LENGTH,
  MIN_AGE,
  MAX_AGE,
  MAX_HISTORY_FOR_API,
  SUPPORTED_LANGUAGES,
  t,
  type Language,
} from "@gennety/shared";
import { env } from "../config.js";
import { MODELS } from "../models.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { truncateForApi, type ChatMessage } from "./onboarding-agent.js";
import { recordRejectionFeedback } from "./rejection-feedback.js";
import { refreshUserEmbedding } from "../workers/embedding-refresh.js";
import { transitionAccountStatus } from "./account-status-transitions.js";
import { getPremiumCancelContext, formatPremiumUntil } from "./premium.js";
import { explainMatch, getMatchmakingStanding } from "./agent-insights.js";
import { STALL_ASK_CANCEL_PREFIX } from "./match-stall.js";
import { setUserLanguage, setUserTheme } from "./user-preferences.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
}

/**
 * A single button the agent offers, carrying an EXISTING product callback.
 *
 * This is what makes the agent's reach safe. The agent never runs a sensitive
 * flow itself — it hands the user the same button the menu would have shown,
 * and the user's tap enters the untouched handler with its own guards, nonces
 * and confirmation copy. So "cancel my date" reaches exactly the two-step red
 * confirmation the Cancel button has always produced, and no second
 * destructive code path exists to keep in sync.
 */
export interface AgentEntryPoint {
  /** Already localized — resolved server-side, never model-authored. */
  label: string;
  /** Existing `callback_data`; the agent cannot invent one. */
  callbackData: string;
}

/**
 * A post-reply UI action the caller performs after sending the agent's text.
 * Used so a tool can surface a native affordance the agent can't render itself.
 *
 * `premium_cancel_confirm` / `premium_cancel_appstore` send the nonce-bound
 * Stars card / the iOS-Settings guide. `entry_point` sends one button into an
 * existing flow (see `AgentEntryPoint`).
 */
export type MenuAgentAction =
  | { kind: "premium_cancel_confirm" }
  | { kind: "premium_cancel_appstore" }
  | { kind: "entry_point"; entry: AgentEntryPoint };

export interface MenuAgentResult {
  reply: string;
  action?: MenuAgentAction;
  /**
   * Code-owned confirmation lines for writes that actually landed, appended
   * after the model's bubbles.
   *
   * Without these the only evidence of a profile change was the model's own
   * prose, which it is free to phrase however it likes — including describing
   * an edit that silently failed, or staying quiet about one the user did not
   * intend. A change to matching-relevant state should be visible as a fact,
   * not as a claim.
   */
  receipts?: string[];
}

/** Max bubbles per reply — more reads as spam, not chat. */
const MAX_REPLY_BUBBLES = 3;

/**
 * Below this length a reply is one thought and ships as one message, however
 * many sentences it happens to contain — «готово ✨ жду вторую сторону» split in
 * two is worse, not chattier. Above it, the reply carries enough substance that
 * two smaller messages read better than one line.
 */
const AUTO_SPLIT_MIN_CHARS = 90;

/** Sentence end followed by whitespace — the only place an auto-split may cut. */
const SENTENCE_BOUNDARY = /(?<=[.!?…])\s+/g;

/**
 * Split a single-block reply in two at the sentence boundary nearest its
 * midpoint, or return null when it should stay one message.
 *
 * BASE_PERSONA asks the model to author the bubbles itself with blank lines,
 * and that is the good path — the model knows where a thought ends. This is the
 * floor under it: the model does not always comply, and "the concierge answers
 * in one wall of text" is the actual complaint. Deliberately narrow — two
 * guards, both of which protect a reply that is genuinely one breath:
 * `AUTO_SPLIT_MIN_CHARS` and needing a real interior sentence boundary. It
 * yields at most TWO bubbles; three stay model-authored, because guessing two
 * cut points inside prose we didn't write is how this reads as a machine
 * chopping text.
 */
function autoSplitSingleBlock(text: string): [string, string] | null {
  if (text.length < AUTO_SPLIT_MIN_CHARS) return null;

  const cuts: number[] = [];
  for (const match of text.matchAll(SENTENCE_BOUNDARY)) {
    const end = match.index + match[0].length;
    // A boundary at the very end isn't interior — there'd be nothing after it.
    if (end < text.length) cuts.push(end);
  }
  if (cuts.length === 0) return null;

  const mid = text.length / 2;
  const cut = cuts.reduce((best, candidate) =>
    Math.abs(candidate - mid) < Math.abs(best - mid) ? candidate : best,
  );
  const head = text.slice(0, cut).trim();
  const tail = text.slice(cut).trim();
  if (!head || !tail) return null;
  return [head, tail];
}

/**
 * The menu agent's replies are sent WITHOUT a parse_mode, so any markdown the
 * model sneaks in ("**bold**", "__underline__", "`code`") shows up as literal
 * symbols in the chat. BASE_PERSONA forbids it; this is the safety net.
 */
function stripMarkdownEmphasis(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/__(.+?)__/gs, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

/**
 * Split a model reply into chat bubbles on blank lines (BASE_PERSONA asks the
 * model to separate distinct thoughts that way). Overflow folds into the last
 * bubble so nothing is dropped; a single block that is long enough and has an
 * interior sentence boundary is split in two by `autoSplitSingleBlock`, so a
 * non-compliant reply still lands as chat rather than as a wall of text.
 * Also strips markdown emphasis — the bubbles are sent as plain text.
 */
export function splitReplyIntoBubbles(reply: string): string[] {
  const parts = stripMarkdownEmphasis(reply)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return [reply.trim()].filter(Boolean);
  if (parts.length === 1) {
    return autoSplitSingleBlock(parts[0]!) ?? parts;
  }
  if (parts.length > MAX_REPLY_BUBBLES) {
    return [
      ...parts.slice(0, MAX_REPLY_BUBBLES - 1),
      parts.slice(MAX_REPLY_BUBBLES - 1).join("\n\n"),
    ];
  }
  return parts;
}

export interface MenuAgentDeps {
  fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// History window
// ---------------------------------------------------------------------------

/**
 * A stored turn. `ts` is written by this agent only — it is NOT part of the
 * OpenAI message schema and is stripped before every API call.
 */
export type StoredChatMessage = ChatMessage & { ts?: number };

/** How far back a stored turn may be and still be replayed. */
export const AGENT_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many stored turns may be replayed, newest last. */
export const AGENT_HISTORY_MAX_MESSAGES = 12;

/**
 * Pick the slice of `messageHistory` worth replaying into the model.
 *
 * `User.messageHistory` is a single column shared with the ONBOARDING agent,
 * and this agent used to replay all of it. So a user who asked "почему?" right
 * under a venue-change notice was answered against the tail of their
 * onboarding conversation — the bot cheerfully explained that their profile
 * was complete. Turns are kept only when they are this agent's own (they carry
 * `ts`) and recent; everything else stays in the column for the admin
 * conversation viewer and the re-engagement worker, which both read it, and is
 * simply not replayed. Live product state comes from the system prompt's
 * timeline instead, which does not decay.
 */
export function recentAgentHistory(
  stored: StoredChatMessage[],
  now: number = Date.now(),
): StoredChatMessage[] {
  const fresh = stored.filter(
    (msg) =>
      msg.role !== "system" &&
      typeof msg.ts === "number" &&
      now - msg.ts <= AGENT_HISTORY_WINDOW_MS,
  );
  const windowed = fresh.slice(-AGENT_HISTORY_MAX_MESSAGES);
  // Never open the replay on an orphaned tool result — OpenAI rejects a `tool`
  // message whose `assistant` tool_calls turn isn't in the same request.
  let start = 0;
  while (start < windowed.length && windowed[start]!.role === "tool") start++;
  return windowed.slice(start);
}

/**
 * Strip fields OpenAI's schema doesn't know about (`ts`) before sending.
 * Leaving them in returns a 400.
 */
export function toApiMessages(history: ChatMessage[]): ChatMessage[] {
  return history.map((msg) => {
    const { ts: _ts, ...rest } = msg as StoredChatMessage;
    return rest as ChatMessage;
  });
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "update_bio",
      description:
        "Update the user's psychological summary / bio text. Call when the user wants to change their bio.",
      parameters: {
        type: "object",
        properties: {
          bio: {
            type: "string",
            description: `New bio text (max ${MAX_BIO_LENGTH} characters)`,
          },
        },
        required: ["bio"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_major",
      description:
        "Update the user's major / field of study.",
      parameters: {
        type: "object",
        properties: {
          major: {
            type: "string",
            description: `Major or field of study (max ${MAX_MAJOR_LENGTH} characters)`,
          },
        },
        required: ["major"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_age_range",
      description:
        "Update the user's preferred PARTNER age range for matching (the age band of people they want to be matched with — NOT the user's own age, which is fixed after onboarding).",
      parameters: {
        type: "object",
        properties: {
          min_age: {
            type: "integer",
            description: `Minimum preferred partner age (${MIN_AGE}-${MAX_AGE})`,
          },
          max_age: {
            type: "integer",
            description: `Maximum preferred partner age (${MIN_AGE}-${MAX_AGE})`,
          },
        },
        required: ["min_age", "max_age"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_partner_preferences",
      description:
        "Update the user's free-text partner preference description.",
      parameters: {
        type: "object",
        properties: {
          preferences: {
            type: "string",
            maxLength: MAX_PARTNER_PREFERENCES_LENGTH,
            description: `New partner preference description (max ${MAX_PARTNER_PREFERENCES_LENGTH} characters)`,
          },
        },
        required: ["preferences"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_my_profile",
      description:
        "Retrieve the user's current profile information. Call when the user asks to see their profile.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "pause_matching",
      description:
        "Pause the user's matching. They won't receive new matches until they resume.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "resume_matching",
      description:
        "Resume matching after a pause.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "record_rejection_feedback",
      description:
        "Record the reason why the user declined a specific match. Call ONLY when the 'Current User Context' section indicates a pending rejection AND the user has given a concrete, specific reason. If the reason is vague ('не вайбанул', 'just didn't click', 'idk'), first ask 1-2 follow-up questions to extract what exactly didn't work (looks, vibe, interests, lifestyle, etc.). Do NOT call this tool for generic chitchat or when no pending rejection is mentioned in the context.",
      parameters: {
        type: "object",
        properties: {
          match_id: {
            type: "string",
            description:
              "The UUID of the match being rejected (provided in the pending rejection hint).",
          },
          reason: {
            type: "string",
            description:
              "Concrete rejection reason as a full sentence. Must describe a specific trait or mismatch (e.g. 'prefers more extroverted/social types', 'found the bio too focused on career'). Minimum 10 characters.",
          },
        },
        required: ["match_id", "reason"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "offer_cancel_premium",
      description:
        "Call ONLY when the user clearly wants to CANCEL / stop / turn off their Gennety Premium subscription, or explicitly asks how to cancel it. This surfaces a confirmation button (Telegram Stars) or shows App Store cancellation guidance — you NEVER cancel directly and text alone never cancels. Do NOT call for general questions about premium features/pricing or when the user is merely curious about Premium.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_hobbies",
      description:
        "Replace the user's hobbies/interests list. Call when the user tells you what they're into and wants it on their profile. Send the COMPLETE list you want them to end up with, not just the new additions.",
      parameters: {
        type: "object",
        properties: {
          hobbies: {
            type: "array",
            items: { type: "string", maxLength: 48 },
            maxItems: 12,
            description: "Complete hobby list, short phrases (max 12).",
          },
        },
        required: ["hobbies"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_language",
      description:
        "Switch the language the bot replies in and every screen shows. Call ONLY on an explicit request to change it — 'switch to Russian', 'переключи на английский', 'parle français' (say it's not supported if the target isn't in the list). This writes to their account permanently, so the bar is an actual request: a message written in another language, an emoji, a link, a name, or a one-word reply is NOT one, and neither is your own guess about what they'd prefer. If in doubt, ask instead of calling. After this succeeds, write the REST of your reply in the new language.",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: [...SUPPORTED_LANGUAGES],
            description: "Target language code.",
          },
        },
        required: ["language"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_theme",
      description:
        "Switch the app-wide light/dark look, used by every Mini App and rendered card. Call when the user asks for dark mode, light mode, or to change the theme/appearance.",
      parameters: {
        type: "object",
        properties: {
          theme: { type: "string", enum: ["light", "dark"] },
        },
        required: ["theme"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_my_standing",
      description:
        "Read why the user is or isn't getting matched: how many drop batches they've missed, whether their profile is still syncing, photo count, verification, account status, and how big the candidate pool is in their city. Call whenever the user asks why they have no matches, why it's taking so long, or what they could improve. Read-only.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "explain_my_match",
      description:
        "Read the stored reasoning behind the user's current (or most recent) pairing — the synergy score and how strongly each factor contributed. Call when the user asks why this person, why they were matched, or what the algorithm saw. Read-only. NEVER reveal the partner's decision, and never present the factors as a rating of the partner.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "propose_cancel_date",
      description:
        "Call when the user wants to CANCEL their date — whether it is already booked or still being planned (they are picking a time, or marking where they'll set off from). Covers 'something came up', 'I can't make it', 'my plans changed', and 'how do I cancel'. This only surfaces the cancellation button — you NEVER cancel a date yourself and text alone never cancels one. Cancelling is irreversible and the match cannot be restored, so the user still confirms on a red button afterwards. If their message is ambiguous between asking HOW cancelling works and actually wanting to cancel, ask one short clarifying question first ('have your plans changed?') and call this only once they say yes. Do NOT call for questions about the date, for changing the venue, or for running late.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "propose_close_account",
      description:
        "Call ONLY when the user clearly wants to delete, close, or take a long break from their account. This surfaces the account-closure entry, which offers freezing (keeps everything, reversible with /start) before deletion. You NEVER delete or freeze anything yourself. Do NOT call for a temporary pause of matching — use pause_matching for that.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "open_screen",
      description:
        "Give the user a button that opens an existing screen, when what they want lives there rather than in chat. Use it instead of describing where to tap. Choose: profile (view their profile card), photos (add/remove photos), edit_bio (rewrite 'About me' in the editor, where they can see the current text first), settings (language, theme, account), tickets (Date Ticket balance and store), premium (subscription).",
      parameters: {
        type: "object",
        properties: {
          screen: {
            type: "string",
            enum: ["profile", "photos", "edit_bio", "settings", "tickets", "premium"],
          },
        },
        required: ["screen"],
      },
    },
  },
];

/**
 * What each tool is allowed to do. The loop enforces this, so a tool's blast
 * radius is a property of the registry rather than of how carefully its
 * description was worded:
 *
 *  - `read`    — returns facts, touches nothing.
 *  - `write`   — mutates this user's own data. Budgeted (see MAX_WRITES_PER_TURN).
 *  - `confirm` — mutates NOTHING; may only surface a native confirmation the
 *                user still has to tap. Every irreversible action lives here.
 *  - `open`    — mutates nothing; hands over a button into an existing screen.
 */
export type ToolKind = "read" | "write" | "confirm" | "open";

export const TOOL_KINDS: Record<string, ToolKind> = {
  get_my_profile: "read",
  get_my_standing: "read",
  explain_my_match: "read",
  update_bio: "write",
  update_major: "write",
  update_age_range: "write",
  update_partner_preferences: "write",
  update_hobbies: "write",
  set_language: "write",
  set_theme: "write",
  pause_matching: "write",
  resume_matching: "write",
  record_rejection_feedback: "write",
  offer_cancel_premium: "confirm",
  propose_cancel_date: "confirm",
  propose_close_account: "confirm",
  open_screen: "open",
};

/**
 * How many `write` tools may execute in one turn.
 *
 * One message from the user is one intent. A turn that issues several writes is
 * the model improvising, and improvisation over a profile is exactly the shape
 * a prompt-injection payload would take — the timeline the prompt renders holds
 * text this user did not necessarily author (see `prompt-builder.ts`). Capping
 * it at one keeps a bad turn to a single, visible, reversible field change
 * instead of a rewritten profile.
 */
export const MAX_WRITES_PER_TURN = 1;

/**
 * Did a tool actually persist something?
 *
 * Parsed, not substring-matched. This used to be `result.includes('"success":
 * true')` on the raw JSON, and `execUpdateBio`'s REFUSAL path returns the
 * user's existing bio text in the same payload — so a profile whose text
 * happened to contain that substring turned a refusal into a "success": the
 * turn's single write budget was spent and the user was shown a code-owned
 * "✓ About me updated" receipt for a change that was never saved. A receipt
 * exists precisely so a write is a fact rather than a claim; it must not be
 * decidable by the contents of a user-supplied string.
 */
export function toolReportedSuccess(result: string): boolean {
  try {
    const parsed: unknown = JSON.parse(result);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { success?: unknown }).success === true
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tool Executors
// ---------------------------------------------------------------------------

/**
 * A bio this long is treated as real accumulated signal rather than a line the
 * user typed — in practice it is the redacted AI-memory analysis plus the
 * folded-in vibe answers written at finalization.
 */
const SUBSTANTIAL_BIO_LENGTH = 200;

/** Below this fraction of the existing text, a rewrite is a deletion. */
const BIO_SHRINK_LIMIT = 0.5;

async function execUpdateBio(
  telegramId: bigint,
  args: { bio: string },
): Promise<{ toolResult: string; action: MenuAgentAction | null }> {
  const fail = (error: string) => ({
    toolResult: JSON.stringify({ success: false, error }),
    action: null,
  });

  if (typeof args.bio !== "string" || !args.bio.trim()) {
    return fail("Bio cannot be empty.");
  }
  const bio = args.bio.trim();
  if (bio.length > MAX_BIO_LENGTH) {
    return fail(
      `Bio must be ${MAX_BIO_LENGTH} characters or less (currently ${bio.length}).`,
    );
  }

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, language: true, profile: { select: { psychologicalSummary: true } } },
  });
  if (!user) return fail("User not found.");

  // `psychologicalSummary` is not a caption — it is the profile's accumulated
  // psychological signal and the dominant embedding input (V_explicit, 0.65).
  // A casual "add that I like coffee" used to be enough for the model to send
  // a one-line bio and wipe the whole analysis, with no snapshot to restore
  // from. A collapse like that is a deliberate act, so it belongs in the editor
  // where the user can read what they are replacing first.
  const current = user.profile?.psychologicalSummary?.trim() ?? "";
  const collapses =
    current.length >= SUBSTANTIAL_BIO_LENGTH &&
    bio.length < current.length * BIO_SHRINK_LIMIT;
  if (collapses) {
    const lang = (user.language ?? "en") as Language;
    return {
      toolResult: JSON.stringify({
        success: false,
        error: "replacement_too_destructive",
        instruction:
          "That would delete most of their existing profile text, so it was NOT saved. " +
          "Tell them briefly that their current description is long and you don't want to wipe it, and that the editor (button attached automatically) shows the current text so they can edit it themselves. " +
          "If they only wanted to ADD something, offer to call update_bio again with the existing text plus their addition.",
        currentBio: current,
      }),
      action: {
        kind: "entry_point",
        entry: { label: t(lang, "editBioBtn"), callbackData: "menu:edit:bio" },
      },
    };
  }

  await prisma.profile.update({
    where: { userId: user.id },
    // M-2: mark embedding dirty — bio is the primary embedding input.
    data: {
      psychologicalSummary: bio,
      embeddingDirty: true,
      embeddingDirtyAt: new Date(),
    },
  });
  const sync = await refreshUserEmbedding(user.id).catch(() => ({ stillDirty: 1 }));

  return {
    toolResult: JSON.stringify({
      success: true,
      message:
        sync.stillDirty === 0
          ? "Bio updated and applied to matching."
          : "Bio saved; matching will apply it after automatic profile sync.",
    }),
    action: null,
  };
}

async function execUpdateMajor(
  telegramId: bigint,
  args: { major: string },
): Promise<string> {
  if (typeof args.major !== "string") {
    return JSON.stringify({ success: false, error: "Major must be text." });
  }
  const major = args.major.trim();
  if (major.length > MAX_MAJOR_LENGTH) {
    return JSON.stringify({
      success: false,
      error: `Major must be ${MAX_MAJOR_LENGTH} characters or less.`,
    });
  }

  // Checked like its sibling tools rather than relying on the update to throw:
  // a raw P2025 escapes the tool loop and the caller can only fall back to the
  // main menu, so the user's edit silently becomes an unexplained menu.
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return JSON.stringify({ success: false, error: "User not found." });

  await prisma.user.update({
    where: { telegramId },
    data: { major },
  });

  return JSON.stringify({ success: true, message: "Major updated." });
}

async function execUpdateHobbies(
  telegramId: bigint,
  args: { hobbies: unknown },
): Promise<string> {
  if (!Array.isArray(args.hobbies)) {
    return JSON.stringify({ success: false, error: "Hobbies must be a list." });
  }
  const hobbies = args.hobbies
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.trim().slice(0, 48))
    .filter((h) => h.length > 0)
    .slice(0, 12);
  if (hobbies.length === 0) {
    return JSON.stringify({
      success: false,
      error: "Hobby list cannot be empty. Ask what they're into before calling again.",
    });
  }

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return JSON.stringify({ success: false, error: "User not found." });

  await prisma.profile.update({
    where: { userId: user.id },
    // Hobbies feed `buildEmbeddingInput` — mark dirty like the other embedding
    // inputs, or matching keeps scoring the previous list.
    data: {
      hobbies,
      embeddingDirty: true,
      embeddingDirtyAt: new Date(),
    },
  });
  const sync = await refreshUserEmbedding(user.id).catch(() => ({ stillDirty: 1 }));

  return JSON.stringify({
    success: true,
    hobbies,
    message:
      sync.stillDirty === 0
        ? "Hobbies updated and applied to matching."
        : "Hobbies saved; matching will apply them after automatic profile sync.",
  });
}

const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGES);
const VALID_THEMES = new Set(["light", "dark"]);

/**
 * Same DB write the Settings menu's language picker performs
 * (`services/user-preferences.ts` — shared so both paths keep the invariant
 * that a switch clears this user's own cached date-card render, which bakes
 * the language into its blurb text).
 */
async function execSetLanguage(
  telegramId: bigint,
  args: { language?: unknown },
): Promise<string> {
  const language = typeof args.language === "string" ? args.language : "";
  if (!SUPPORTED_LANGUAGE_SET.has(language)) {
    return JSON.stringify({
      success: false,
      error: `Unsupported language "${language}". Supported: ${SUPPORTED_LANGUAGES.join(", ")}.`,
    });
  }

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return JSON.stringify({ success: false, error: "User not found." });

  await setUserLanguage(telegramId, language as Language);

  return JSON.stringify({
    success: true,
    message: "Language updated.",
    instruction: `The switch already applied — write the rest of THIS reply in ${language}.`,
  });
}

/** Same DB write the Settings menu's theme picker performs. */
async function execSetTheme(
  telegramId: bigint,
  args: { theme?: unknown },
): Promise<string> {
  const theme = typeof args.theme === "string" ? args.theme : "";
  if (!VALID_THEMES.has(theme)) {
    return JSON.stringify({ success: false, error: "Theme must be 'light' or 'dark'." });
  }

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return JSON.stringify({ success: false, error: "User not found." });

  await setUserTheme(telegramId, theme as Theme);

  return JSON.stringify({ success: true, message: "Theme updated." });
}

async function execGetMyStanding(telegramId: bigint): Promise<string> {
  const standing = await getMatchmakingStanding(telegramId);
  if (!standing) return JSON.stringify({ success: false, error: "User not found." });

  return JSON.stringify({
    success: true,
    standing,
    instruction:
      "Explain in plain language, warmly, and lead with the ONE thing that actually matters most. " +
      "`profileSyncPending` true means their profile is temporarily out of the pool until sync finishes — say so honestly, it resolves by itself. " +
      "`cityPool` describes local supply: 'none'/'very_small' means the honest answer is that their city is still filling up, not that something is wrong with them. " +
      "`photosForBonusTicket` is how many more photos would earn a free Date Ticket. " +
      "Speak about waiting time using `daysWaiting` (days). NEVER quote `missedBatches` or phrase it as a number of drops/rounds — it is an internal cycle count whose scale changes with how often we run, so it reads as a verdict while describing very little. " +
      "If they are asking why it has been quiet: a search that finds nobody sends nothing at all — silence means no one cleared the bar, not that anything is broken or that they were skipped. " +
      "Never invent a reason that isn't in this data, and never promise a match by any particular date.",
  });
}

async function execExplainMyMatch(telegramId: bigint): Promise<string> {
  const explanation = await explainMatch(telegramId);
  if (!explanation) {
    return JSON.stringify({
      success: false,
      error: "No match to explain yet — they haven't been paired with anyone.",
    });
  }

  return JSON.stringify({
    success: true,
    explanation,
    instruction:
      "Explain why these two were put together, in one or two sentences, as a matchmaker would. " +
      "If `matchStatus` is not a live one (cancelled, expired, completed), this pairing is OVER — talk about it in the past tense and never imply it is still on the table. " +
      "Lead with `synergyReason` if present. The factor words describe the PAIRING, never a rating of the partner — " +
      "never say a partner scored low on anything, and never mention Elo, attractiveness scoring, embeddings or internal numbers. " +
      "`attractivenessBalance` may only be described as how close a fit the two are overall. " +
      "Never reveal the partner's accept/decline decision.",
  });
}

async function execUpdateAgeRange(
  telegramId: bigint,
  args: { min_age: number; max_age: number },
): Promise<string> {
  if (
    !Number.isFinite(args.min_age) ||
    !Number.isInteger(args.min_age) ||
    !Number.isFinite(args.max_age) ||
    !Number.isInteger(args.max_age) ||
    args.min_age < MIN_AGE ||
    args.max_age > MAX_AGE ||
    args.min_age > args.max_age
  ) {
    return JSON.stringify({
      success: false,
      error: `Age range must be between ${MIN_AGE} and ${MAX_AGE}, with min ≤ max.`,
    });
  }

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return JSON.stringify({ success: false, error: "User not found." });

  await prisma.profile.update({
    where: { userId: user.id },
    data: { ageRangeMin: args.min_age, ageRangeMax: args.max_age },
  });

  return JSON.stringify({ success: true, message: `Age range set to ${args.min_age}-${args.max_age}.` });
}

async function execUpdatePartnerPreferences(
  telegramId: bigint,
  args: { preferences: string },
): Promise<string> {
  if (typeof args.preferences !== "string" || !args.preferences.trim()) {
    return JSON.stringify({ success: false, error: "Partner preferences cannot be empty." });
  }
  const preferences = args.preferences.trim();
  if (preferences.length > MAX_PARTNER_PREFERENCES_LENGTH) {
    return JSON.stringify({
      success: false,
      error: `Partner preferences must be ${MAX_PARTNER_PREFERENCES_LENGTH} characters or less.`,
    });
  }
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return JSON.stringify({ success: false, error: "User not found." });

  await prisma.profile.update({
    where: { userId: user.id },
    // M-2: partner preferences feed `buildEmbeddingInput` — mark dirty.
    data: {
      partnerPreferences: preferences,
      embeddingDirty: true,
      embeddingDirtyAt: new Date(),
    },
  });
  const sync = await refreshUserEmbedding(user.id).catch(() => ({ stillDirty: 1 }));

  return JSON.stringify({
    success: true,
    message:
      sync.stillDirty === 0
        ? "Partner preferences updated and applied to matching."
        : "Partner preferences saved; matching will apply them after automatic profile sync.",
  });
}

async function execGetMyProfile(telegramId: bigint): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      firstName: true,
      surname: true,
      age: true,
      gender: true,
      preference: true,
      major: true,
      universityDomain: true,
      status: true,
      profile: {
        select: {
          psychologicalSummary: true,
          hobbies: true,
          partnerPreferences: true,
          ageRangeMin: true,
          ageRangeMax: true,
          height: true,
          photos: true,
        },
      },
    },
  });

  if (!user) return JSON.stringify({ success: false, error: "User not found." });

  return JSON.stringify({
    success: true,
    profile: {
      firstName: user.firstName,
      surname: user.surname,
      age: user.age,
      gender: user.gender,
      preference: user.preference,
      major: user.major,
      university: user.universityDomain,
      status: user.status,
      bio: user.profile?.psychologicalSummary ?? null,
      hobbies: user.profile?.hobbies ?? [],
      partnerPreferences: user.profile?.partnerPreferences ?? null,
      ageRange: user.profile?.ageRangeMin
        ? `${user.profile.ageRangeMin}-${user.profile.ageRangeMax}`
        : null,
      height: user.profile?.height ?? null,
      photoCount: user.profile?.photos?.length ?? 0,
    },
  });
}

async function execPauseMatching(telegramId: bigint): Promise<string> {
  const result = await transitionAccountStatus({ telegramId }, "pause");
  if (result.kind === "not_found") {
    return JSON.stringify({ success: false, error: "User not found." });
  }
  if (result.kind === "already") {
    return JSON.stringify({ success: false, error: "Matching is already paused." });
  }
  if (result.kind === "forbidden") {
    return JSON.stringify({ success: false, error: "This account state cannot be changed by the menu." });
  }

  return JSON.stringify({ success: true, message: "Matching paused. You won't receive new matches until you resume." });
}

/**
 * Persist a conversational rejection reason. Guards:
 *   - match exists and was declined by this user
 *   - the corresponding `rejectionReason{A,B}` is still empty (idempotent)
 *   - reason has at least 10 non-whitespace characters
 *
 * On success: writes the reason to the match and appends a distilled
 * constraint to `Profile.negativeConstraints` via the existing LLM-backed
 * pipeline.
 */
async function execRecordRejectionFeedback(
  telegramId: bigint,
  args: { match_id: string; reason: string },
): Promise<string> {
  const result = await recordRejectionFeedback({
    telegramId,
    matchId: typeof args.match_id === "string" ? args.match_id : "",
    reason: typeof args.reason === "string" ? args.reason : "",
    requireConcreteReason: true,
    updateNegativeConstraints: true,
  });

  if (!result.success) return JSON.stringify({ success: false, error: result.error });

  if (result.status === "already_recorded") {
    return JSON.stringify({
      success: true,
      message: "Rejection reason already recorded for this match. Move on naturally.",
    });
  }

  return JSON.stringify({
    success: true,
    message:
      "Reason saved and matching preferences updated. Thank the user briefly and let them know it'll help find a better fit next batch.",
  });
}

/**
 * Decide how to surface a Premium cancellation. Does NOT cancel anything — it
 * only tells the model what to say and returns the post-reply UI action the
 * router performs (the deterministic confirm card / iOS guide). Stars subs get a
 * confirm button; App Store subs are routed to the iOS-Settings guide; a user
 * with no active subscription gets a plain "nothing to cancel" instruction.
 */
async function evaluatePremiumCancelOffer(
  telegramId: bigint,
): Promise<{ toolResult: string; action: MenuAgentAction | null }> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, language: true },
  });
  if (!user) return { toolResult: JSON.stringify({ active: false }), action: null };

  const cx = await getPremiumCancelContext(user.id);
  if (!cx.active) {
    return {
      toolResult: JSON.stringify({
        active: false,
        instruction:
          "The user has no active Premium subscription — there is nothing to cancel. Tell them that briefly and warmly; do not show any button.",
      }),
      action: null,
    };
  }

  const activeUntil = formatPremiumUntil(cx.premiumUntil, (user.language ?? "en") as Language);
  if (cx.provider === "app_store") {
    return {
      toolResult: JSON.stringify({
        active: true,
        provider: "app_store",
        activeUntil,
        instruction:
          "This subscription was bought via the App Store and can only be cancelled in iOS Settings. A guidance message with the exact steps is shown automatically — reply with only a brief, warm one-liner and do NOT restate the steps or the date.",
      }),
      action: { kind: "premium_cancel_appstore" },
    };
  }

  return {
    toolResult: JSON.stringify({
      active: true,
      provider: "telegram_stars",
      activeUntil,
      instruction:
        "A confirmation card with the details and Yes/Keep buttons is shown to the user automatically. Reply with only a short, warm one-liner (acknowledge, no pressure); do NOT list steps, restate the date, or ask a question.",
    }),
    action: { kind: "premium_cancel_confirm" },
  };
}

// ---------------------------------------------------------------------------
// Entry points (confirm + open classes)
// ---------------------------------------------------------------------------

/** Screens `open_screen` may hand over, mapped to the real menu callbacks. */
const SCREEN_ENTRIES: Record<
  string,
  { labelKey: Parameters<typeof t>[1]; data: string; flag?: "tickets" | "premium" }
> = {
  profile: { labelKey: "menuMyProfile", data: "menu:profile" },
  photos: { labelKey: "editProfilePhotosBtn", data: "menu:edit:photos" },
  edit_bio: { labelKey: "editBioBtn", data: "menu:edit:bio" },
  settings: { labelKey: "menuSettings", data: "menu:settings" },
  tickets: { labelKey: "menuMyTickets", data: "menu:tickets", flag: "tickets" },
  premium: { labelKey: "menuPremium", data: "menu:premium", flag: "premium" },
};

async function userLanguage(telegramId: bigint): Promise<Language> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { language: true },
  });
  return (user?.language ?? "en") as Language;
}

function featureOn(flag: "tickets" | "premium" | undefined): boolean {
  if (!flag) return true;
  if (flag === "tickets") return env.TICKET_FEATURE_ENABLED === true;
  return env.PREMIUM_FEATURE_ENABLED === true;
}

async function execOpenScreen(
  telegramId: bigint,
  args: { screen?: unknown },
): Promise<{ toolResult: string; action: MenuAgentAction | null }> {
  const screen = typeof args.screen === "string" ? args.screen : "";
  const entry = SCREEN_ENTRIES[screen];
  if (!entry) {
    return {
      toolResult: JSON.stringify({ success: false, error: `Unknown screen: ${screen}` }),
      action: null,
    };
  }
  if (!featureOn(entry.flag)) {
    return {
      toolResult: JSON.stringify({
        success: false,
        error: "That part of the product isn't available right now. Say so plainly; show no button.",
      }),
      action: null,
    };
  }

  const lang = await userLanguage(telegramId);
  return {
    toolResult: JSON.stringify({
      success: true,
      instruction:
        "The button is attached to your reply automatically. Say one short line about what it opens — do NOT describe where to tap or repeat the button label.",
    }),
    action: {
      kind: "entry_point",
      entry: { label: t(lang, entry.labelKey), callbackData: entry.data },
    },
  };
}

/**
 * Surface the date-cancellation button for a live scheduled date.
 *
 * Deliberately hands over `emerg:start:<id>` rather than cancelling: that
 * callback is the existing emergency flow, which asks its own two-step
 * confirmation (green "keep the date" above red "yes, cancel") and only then
 * takes the free-text reason. So the agent widens how the flow can be REACHED —
 * by voice, by a sentence, without hunting for a card that scrolled away — and
 * changes nothing about what it takes to actually cancel.
 */
async function execProposeCancelDate(
  telegramId: bigint,
): Promise<{ toolResult: string; action: MenuAgentAction | null }> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, language: true },
  });
  if (!user) {
    return { toolResult: JSON.stringify({ success: false, error: "User not found." }), action: null };
  }

  // A booked date and a date still being planned are cancelled through
  // different handlers, but from the user's side it is one request ("my plans
  // changed").
  const candidates = await prisma.match.findMany({
    where: {
      OR: [{ userAId: user.id }, { userBId: user.id }],
      AND: [
        {
          OR: [
            { status: "scheduled", emergencyCancelledBy: null },
            // The planning stages. `negotiating` with no slots written yet is
            // the Date Ticket gate, which nobody is committed to and which
            // lapses on its own — so it is deliberately excluded.
            { status: "negotiating", proposedTimes: { isEmpty: false } },
            { status: "negotiating_venue" },
          ],
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, proposedTimes: true },
  });
  // The single-live-match invariant means there should be exactly one, but
  // legacy/corrupt data can carry several — so pick by PRODUCT PROGRESSION, in
  // code. `orderBy: { status: "asc" }` looks like it would do this and does the
  // opposite: Postgres sorts an enum by DECLARATION order, and `MatchStatus`
  // declares `negotiating` before `scheduled`, so ascending would hand back the
  // planning match and offer a planning-stage cancel button to someone with a
  // date already booked. ARCHITECTURE.md warns about exactly this.
  const PROGRESSION = ["scheduled", "negotiating_venue", "negotiating"] as const;
  const match =
    PROGRESSION.map((s) => candidates.find((c) => c.status === s)).find(Boolean) ?? null;
  if (!match) {
    return {
      toolResult: JSON.stringify({
        success: false,
        error:
          "There is no date to cancel — they have nothing booked and nothing being planned. " +
          "If a proposal is still awaiting their decision, that is a decline rather than a cancellation: " +
          "explain that and show no button.",
      }),
      action: null,
    };
  }

  const lang = (user.language ?? "en") as Language;
  // The planning stages had no cancellation path at all until §3.5c — this tool
  // used to filter on `scheduled` alone and told the model to "explain that
  // instead", so someone who wrote "I want to cancel" mid-planning received a
  // polite explanation and zero ways out. Both entries below only OPEN a
  // confirmation card; the irreversible step is always the user's own red tap.
  const scheduled = match.status === "scheduled";
  return {
    toolResult: JSON.stringify({
      success: true,
      stage: scheduled ? "scheduled_date" : "still_being_planned",
      instruction:
        "The cancellation button is attached automatically, and tapping it still asks for an explicit confirmation. " +
        "Reply with ONE short line: no pressure, no guilt, and make clear cancelling can't be undone. Do not restate the buttons.",
    }),
    action: {
      kind: "entry_point",
      entry: {
        label: scheduled ? t(lang, "emergencyBtnConfirm") : t(lang, "stallBtnPlansChanged"),
        callbackData: scheduled
          ? `emerg:start:${match.id}`
          : `${STALL_ASK_CANCEL_PREFIX}${match.id}`,
      },
    },
  };
}

/**
 * Surface the account-closure entry. Points at `menu:settings:delete`, which is
 * the FORK — it plays the founder video note and offers freezing (reversible,
 * keeps the profile) above deleting, then runs its own nonce-bound two-step
 * confirmation. The agent must not be able to skip past the softer option.
 */
async function execProposeCloseAccount(
  telegramId: bigint,
): Promise<{ toolResult: string; action: MenuAgentAction | null }> {
  const lang = await userLanguage(telegramId);
  return {
    toolResult: JSON.stringify({
      success: true,
      instruction:
        "The account button is attached automatically; it opens a screen that offers freezing (fully reversible, nothing is lost) before deletion, and deletion still needs its own confirmations. " +
        "Reply with ONE short line — no guilt-tripping, no sales pitch, and mention that freezing exists so they don't have to lose anything.",
    }),
    action: {
      kind: "entry_point",
      entry: {
        label: t(lang, "settingsDeleteAccount"),
        callbackData: "menu:settings:delete",
      },
    },
  };
}

async function execResumeMatching(telegramId: bigint): Promise<string> {
  const result = await transitionAccountStatus({ telegramId }, "resume");
  if (result.kind === "not_found") {
    return JSON.stringify({ success: false, error: "User not found." });
  }
  if (result.kind === "already") {
    return JSON.stringify({ success: false, error: "Matching is already active." });
  }
  if (result.kind === "forbidden") {
    return JSON.stringify({
      success: false,
      error: "Matching can only be resumed from a paused account state.",
    });
  }

  return JSON.stringify({ success: true, message: "Matching resumed! You'll be included in the next batch." });
}

// ---------------------------------------------------------------------------
// Core Agent Loop
// ---------------------------------------------------------------------------

const MAX_TOOL_ROUNDS = 4;

/**
 * Run one turn of the post-onboarding menu agent.
 *
 * Unlike the onboarding agent, this agent rebuilds the system prompt
 * from scratch on every turn (dynamic knowledge + user context), so the
 * first system message in the history is always replaced.
 */
export async function runMenuAgentTurn(
  telegramId: bigint,
  userMessage: string,
  deps: MenuAgentDeps = {},
): Promise<MenuAgentResult> {
  const fetchFn = deps.fetchFn ?? openaiFetch;

  // Build dynamic system prompt
  const systemPrompt = await buildSystemPrompt(telegramId);

  // Load existing post-onboarding history
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { messageHistory: true },
  });

  const stored: StoredChatMessage[] = (
    (user?.messageHistory ?? []) as unknown[]
  ).map((m) => m as unknown as StoredChatMessage);

  // Build conversation: fresh system prompt + recent history + new user msg
  const history: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const msg of recentAgentHistory(stored)) {
    history.push(msg);
  }

  history.push({ role: "user", content: userMessage });

  // A tool may request a post-reply UI action (e.g. the Premium cancel card).
  let pendingAction: MenuAgentAction | null = null;
  // Writes actually applied this turn, and the code-owned line each earned.
  let writesUsed = 0;
  const receipts: string[] = [];
  let language: Language | null = null;
  const receiptLine = async (key: Parameters<typeof t>[1]): Promise<void> => {
    language ??= await userLanguage(telegramId);
    receipts.push(t(language, key));
  };

  // Agent loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callOpenAI(
      toApiMessages(truncateForApi(history, MAX_HISTORY_FOR_API)),
      fetchFn,
    );
    const choice = response.choices[0];
    if (!choice) break;

    const assistantMsg = choice.message;
    history.push({
      role: "assistant",
      content: assistantMsg.content,
      ...(assistantMsg.tool_calls ? { tool_calls: assistantMsg.tool_calls } : {}),
    });

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      break;
    }

    for (const toolCall of assistantMsg.tool_calls) {
      const fnName = toolCall.function.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      // Budget check before anything runs: a write beyond the first is refused
      // outright rather than executed and reported. The model is told to ask,
      // so the second change becomes the user's next message — one intent, one
      // write, always visible.
      if (TOOL_KINDS[fnName] === "write" && writesUsed >= MAX_WRITES_PER_TURN) {
        history.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            success: false,
            error: "write_budget_exhausted",
            instruction:
              "You already changed something this turn, so this second change was NOT saved. Tell the user what you changed, name what else you were about to change, and ask them to confirm it in their next message.",
          }),
        });
        continue;
      }

      let result: string;
      /** Set by a write executor that actually persisted something. */
      let receiptKey: Parameters<typeof t>[1] | null = null;
      switch (fnName) {
        case "update_bio": {
          const outcome = await execUpdateBio(telegramId, args as { bio: string });
          result = outcome.toolResult;
          if (outcome.action) pendingAction = outcome.action;
          else receiptKey = "editBioSaved";
          break;
        }
        case "update_major":
          result = await execUpdateMajor(telegramId, args as { major: string });
          receiptKey = "editMajorSaved";
          break;
        case "update_age_range":
          result = await execUpdateAgeRange(
            telegramId,
            args as { min_age: number; max_age: number },
          );
          receiptKey = "editAgeRangeSaved";
          break;
        case "update_partner_preferences":
          result = await execUpdatePartnerPreferences(
            telegramId,
            args as { preferences: string },
          );
          receiptKey = "editPrefsDescriptionSaved";
          break;
        case "update_hobbies":
          result = await execUpdateHobbies(telegramId, args as { hobbies: unknown });
          receiptKey = "editHobbiesSaved";
          break;
        case "set_language":
          result = await execSetLanguage(telegramId, args as { language?: unknown });
          // Read AFTER the write, so this picks up the language just set —
          // the receipt lands in the language the user is switching TO.
          receiptKey = "settingsLanguageSaved";
          break;
        case "set_theme":
          result = await execSetTheme(telegramId, args as { theme?: unknown });
          receiptKey = "settingsThemeSaved";
          break;
        case "get_my_profile":
          result = await execGetMyProfile(telegramId);
          break;
        case "get_my_standing":
          result = await execGetMyStanding(telegramId);
          break;
        case "explain_my_match":
          result = await execExplainMyMatch(telegramId);
          break;
        case "pause_matching":
          result = await execPauseMatching(telegramId);
          receiptKey = "pauseConfirmed";
          break;
        case "resume_matching":
          result = await execResumeMatching(telegramId);
          receiptKey = "resumeConfirmed";
          break;
        case "record_rejection_feedback":
          result = await execRecordRejectionFeedback(
            telegramId,
            args as { match_id: string; reason: string },
          );
          break;
        case "offer_cancel_premium": {
          const outcome = await evaluatePremiumCancelOffer(telegramId);
          result = outcome.toolResult;
          if (outcome.action) pendingAction = outcome.action;
          break;
        }
        case "propose_cancel_date": {
          const outcome = await execProposeCancelDate(telegramId);
          result = outcome.toolResult;
          if (outcome.action) pendingAction = outcome.action;
          break;
        }
        case "propose_close_account": {
          const outcome = await execProposeCloseAccount(telegramId);
          result = outcome.toolResult;
          if (outcome.action) pendingAction = outcome.action;
          break;
        }
        case "open_screen": {
          const outcome = await execOpenScreen(telegramId, args as { screen?: unknown });
          result = outcome.toolResult;
          if (outcome.action) pendingAction = outcome.action;
          break;
        }
        default:
          result = JSON.stringify({ error: `Unknown tool: ${fnName}` });
      }

      // Only count and acknowledge a write that reported success — a rejected
      // edit must neither burn the turn's budget nor tell the user it landed.
      if (TOOL_KINDS[fnName] === "write" && toolReportedSuccess(result)) {
        writesUsed++;
        if (receiptKey) await receiptLine(receiptKey);
      }

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  // Persist history (only non-system messages to keep it lean; system prompt is
  // rebuilt). Each turn is stamped so the next call can replay only this
  // agent's own recent conversation — see `recentAgentHistory`.
  const stamp = Date.now();
  const toStore: StoredChatMessage[] = history
    .filter((m) => m.role !== "system")
    .map((m) => ({ ...m, ts: (m as StoredChatMessage).ts ?? stamp }));
  await prisma.user.update({
    where: { telegramId },
    data: {
      messageHistory: toStore as unknown as Prisma.InputJsonValue[],
      lastMessageAt: new Date(),
    },
  });

  const lastAssistant = [...history]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);
  // Localized, because this is reachable on an ordinary turn — an empty
  // `content` (the model spent its completion budget, or the round limit ran
  // out mid tool-loop) used to answer a Russian-speaking user with an English
  // sentence out of nowhere, which reads exactly like the bot switching
  // languages on its own.
  const reply =
    lastAssistant?.content ?? t(await userLanguage(telegramId), "agentFallbackError");

  return {
    reply,
    ...(pendingAction ? { action: pendingAction } : {}),
    ...(receipts.length > 0 ? { receipts } : {}),
  };
}

// ---------------------------------------------------------------------------
// OpenAI API Call
// ---------------------------------------------------------------------------

async function callOpenAI(
  messages: ChatMessage[],
  fetchFn: typeof fetch,
): Promise<ChatCompletionResponse> {
  const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODELS.agent,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.5,
      // Raised from 512. This budget also covers reasoning tokens, and Cyrillic
      // costs roughly twice as many tokens per character as Latin — so a
      // three-bubble Russian reply could hit the ceiling, come back with an
      // empty `content`, and land the user on the fallback line above.
      max_completion_tokens: 900,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${body}`);
  }

  return (await res.json()) as ChatCompletionResponse;
}
