import { prisma } from "@gennety/db";
import { MAX_AGE, MAX_PHOTOS, MIN_AGE } from "@gennety/shared";
import { env } from "../config.js";
import { createChatImageSignedUrl } from "./storage.js";
import {
  applyAetherProfilePatch,
  attachAetherProfilePhoto,
  type AetherToolResult,
} from "./aether-profile-tools.js";

/**
 * Aether Concierge — multimodal AI chat agent backing `/v1/chat/message`.
 *
 * Distinct from the legacy `onboarding-agent` and `menu-agent` (which read /
 * write `User.messageHistory: Json[]`): Aether persists each turn as a row
 * in the `Message` table and supports image attachments end-to-end. It also
 * runs a background tool loop that mutates the user's `Profile` whenever
 * the model surfaces high-confidence facts during the conversation.
 */

const MODEL = "gpt-4.1-mini";
const HISTORY_LIMIT = 30;
const MAX_TOOL_ITERATIONS = 3;
const TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT = `You are Aether — the AI concierge for Gennety Dating, an AI-first matchmaking service for university students.

Your mission is to gather a rich profile of the user through natural, friendly conversation and to silently update their profile record in the background as you learn things.

## Strict Product Rules
- This app has a "Zero-Chat" philosophy: users NEVER message each other through our platform. We match people and schedule first dates. Never offer or imply in-app chat between users.
- Age must be between ${MIN_AGE} and ${MAX_AGE} (inclusive). If a user's stated age is outside this range, kindly explain we cannot serve them.
- A user can have at most ${MAX_PHOTOS} profile photos.

## Your Job
1. Welcome the user warmly. Ask open questions about who they are, what they enjoy, and what they're looking for.
2. As the conversation progresses, extract structured facts. Whenever you learn ANY of these with high confidence, call the \`update_profile\` tool with just the fields you learned (do NOT re-send fields the user hasn't mentioned this turn):
   - age (integer ${MIN_AGE}-${MAX_AGE})
   - gender ("male" | "female")
   - preference ("men" | "women" | "both")
   - ethnicity (free text)
   - height (integer cm)
   - hobbies (array of short strings)
   - partnerPreferences (one short sentence)
3. When a user attaches an image and it is clearly a head-and-shoulders portrait of themselves, call \`attach_profile_photo\` with the imageUrl token from the user's most recent turn. Do NOT attach group photos, screenshots, memes, or photos that aren't of the user. If unsure, ask before attaching.
4. Keep replies short, warm, conversational. Never list the schema back to the user. Never say "I am updating your profile" — just chat.
5. After calling tools, continue the conversation naturally with the user's next question or a gentle follow-up.

You speak the user's language (auto-detect). Keep replies under ~3 sentences unless the user explicitly asks for more detail.`;

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "update_profile",
      description:
        "Patch the user's profile with high-confidence facts you have just learned. Only include fields you are sure about; omit everything else.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          age: { type: "integer", minimum: MIN_AGE, maximum: MAX_AGE },
          gender: { type: "string", enum: ["male", "female"] },
          preference: { type: "string", enum: ["men", "women", "both"] },
          ethnicity: { type: "string", maxLength: 64 },
          height: { type: "integer", minimum: 120, maximum: 230 },
          hobbies: {
            type: "array",
            items: { type: "string", maxLength: 48 },
            maxItems: 12,
          },
          partnerPreferences: { type: "string", maxLength: 280 },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "attach_profile_photo",
      description:
        "Add an image the user just uploaded to their profile photos. Only call this for clear portraits of the user.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["imageUrl"],
        properties: {
          imageUrl: { type: "string" },
        },
      },
    },
  },
];

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<TextPart | ImagePart> | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface TextPart {
  type: "text";
  text: string;
}

interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
}

export interface AetherTurnInput {
  userId: string;
  text: string;
  imageUrl: string | null;
}

export interface AetherTurnResult {
  id: string;
  role: "assistant";
  content: string;
  imageUrl: null;
  createdAt: Date;
}

export interface AetherDeps {
  fetchFn?: typeof fetch;
}

const userLocks = new Map<string, Promise<AetherTurnResult>>();

/**
 * Public entry point. Per-user serial — a second concurrent call from the
 * same user awaits the prior turn so DB inserts don't interleave.
 */
