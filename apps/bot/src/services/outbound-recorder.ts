import { AsyncLocalStorage } from "node:async_hooks";
import type { Transformer } from "grammy";
import {
  forgetChatEventForMessage,
  recordChatEventForChat,
  resolveChatTarget,
  type ChatEventAction,
  type ChatEventMedia,
} from "./chat-events.js";

/**
 * Outbound half of the chat timeline (PRODUCT_SPEC §2.1 — "Recent chat
 * timeline").
 *
 * Everything the bot says is written from ~276 scattered call sites — handlers,
 * cron workers, the date lifecycle, Mini App routes — but they all go through
 * ONE grammY `Api` instance (`setMainBotApi(bot.api)` in `index.ts`). So a
 * single API transformer captures 100% of outgoing traffic without touching a
 * single call site, and it keeps working for flows written later.
 *
 * What is deliberately NOT recorded:
 *   - every `edit*` method — the pinned status banner and the pitch's reply
 *     deadline button are re-rendered EVERY MINUTE per user; recording those
 *     would bury the timeline in noise and the table in rows;
 *   - `sendChatAction` and the Bot API 10.1 rich-message drafts, which are
 *     ephemeral by definition;
 *   - anything sent inside `withEphemeralSends` — the "agent is thinking"
 *     status beats, which send a normal message and delete it seconds later.
 */

// ---------------------------------------------------------------------------
// Ephemeral marking
// ---------------------------------------------------------------------------

const ephemeralStorage = new AsyncLocalStorage<true>();

/**
 * Mark every Telegram send made inside `fn` as ephemeral, so the timeline
 * ignores it. Used by the self-deleting status sequences in `ai-stream.ts`.
 */
export function withEphemeralSends<T>(fn: () => Promise<T>): Promise<T> {
  return ephemeralStorage.run(true, fn);
}

function isEphemeral(): boolean {
  return ephemeralStorage.getStore() === true;
}

// ---------------------------------------------------------------------------
// Third-party text redaction
// ---------------------------------------------------------------------------

const redactedSummaryStorage = new AsyncLocalStorage<string>();

/**
 * Record every send made inside `fn` under a fixed neutral `marker` instead of
 * its real body.
 *
 * A handful of outbound messages carry text written by ANOTHER user, relayed
 * to this one deliberately: the emergency cancellation reason (quoted verbatim
 * by product rule — no rewrite, no stripping) and every message relayed through
 * the pre-date proxy chat. The timeline those sends land in is rendered straight
 * into the menu agent's system prompt, and that agent holds tools that write to
 * the reader's own profile — so a partner's free text would otherwise become
 * untrusted instructions sitting inside this user's prompt.
 *
 * The timeline only needs to know WHAT happened on screen, never to quote it, so
 * the marker preserves everything the agent legitimately uses ("the partner sent
 * a cancellation reason") while the body — the part an attacker controls — is
 * never stored. Sanitising the text instead was rejected: the relay is verbatim
 * by design and no filter is a trust boundary.
 */
export function withRedactedSummary<T>(marker: string, fn: () => Promise<T>): Promise<T> {
  return redactedSummaryStorage.run(marker, fn);
}

function redactedSummary(): string | null {
  return redactedSummaryStorage.getStore() ?? null;
}

// ---------------------------------------------------------------------------
// Method classification
// ---------------------------------------------------------------------------

/** Durable send methods and the timeline `kind` each produces. */
const RECORDED_METHODS: Record<string, string> = {
  sendMessage: "text",
  sendPhoto: "photo",
  sendMediaGroup: "album",
  sendVideo: "video",
  sendVideoNote: "video_note",
  sendVoice: "voice",
  sendAnimation: "video",
  sendDocument: "document",
};

/** Placeholder summary when a media send carries no caption of its own. */
const KIND_FALLBACK_SUMMARY: Record<string, string> = {
  photo: "(photo card, no caption)",
  album: "(photo album, no caption)",
  video: "(video, no caption)",
  video_note: "(video note / кружок)",
  voice: "(voice note)",
  document: "(file)",
};

/**
 * Coarse product area per callback-data prefix. The prefixes are already the
 * product's own vocabulary, so this needs no per-call-site annotation.
 */
const SURFACE_BY_CALLBACK_PREFIX: Array<[string, string]> = [
  ["vchg:", "venue_change"],
  ["sched:", "calendar"],
  ["match:", "match"],
  ["mdr:", "match_decline_reason"],
  ["emerg:", "date_emergency"],
  ["datecard:", "date_card"],
  ["coord:", "coordination"],
  ["feedback:", "post_date_feedback"],
  ["report:", "report"],
  ["rc:", "report"],
  ["rs:", "report"],
  ["rb:", "report"],
  ["verify:", "verification"],
  ["prem:", "premium"],
  ["profiler:", "profiler"],
  ["radar:", "type_radar"],
  ["onb:", "onboarding"],
  ["onboarding:", "onboarding"],
  ["rematch:", "rematch"],
  ["menu:", "menu"],
];

