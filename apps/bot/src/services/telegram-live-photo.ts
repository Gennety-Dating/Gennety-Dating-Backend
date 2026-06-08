import type { Api, RawApi } from "grammy";
import type { MessageEntity } from "grammy/types";

export interface SendLivePhotoOptions {
  caption?: string;
  caption_entities?: MessageEntity[];
  show_caption_above_media?: boolean;
  has_spoiler?: boolean;
  disable_notification?: boolean;
  protect_content?: boolean;
  message_effect_id?: string;
  reply_markup?: unknown;
}

type ApiWithSendLivePhoto = Api<RawApi> & {
  sendLivePhoto?: (
    chatId: number,
    livePhoto: string,
    photo: string,
    options?: SendLivePhotoOptions,
  ) => Promise<unknown>;
};

export async function sendLivePhoto(
  api: Api<RawApi>,
  chatId: number,
  livePhoto: string,
  photo: string,
  options: SendLivePhotoOptions = {},
): Promise<unknown> {
  const apiWithMethod = api as ApiWithSendLivePhoto;
  if (typeof apiWithMethod.sendLivePhoto === "function") {
    return apiWithMethod.sendLivePhoto(chatId, livePhoto, photo, options);
  }

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    live_photo: livePhoto,
    photo,
    ...options,
  };
  const res = await fetch(`https://api.telegram.org/bot${api.token}/sendLivePhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    // Node `fetch` has no default timeout — bound the raw Bot API call (M1).
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: unknown;
    description?: string;
  } | null;

  if (!res.ok || !json?.ok) {
    throw new Error(json?.description ?? `sendLivePhoto failed with HTTP ${res.status}`);
  }

  return json.result;
}