export async function runAetherTurn(
  input: AetherTurnInput,
  deps: AetherDeps = {},
): Promise<AetherTurnResult> {
  const existing = userLocks.get(input.userId);
  const next = (existing ?? Promise.resolve()).then(() => runTurnInner(input, deps));
  // Swallow rejection on the lock chain — callers see the original error via `next`.
  const lockChain = next.catch(() => undefined as unknown as AetherTurnResult);
  userLocks.set(input.userId, lockChain);
  try {
    return await next;
  } finally {
    if (userLocks.get(input.userId) === lockChain) {
      userLocks.delete(input.userId);
    }
  }
}

async function runTurnInner(
  input: AetherTurnInput,
  deps: AetherDeps,
): Promise<AetherTurnResult> {
  const { userId, text, imageUrl } = input;
  const fetchFn = deps.fetchFn ?? fetch;

  await prisma.message.create({
    data: { userId, role: "user", content: text, imageUrl },
  });

  const messages = await buildChatMessages(userId);

  let iteration = 0;
  let lastReply = "";
  while (iteration < MAX_TOOL_ITERATIONS) {
    const completion = await callOpenAI(messages, fetchFn);
    if (!completion) {
      lastReply = fallbackReply();
      break;
    }
    const choice = completion.choices[0];
    if (!choice) {
      lastReply = fallbackReply();
      break;
    }

    const assistantMsg: OpenAIChatMessage = {
      role: "assistant",
      content: choice.message.content,
    };
    if (choice.message.tool_calls?.length) {
      assistantMsg.tool_calls = choice.message.tool_calls;
    }
    messages.push(assistantMsg);

    if (!choice.message.tool_calls?.length) {
      lastReply = (choice.message.content ?? "").trim();
      break;
    }

    for (const tc of choice.message.tool_calls) {
      const result = await executeTool(userId, tc);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
    iteration++;
  }

  if (!lastReply) lastReply = fallbackReply();

  const persisted = await prisma.message.create({
    data: { userId, role: "assistant", content: lastReply },
  });

  return {
    id: persisted.id,
    role: "assistant",
    content: persisted.content,
    imageUrl: null,
    createdAt: persisted.createdAt,
  };
}

function fallbackReply(): string {
  return "Sorry — I had trouble thinking that one through. Could you say that again?";
}

async function buildChatMessages(userId: string): Promise<OpenAIChatMessage[]> {
  const rows = await prisma.message.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });
  rows.reverse();

  const out: OpenAIChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const isLast = i === rows.length - 1;

    if (row.role === "user") {
      if (isLast && row.imageUrl) {
        const signed = await createChatImageSignedUrl(row.imageUrl);
        const parts: Array<TextPart | ImagePart> = [];
        const txt = row.content ?? "";
        if (txt) parts.push({ type: "text", text: txt });
        if (signed) {
          parts.push({ type: "image_url", image_url: { url: signed } });
          // Surface the storage path so the model can pass it back into
          // `attach_profile_photo` without us round-tripping a separate URL.
          parts.push({ type: "text", text: `[imageUrl=${row.imageUrl}]` });
        }
        out.push({ role: "user", content: parts });
      } else {
        const suffix = row.imageUrl ? "\n[image attached earlier]" : "";
        out.push({ role: "user", content: (row.content ?? "") + suffix });
      }
    } else if (row.role === "assistant") {
      out.push({ role: "assistant", content: row.content ?? "" });
    }
    // `system` rows are ignored — our SYSTEM_PROMPT is canonical.
  }

  return out;
}

async function callOpenAI(
  messages: OpenAIChatMessage[],
  fetchFn: typeof fetch,
): Promise<ChatCompletionResponse | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_completion_tokens: 512,
        temperature: 0.7,
        tools: TOOLS,
        messages,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[aether] OpenAI call failed: ${res.status} ${body}`);
      return null;
    }
    return (await res.json()) as ChatCompletionResponse;
  } catch (err) {
    console.warn("[aether] OpenAI call error:", err);
    return null;
  }
}

async function executeTool(
  userId: string,
  call: OpenAIToolCall,
): Promise<AetherToolResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments || "{}");
  } catch {
    return { ok: false, detail: "Invalid JSON arguments" };
  }

  if (call.function.name === "update_profile") {
    return applyAetherProfilePatch(userId, parsed);
  }
  if (call.function.name === "attach_profile_photo") {
    return attachAetherProfilePhoto(userId, parsed);
  }
  return { ok: false, detail: `Unknown tool ${call.function.name}` };
}