/** Mini App page → product area. */
const SURFACE_BY_MINI_APP: Record<string, string> = {
  index: "calendar",
  "venue-change": "venue_change",
  location: "venue_intent",
  ticket: "ticket",
  tickets: "ticket_store",
  feedback: "post_date_feedback",
  onboarding: "onboarding",
  verification: "verification",
  premium: "premium",
  referral: "referral",
  radar: "type_radar",
};

/** `https://…/venue-change.html?x=1` → `venue-change`. */
export function miniAppPageFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const file = path.slice(path.lastIndexOf("/") + 1);
    const page = file.replace(/\.html$/i, "");
    return page || "index";
  } catch {
    return null;
  }
}

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---------------------------------------------------------------------------
// Payload readers
// ---------------------------------------------------------------------------

interface LooseButton {
  text?: unknown;
  callback_data?: unknown;
  web_app?: { url?: unknown };
  url?: unknown;
}

interface LooseMarkup {
  inline_keyboard?: LooseButton[][];
  keyboard?: LooseButton[][];
}

interface LoosePayload {
  chat_id?: unknown;
  text?: unknown;
  caption?: unknown;
  message_id?: unknown;
  reply_markup?: LooseMarkup;
  media?: Array<{ caption?: unknown }>;
}

/** Flatten an inline / reply keyboard into timeline actions. */
export function extractActions(markup: LooseMarkup | undefined): ChatEventAction[] {
  if (!markup) return [];
  const rows = [...(markup.inline_keyboard ?? []), ...(markup.keyboard ?? [])];
  const actions: ChatEventAction[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      const label = typeof button?.text === "string" ? button.text.trim() : "";
      if (!label) continue;
      const action: ChatEventAction = { label };
      if (typeof button.callback_data === "string") action.data = button.callback_data;
      const webAppUrl = button.web_app?.url;
      if (typeof webAppUrl === "string") {
        const page = miniAppPageFromUrl(webAppUrl);
        if (page) action.webApp = page;
      }
      actions.push(action);
    }
  }
  return actions;
}

/** Product area a single `callback_data` belongs to. */
export function surfaceFromCallbackData(data: string): string | null {
  for (const [prefix, surface] of SURFACE_BY_CALLBACK_PREFIX) {
    if (data.startsWith(prefix)) return surface;
  }
  return null;
}

/** Product area a Mini App page belongs to. */
export function surfaceFromMiniAppPage(page: string): string | null {
  return SURFACE_BY_MINI_APP[page] ?? null;
}

/** Best-effort product area from the buttons that were offered. */
export function surfaceFromActions(actions: ChatEventAction[]): string | null {
  for (const action of actions) {
    if (!action.data) continue;
    const surface = surfaceFromCallbackData(action.data);
    if (surface) return surface;
  }
  for (const action of actions) {
    const surface = action.webApp ? surfaceFromMiniAppPage(action.webApp) : null;
    if (surface) return surface;
  }
  return null;
}

/** Match id riding in a callback payload (`match:accept:<uuid>`). */
export function matchIdFromCallbackData(data: string): string | null {
  return data.match(UUID_RE)?.[0] ?? null;
}

/** Match id riding in any of the offered buttons. */
export function matchIdFromActions(actions: ChatEventAction[]): string | null {
  for (const action of actions) {
    const found = action.data ? matchIdFromCallbackData(action.data) : null;
    if (found) return found;
  }
  return null;
}

function summaryFor(kind: string, payload: LoosePayload): string {
  if (typeof payload.text === "string" && payload.text.trim()) return payload.text;
  if (typeof payload.caption === "string" && payload.caption.trim()) {
    return payload.caption;
  }
  if (Array.isArray(payload.media)) {
    const captioned = payload.media.find(
      (m) => typeof m?.caption === "string" && (m.caption as string).trim(),
    );
    if (captioned) return captioned.caption as string;
  }
  return KIND_FALLBACK_SUMMARY[kind] ?? "(message)";
}

/** Telegram chat ids can be a username string; only numeric chats are users. */
function numericChatId(chatId: unknown): bigint | null {
  if (typeof chatId === "number" && Number.isFinite(chatId)) return BigInt(chatId);
  if (typeof chatId === "bigint") return chatId;
  if (typeof chatId === "string" && /^-?\d+$/.test(chatId)) return BigInt(chatId);
  return null;
}

/** `sendMediaGroup` resolves to an array; every other send to one message. */
function messageIdFromResult(result: unknown): number | null {
  const first = Array.isArray(result) ? result[0] : result;
  const id = (first as { message_id?: unknown } | undefined)?.message_id;
  return typeof id === "number" ? id : null;
}

// ---------------------------------------------------------------------------
// Media extraction
// ---------------------------------------------------------------------------

interface LoosePhotoSize {
  file_id?: unknown;
}

