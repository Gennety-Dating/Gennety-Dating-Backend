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

import { prisma, Prisma } from "@gennety/db";
import { openaiFetch } from "./openai-fetch.js";
import {
  MAX_BIO_LENGTH,
  MAX_PARTNER_PREFERENCES_LENGTH,
  MAX_MAJOR_LENGTH,
  MIN_AGE,
  MAX_AGE,
  MAX_HISTORY_FOR_API,
} from "@gennety/shared";
import { env } from "../config.js";
import { MODELS } from "../models.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { truncateForApi, type ChatMessage } from "./onboarding-agent.js";
import { recordRejectionFeedback } from "./rejection-feedback.js";
import { refreshUserEmbedding } from "../workers/embedding-refresh.js";
import { transitionAccountStatus } from "./account-status-transitions.js";

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

export interface MenuAgentResult {
  reply: string;
}

/** Max bubbles per reply — more reads as spam, not chat. */
const MAX_REPLY_BUBBLES = 3;

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
 * bubble so nothing is dropped; a reply without blank lines stays one bubble.
 * Also strips markdown emphasis — the bubbles are sent as plain text.
 */
export function splitReplyIntoBubbles(reply: string): string[] {
  const parts = stripMarkdownEmphasis(reply)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return [reply.trim()].filter(Boolean);
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
];

// ---------------------------------------------------------------------------
// Tool Executors
// ---------------------------------------------------------------------------

async function execUpdateBio(
  telegramId: bigint,
  args: { bio: string },
): Promise<string> {
  if (typeof args.bio !== "string" || !args.bio.trim()) {
    return JSON.stringify({ success: false, error: "Bio cannot be empty." });
  }
  const bio = args.bio.trim();
  if (bio.length > MAX_BIO_LENGTH) {
    return JSON.stringify({
      success: false,
      error: `Bio must be ${MAX_BIO_LENGTH} characters or less (currently ${bio.length}).`,
    });
  }

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return JSON.stringify({ success: false, error: "User not found." });

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

  return JSON.stringify({
    success: true,
    message:
      sync.stillDirty === 0
        ? "Bio updated and applied to matching."
        : "Bio saved; matching will apply it after automatic profile sync.",
  });
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

  await prisma.user.update({
    where: { telegramId },
    data: { major },
  });

  return JSON.stringify({ success: true, message: "Major updated." });
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
          ethnicity: true,
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
      ethnicity: user.profile?.ethnicity ?? null,
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

  const stored: ChatMessage[] = (
    (user?.messageHistory ?? []) as unknown[]
  ).map((m) => m as unknown as ChatMessage);

  // Build conversation: fresh system prompt + non-system history + new user msg
  const history: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  // Carry over previous non-system messages (preserves conversation continuity)
  for (const msg of stored) {
    if (msg.role !== "system") {
      history.push(msg);
    }
  }

  history.push({ role: "user", content: userMessage });

  // Agent loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callOpenAI(truncateForApi(history, MAX_HISTORY_FOR_API), fetchFn);
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

      let result: string;
      switch (fnName) {
        case "update_bio":
          result = await execUpdateBio(telegramId, args as { bio: string });
          break;
        case "update_major":
          result = await execUpdateMajor(telegramId, args as { major: string });
          break;
        case "update_age_range":
          result = await execUpdateAgeRange(
            telegramId,
            args as { min_age: number; max_age: number },
          );
          break;
        case "update_partner_preferences":
          result = await execUpdatePartnerPreferences(
            telegramId,
            args as { preferences: string },
          );
          break;
        case "get_my_profile":
          result = await execGetMyProfile(telegramId);
          break;
        case "pause_matching":
          result = await execPauseMatching(telegramId);
          break;
        case "resume_matching":
          result = await execResumeMatching(telegramId);
          break;
        case "record_rejection_feedback":
          result = await execRecordRejectionFeedback(
            telegramId,
            args as { match_id: string; reason: string },
          );
          break;
        default:
          result = JSON.stringify({ error: `Unknown tool: ${fnName}` });
      }

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  // Persist history (only non-system messages to keep it lean; system prompt is rebuilt)
  const toStore = history.filter((m) => m.role !== "system");
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
  const reply =
    lastAssistant?.content ?? "Something went wrong. Try again in a moment.";

  return { reply };
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
      max_completion_tokens: 512,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${body}`);
  }

  return (await res.json()) as ChatCompletionResponse;
}
