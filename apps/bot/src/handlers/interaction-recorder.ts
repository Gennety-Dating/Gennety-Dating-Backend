import { Composer } from "grammy";
import type { BotContext } from "../session.js";
import {
  recordChatEventForChat,
  type ChatEventMedia,
} from "../services/chat-events.js";
import {
  matchIdFromCallbackData,
  surfaceFromCallbackData,
} from "../services/outbound-recorder.js";

/**
 * Inbound half of the chat timeline (PRODUCT_SPEC §2.1).
 *
 * Records what the user actually DID before any handler consumes it, so the
 * agent can resolve "why?" / "and then?" against the real preceding step. The
 * important part is the button label: a tap is stored as the text the user
 * saw and pressed ("📍 Change venue"), not as `vchg:open:…`, because the label
 * is what they would name if you asked them.
 *
 * Voice notes are deliberately skipped here — `handlers/voice.ts` records them
 * after Whisper, so the timeline carries the transcript rather than a useless
 * "(voice note)" placeholder.
 */
export const interactionRecorder = new Composer<BotContext>();

/** Find a tapped button's own visible label in the message it was attached to. */
export function labelForCallbackData(
  markup: { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> } | undefined,
  data: string,
): string | null {
  for (const row of markup?.inline_keyboard ?? []) {
    for (const button of row) {
      if (button?.callback_data === data && typeof button.text === "string") {
        return button.text;
      }
    }
  }
  return null;
}

interactionRecorder.use(async (ctx, next) => {
  try {
    recordInteraction(ctx);
  } catch (err) {
    // Observability only — never let it interfere with handling the update.
    console.warn("[interaction-recorder] skipped an event:", err);
  }
  await next();
});

function recordInteraction(ctx: BotContext): void {
  const chatId = ctx.chat?.id;
  if (chatId === undefined || chatId <= 0) return;

  const data = ctx.callbackQuery?.data;
  if (data) {
    const message = ctx.callbackQuery?.message;
    const label = labelForCallbackData(
      (message as { reply_markup?: Parameters<typeof labelForCallbackData>[0] })
        ?.reply_markup,
      data,
    );
    void recordChatEventForChat(chatId, {
      direction: "in",
      kind: "callback_tap",
      summary: label ? `tapped "${label}"` : `tapped a button (${data})`,
      surface: surfaceFromCallbackData(data),
      matchId: matchIdFromCallbackData(data),
    });
    return;
  }

  const message = ctx.message;
  if (!message) return;
  // Telegram's own "message was pinned" service update — not a user action.
  if ("pinned_message" in message) return;
  // Transcribed and recorded by handlers/voice.ts instead.
  if ("voice" in message) return;

  if (typeof message.text === "string" && message.text.trim()) {
    void recordChatEventForChat(chatId, {
      direction: "in",
      kind: "user_text",
      summary: message.text,
    });
    return;
  }

  if ("contact" in message) {
    void recordChatEventForChat(chatId, {
      direction: "in",
      kind: "user_contact",
      summary: "shared their phone number",
      surface: "onboarding",
    });
    return;
  }

  const media = describeMedia(message);
  if (media) {
    void recordChatEventForChat(chatId, {
      direction: "in",
      kind: "user_media",
      summary: message.caption?.trim() || media.summary,
      media: [media.item],
    });
  }
}

interface InboundMedia {
  summary: string;
  item: ChatEventMedia;
}

/**
 * What the user just sent, plus the `file_id` needed to show it later.
 *
 * Recording only the sentence ("sent a photo") is what made the admin
 * transcript blind to every image a user ever sent: the moment is in the
 * timeline, the picture is nowhere. A photo stores its largest size; the
 * moving formats store their poster frame, since the admin media proxy
 * streams images.
 */
function describeMedia(message: NonNullable<BotContext["message"]>): InboundMedia | null {
  if (message.photo?.length) {
    const largest = message.photo[message.photo.length - 1];
    return {
      summary: "sent a photo",
      item: { kind: "photo", ...(largest?.file_id ? { ref: largest.file_id } : {}) },
    };
  }
  if (message.video_note) {
    const thumb = message.video_note.thumbnail?.file_id;
    return {
      summary: "sent a video note",
      item: { kind: "video_note", ...(thumb ? { ref: thumb } : {}) },
    };
  }
  if (message.video) {
    const thumb = message.video.thumbnail?.file_id;
    return { summary: "sent a video", item: { kind: "video", ...(thumb ? { ref: thumb } : {}) } };
  }
  if (message.animation) {
    const thumb = message.animation.thumbnail?.file_id;
    return {
      summary: "sent a GIF",
      item: { kind: "animation", ...(thumb ? { ref: thumb } : {}) },
    };
  }
  if (message.document) {
    const thumb = message.document.thumbnail?.file_id;
    return {
      summary: `sent a file${message.document.file_name ? ` (${message.document.file_name})` : ""}`,
      item: { kind: "document", ...(thumb ? { ref: thumb } : {}) },
    };
  }
  if (message.sticker) {
    // A sticker's own file is .webp/.tgs; only the static thumb is renderable.
    const thumb = message.sticker.thumbnail?.file_id;
    return {
      summary: `sent a sticker${message.sticker.emoji ? ` ${message.sticker.emoji}` : ""}`,
      item: { kind: "sticker", ...(thumb ? { ref: thumb } : {}) },
    };
  }
  return null;
}
