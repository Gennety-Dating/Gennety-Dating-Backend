import { prisma } from "@gennety/db";
import { openaiFetch } from "./openai-fetch.js";
import { t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { MODELS } from "../models.js";
import { createChatImageSignedUrl } from "./storage.js";
import {
  applyChatProfilePatch,
  attachChatProfilePhoto,
} from "./chat-profile-tools.js";
import {
  AGENT_TOOLS,
  MAX_WRITES_PER_TURN,
  TOOL_KINDS,
  executeAgentTool,
  toolReportedSuccess,
  type MenuAgentAction,
} from "./menu-agent.js";
import { buildSystemPrompt } from "./prompt-builder.js";

/**
 * Gennety chat agent — the multimodal AI chat backing `/v1/chat/message`,
 * i.e. the mobile app's Chat tab.
 *
 * Distinct from the legacy `onboarding-agent` and `menu-agent` (which read /
 * write `User.messageHistory: Json[]`): this agent persists each turn as a row
 * in the `Message` table and supports image attachments end-to-end. It also
 * runs a background tool loop that mutates the user's `Profile` whenever
 * the model surfaces high-confidence facts during the conversation.
 */

const MODEL = MODELS.agent;
const HISTORY_LIMIT = 30;
const MAX_TOOL_ITERATIONS = 3;
const TIMEOUT_MS = 45_000;

/**
 * Чатовая надстройка над общим системным промптом.
 *
 * Персона, продуктовый плейбук, контекст пользователя, лента событий и
 * закрепление языка приходят из `buildSystemPrompt` — того же, что кормит
 * телеграм-агента. Здесь остаётся ровно то, чего у той поверхности нет и быть
 * не может: картинки. Дублировать персону во второй раз значило бы завести
 * второго агента с тем же именем и другим характером — ровно то расхождение,
 * которое эта задача закрывает.
 */
const CHAT_ADDENDUM = `## This surface: chat with images

The person is in the app's Chat tab, not in Telegram. Two things follow.

1. **They can attach photos.** When an image is clearly a head-and-shoulders
   portrait of the user themselves, call \`attach_profile_photo\` with the
   \`imageUrl\` token from their most recent turn. Never attach group photos,
   screenshots, memes, or photos that are not of them. If unsure, ask first.
2. **A few profile fields live only here.** \`update_profile\` covers what the
   other tools do not — \`preference\` and \`height\`. Everything else has its
   own tool; use that one instead, and never both for the same fact.

Age and gender are fixed after onboarding and this tab opens only afterwards,
so treat them as read-only: if someone says one of them is wrong, say support
can correct it and move on.`

/**
 * Инструменты, которых нет у общего набора, — всё, что чат умеет один.
 *
 * **`update_profile` сознательно сужен до `preference` и `height`.** Прежде он
 * принимал ещё `hobbies` и `partnerPreferences`, но у обоих с этого хода есть
 * собственные инструменты (`update_hobbies`, `update_partner_preferences`), и
 * два пути к одному полю — это модель, выбирающая между ними наугад, и две
 * записи там, где бюджет хода разрешает одну. `age` и `gender` убраны потому,
 * что были мертвы: `applyChatProfilePatch` игнорирует их у завершивших
 * онбординг, а вкладка «Чат» открывается только после него.
 */
const CHAT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "update_profile",
      description:
        "Patch the two profile fields no other tool covers: who they want to be matched with, and their height. Only include what you are sure about.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          preference: { type: "string", enum: ["men", "women", "both"] },
          height: { type: "integer", minimum: 120, maximum: 230 },
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

/**
 * Что уходит модели: семнадцать общих инструментов плюс два чатовых.
 * Порядок значения не имеет, а совпадений имён нет — проверяется тестом.
 */
const ALL_TOOLS = [...AGENT_TOOLS, ...CHAT_TOOLS];

/**
 * Класс чатовых инструментов. Оба пишут, значит оба попадают под бюджет хода:
 * одно сообщение — одно намерение, и вторая запись в том же ходу отвергается,
 * а не применяется молча (тот же довод, что в `menu-agent`).
 */
const CHAT_TOOL_KINDS: Record<string, "write"> = {
  update_profile: "write",
  attach_profile_photo: "write",
};

function toolKind(name: string): string | undefined {
  return TOOL_KINDS[name] ?? CHAT_TOOL_KINDS[name];
}

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

export interface ChatTurnInput {
  userId: string;
  text: string;
  imageUrl: string | null;
}

export interface ChatTurnResult {
  id: string;
  role: "assistant";
  content: string;
  imageUrl: null;
  createdAt: Date;
  /**
   * Подтверждения записей, которые ДЕЙСТВИТЕЛЬНО применились. Их пишет код, а
   * не модель: иначе единственным свидетельством правки профиля была бы её
   * проза, которую она вольна сочинить — включая рассказ об изменении, молча
   * не сохранившемся.
   */
  receipts?: string[];
  /** Native-действие, которое агент не умеет нарисовать сам. */
  action?: MenuAgentAction;
}

export interface ChatDeps {
  fetchFn?: typeof fetch;
}

const userLocks = new Map<string, Promise<ChatTurnResult>>();

/**
 * Public entry point. Per-user serial — a second concurrent call from the
 * same user awaits the prior turn so DB inserts don't interleave.
 */
export async function runChatTurn(
  input: ChatTurnInput,
  deps: ChatDeps = {},
): Promise<ChatTurnResult> {
  const existing = userLocks.get(input.userId);
  const next = (existing ?? Promise.resolve()).then(() => runTurnInner(input, deps));
  // Swallow rejection on the lock chain — callers see the original error via `next`.
  const lockChain = next.catch(() => undefined as unknown as ChatTurnResult);
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
  input: ChatTurnInput,
  deps: ChatDeps,
): Promise<ChatTurnResult> {
  const { userId, text, imageUrl } = input;
  const fetchFn = deps.fetchFn ?? openaiFetch;

  // `telegramId` — ключ общих исполнителей, и это не привязка к Telegram:
  // колонка заполнена у всех, мобильным выдаётся синтетический отрицательный
  // id. Читается один раз за ход вместе с языком, на котором пишутся чеки.
  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramId: true, language: true },
  });
  if (!account) throw new Error(`Unknown user ${userId}`);
  const telegramId = account.telegramId;
  const language = (account.language ?? "en") as Language;

  await prisma.message.create({
    data: { userId, role: "user", content: text, imageUrl },
  });

  const messages = await buildChatMessages(userId, telegramId);

  let iteration = 0;
  let lastReply = "";
  let writesUsed = 0;
  const receipts: string[] = [];
  let pendingAction: MenuAgentAction | null = null;
  while (iteration < MAX_TOOL_ITERATIONS) {
    const completion = await callOpenAI(messages, fetchFn);
    if (!completion) {
      lastReply = fallbackReply(language);
      break;
    }
    const choice = completion.choices[0];
    if (!choice) {
      lastReply = fallbackReply(language);
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
      const name = tc.function.name;

      // Бюджет проверяется ДО запуска: вторая запись за ход отвергается, а не
      // применяется и потом объясняется. Модели сказано попросить — значит
      // второе изменение становится следующим сообщением человека.
      if (toolKind(name) === "write" && writesUsed >= MAX_WRITES_PER_TURN) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            success: false,
            error: "write_budget_exhausted",
            instruction:
              "You already changed something this turn, so this second change was NOT saved. Tell the user what you changed, name what else you were about to change, and ask them to confirm it in their next message.",
          }),
        });
        continue;
      }

      const outcome = await executeTool(userId, telegramId, tc);
      if (outcome.action) pendingAction = outcome.action;

      // Считается и подтверждается только запись, отчитавшаяся об успехе:
      // отклонённая правка не должна ни жечь бюджет, ни говорить человеку,
      // что она применилась.
      if (toolKind(name) === "write" && toolReportedSuccess(outcome.result)) {
        writesUsed++;
        if (outcome.receiptKey) receipts.push(t(language, outcome.receiptKey));
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: outcome.result,
      });
    }
    iteration++;
  }

  if (!lastReply) lastReply = fallbackReply(language);

  const persisted = await prisma.message.create({
    data: { userId, role: "assistant", content: lastReply },
  });

  return {
    id: persisted.id,
    role: "assistant",
    content: persisted.content,
    imageUrl: null,
    createdAt: persisted.createdAt,
    ...(receipts.length > 0 ? { receipts } : {}),
    ...(pendingAction ? { action: pendingAction } : {}),
  };
}