interface LooseSentMessage {
  photo?: LoosePhotoSize[];
  video?: { file_id?: unknown; thumbnail?: LoosePhotoSize };
  video_note?: { file_id?: unknown; thumbnail?: LoosePhotoSize };
  animation?: { file_id?: unknown; thumbnail?: LoosePhotoSize };
  document?: { file_id?: unknown; thumbnail?: LoosePhotoSize };
  voice?: { file_id?: unknown };
}

function fileId(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Telegram sizes a photo ascending, so the last entry is the full-size one. */
function largestPhoto(sizes: LoosePhotoSize[] | undefined): string | undefined {
  if (!Array.isArray(sizes) || sizes.length === 0) return undefined;
  return fileId(sizes[sizes.length - 1]?.file_id);
}

/**
 * Read displayable attachments off one sent message.
 *
 * Deliberately sourced from the RESULT and not the request payload: the
 * product sends most of its media as raw bytes — a satori-rendered date card,
 * a bundled кружок, a generated voice note — so the outgoing payload has no
 * `file_id` to record. Telegram hands one back on every send, and that id is
 * what `GET /admin/media?type=telegram` can re-download weeks later.
 */
function mediaFromSentMessage(message: LooseSentMessage | undefined): ChatEventMedia | null {
  if (!message) return null;

  const photo = largestPhoto(message.photo);
  if (photo) return { kind: "photo", ref: photo };

  // Moving formats are represented by their poster frame — the media proxy
  // streams images, so a thumbnail is the only thing that can actually render.
  for (const [kind, node] of [
    ["video", message.video],
    ["video_note", message.video_note],
    ["animation", message.animation],
  ] as const) {
    if (!node) continue;
    const thumb = fileId(node.thumbnail?.file_id);
    return thumb ? { kind, ref: thumb } : { kind };
  }

  if (message.document) {
    const thumb = fileId(message.document.thumbnail?.file_id);
    return thumb ? { kind: "document", ref: thumb } : { kind: "document" };
  }
  // A voice note has no visual at all; the row still records that one was sent.
  if (message.voice) return { kind: "voice" };

  return null;
}

/** Every attachment across a send — an album resolves to several messages. */
export function mediaFromResult(result: unknown): ChatEventMedia[] {
  const messages = Array.isArray(result) ? result : [result];
  const out: ChatEventMedia[] = [];
  for (const message of messages) {
    const item = mediaFromSentMessage(message as LooseSentMessage | undefined);
    if (item) out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transformer
// ---------------------------------------------------------------------------

/**
 * Record a durable outbound message explicitly, for the flows the transformer
 * alone cannot read correctly: a stream that sends one message and then EDITS
 * it through several chunks would otherwise be filed under its first
 * "analysing…" beat instead of the text the user is left looking at. Those
 * call sites mark their transient sends ephemeral and call this once with the
 * final text. Fire-and-forget.
 */
export function recordOutboundMessage(
  chatId: number,
  text: string,
  options: {
    kind?: string;
    replyMarkup?: unknown;
    telegramMessageId?: number | null;
  } = {},
): void {
  const actions = extractActions(options.replyMarkup as LooseMarkup | undefined);
  void recordChatEventForChat(chatId, {
    direction: "out",
    kind: options.kind ?? "text",
    summary: text,
    surface: surfaceFromActions(actions),
    actions,
    telegramMessageId: options.telegramMessageId ?? null,
    matchId: matchIdFromActions(actions),
  });
}

/**
 * grammY API transformer that appends one timeline row per durable outbound
 * message. Recording happens AFTER the call resolves (the message id only
 * exists then) and is never awaited, so it adds nothing to send latency and a
 * timeline failure can never fail a send.
 */
export const outboundRecorder: Transformer = async (prev, method, payload, signal) => {
  const result = await prev(method, payload, signal);

  try {
    const loose = payload as unknown as LoosePayload;
    const chatId = numericChatId(loose.chat_id);
    if (!chatId || !result.ok) return result;

    // A deleted message was almost certainly an ephemeral status beat we did
    // not tag — drop the row it created so the timeline self-heals.
    if (method === "deleteMessage") {
      const messageId = loose.message_id;
      if (typeof messageId === "number") {
        void resolveChatTarget(chatId).then((target) => {
          if (target.userId) void forgetChatEventForMessage(target.userId, messageId);
        });
      }
      return result;
    }

    const kind = RECORDED_METHODS[method];
    if (!kind || isEphemeral()) return result;

    const actions = extractActions(loose.reply_markup);
    void recordChatEventForChat(chatId, {
      direction: "out",
      kind,
      summary: redactedSummary() ?? summaryFor(kind, loose),
      surface: surfaceFromActions(actions),
      actions,
      media: mediaFromResult(result.result),
      telegramMessageId: messageIdFromResult(result.result),
      matchId: matchIdFromActions(actions),
    });
  } catch (err) {
    // The timeline is observability, never a send-path dependency.
    console.warn("[outbound-recorder] skipped an event:", err);
  }

  return result;
};