/**
 * The line the user gets when the model gives us nothing usable — no
 * completion, no choice, or a tool loop that ran out of rounds.
 *
 * Localized, and for the reason the menu agent already wrote down when it fixed
 * the same defect: an English sentence appearing out of nowhere reads exactly
 * like the bot deciding on its own to switch languages.
 *
 * **Язык больше не ищется здесь — он приходит аргументом.** Прежняя редакция
 * запрашивала его сама, чтобы здоровый ход не платил за запрос. Теперь ход всё
 * равно читает аккаунт: общим исполнителям нужен `telegramId`. Язык берётся из
 * того же запроса, так что запрос на ход по-прежнему ровно один, а не два.
 */
function fallbackReply(language: Language): string {
  return t(language, "agentFallbackError");
}

async function buildChatMessages(
  userId: string,
  telegramId: bigint,
): Promise<OpenAIChatMessage[]> {
  const rows = await prisma.message.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });
  rows.reverse();

  // Общий промпт плюс чатовая надстройка: персона, плейбук, контекст
  // пользователя, лента и закрепление языка приходят оттуда же, откуда их
  // берёт Telegram, — второй персоны у продукта быть не должно.
  const base = await buildSystemPrompt(telegramId);
  const out: OpenAIChatMessage[] = [
    { role: "system", content: `${base}\n\n${CHAT_ADDENDUM}` },
  ];

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
        tools: ALL_TOOLS,
        messages,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[chat] OpenAI call failed: ${res.status} ${body}`);
      return null;
    }
    return (await res.json()) as ChatCompletionResponse;
  } catch (err) {
    console.warn("[chat] OpenAI call error:", err);
    return null;
  }
}

async function executeTool(
  userId: string,
  telegramId: bigint,
  call: OpenAIToolCall,
): Promise<{ result: string; receiptKey: Parameters<typeof t>[1] | null; action: MenuAgentAction | null }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments || "{}");
  } catch {
    return { result: JSON.stringify({ ok: false, detail: "Invalid JSON arguments" }), receiptKey: null, action: null };
  }

  // Сначала чатовые: они работают с `userId` и с картинками, которых у общего
  // набора нет. Всё остальное уходит общему исполнителю — тому же, что водит
  // Telegram, поэтому расхождению поведения взяться неоткуда.
  if (call.function.name === "update_profile") {
    const outcome = await applyChatProfilePatch(userId, parsed);
    return { result: JSON.stringify(outcome), receiptKey: outcome.ok ? "editProfileSaved" : null, action: null };
  }
  if (call.function.name === "attach_profile_photo") {
    const outcome = await attachChatProfilePhoto(userId, parsed);
    return { result: JSON.stringify(outcome), receiptKey: outcome.ok ? "editProfilePhotosSaved" : null, action: null };
  }

  return executeAgentTool(telegramId, call.function.name, parsed as Record<string, unknown>);
}
