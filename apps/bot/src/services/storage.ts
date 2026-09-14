import { randomBytes } from "node:crypto";
import type { Api, RawApi } from "grammy";
import { env } from "../config.js";

/**
 * Minimal Supabase Storage client — we upload selfies via the REST API
 * instead of pulling in `@supabase/supabase-js`. AGENTS.md: no new deps
 * without approval.
 *
 * The bucket is expected to be PRIVATE; reads go through signed URLs via
 * `createSignedUrl` so we never leak raw object keys.
 */

/**
 * Hard timeout for every Supabase Storage REST call. Node's global `fetch`
 * has no default timeout, so a stalled upstream would hang the request
 * handler / cron tick forever (audit M1). 20s comfortably covers an 8MB
 * photo upload while still failing fast on a dead connection.
 */
const STORAGE_TIMEOUT_MS = 20_000;

interface UploadResult {
  path: string;
}

/**
 * Image MIME types we accept for stored media. Because every member is plain
 * ASCII, this set is also our guarantee that whatever `normalizeImageMime`
 * returns is a valid HTTP header value (a Latin-1 ByteString).
 */
const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
]);

/**
 * Is this a storage object key we are willing to put into a Supabase URL?
 *
 * Every key this module mints has the same shape — `{userId}/{timestamp}.{ext}`
 * — so the predicate is a whitelist rather than a blacklist: slash-separated
 * segments of `[A-Za-z0-9._-]`, no empty segment, and no `.`/`..` segment.
 *
 * It exists because the object key is interpolated into the request URL, and
 * `fetch` parses that URL with the WHATWG algorithm, which COLLAPSES dot
 * segments before the request goes out. So `a/../b` addresses `b`: any caller
 * that decided "this key is yours" by testing a prefix has been walked past.
 * The admin image proxy already refuses `..` on exactly this reasoning
 * (`admin/server.ts` → `SUPABASE_PATH_RE`); this is that rule, applied once at
 * the place the URL is actually built, so no future caller can miss it.
 *
 * Callers get the module's usual failure shape (`null`/`false`) rather than a
 * throw — a refused key is indistinguishable from a missing object, which is
 * the right answer to give someone probing for one.
 */
export function isSafeStorageObjectPath(path: string): boolean {
  if (!path || path.length > 512) return false;
  const segments = path.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/.test(segment),
  );
}

/**
 * When an object keyed `{owner}/{Date.now()}.{ext}` was written — the shape
 * `uploadSelfie`, `uploadProfilePhoto`, `uploadChatImage` and
 * `uploadVoicePrompt` all mint. `null` for any other shape (a Telegram
 * `file_id`, a legacy or role-prefixed key).
 *
 * Read by the two places that must know which of two stored selfies is the
 * newer one without a column that says so: the retention scrub (A13-M12) and
 * the verification persist, which must never put an older reference back over
 * a newer one whose predecessor it has already deleted.
 */
export function storageKeyWrittenAt(path: string): Date | null {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const match = /^(\d{13})\.[A-Za-z0-9]+$/.exec(file);
  if (!match) return null;
  const writtenAt = new Date(Number(match[1]));
  return Number.isNaN(writtenAt.getTime()) ? null : writtenAt;
}

/**
 * Normalize a caller/upstream-supplied MIME into a known, ASCII-safe image
 * content-type. Strips parameters (`image/jpeg; charset=binary` → `image/jpeg`),
 * lower-cases, maps the `image/jpg` alias to `image/jpeg`, and falls back to
 * `image/jpeg` for anything unrecognized.
 *
 * Critically, this stops a non-Latin1 upstream value from reaching an outgoing
 * HTTP header. Persona's signed-S3 selfie download has been observed returning
 * a `content-type` carrying a non-ASCII char (`→`, U+2192); reusing it verbatim
 * as the Supabase upload `Content-Type` made undici throw `Cannot convert
 * argument to a ByteString`, so the selfie never persisted — verification still
 * completed but `verifiedSelfiePath` was left null with no stored reference.
 */
export function normalizeImageMime(raw: string | null | undefined): string {
  if (!raw) return "image/jpeg";
  const base = raw.split(";", 1)[0]!.trim().toLowerCase();
  if (base === "image/jpg") return "image/jpeg";
  return ALLOWED_IMAGE_MIME.has(base) ? base : "image/jpeg";
}

/**
 * Upload a selfie buffer to Supabase Storage. Returns the storage path
 * (`{userId}/{timestamp}.{ext}`). Throws when Supabase is not configured
 * or the upload fails — caller decides how to translate that into HTTP.
 */
export async function uploadSelfie(
  userId: string,
  buffer: Buffer,
  mime: string,
): Promise<UploadResult> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase Storage not configured");
  }

  const safeMime = normalizeImageMime(mime);
  const ext = safeMime === "image/png" ? "png" : "jpg";
  const path = `${userId}/${Date.now()}.${ext}`;

  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_SELFIE_BUCKET}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": safeMime,
      "x-upsert": "true",
    },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase upload failed: ${res.status} ${body}`);
  }

  return { path };
}

/**
 * Download a verified selfie from Supabase Storage to a Buffer. Mirror of
 * `downloadProfilePhoto` against the `selfies` bucket — used by the
 * face-match gate when checking new profile photos against the user's
 * Persona-verified selfie. Returns `null` on any failure (storage not
 * configured, object missing, transient error).
 */
export async function downloadSelfie(path: string): Promise<Buffer | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!isSafeStorageObjectPath(path)) return null;

  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_SELFIE_BUCKET}/${path}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch {
    return null;
  }
}

/**
 * Mint a short-lived signed URL for a private selfie. Used by the admin
 * moderation panel; never returned to the mobile client.
 */
export async function createSelfieSignedUrl(
  path: string,
  expiresInSeconds: number = 300,
): Promise<string | null> {
  return createSignedUrl(env.SUPABASE_SELFIE_BUCKET, path, expiresInSeconds);
}

/**
 * Upload a profile photo buffer to Supabase Storage. Path format
 * matches `uploadSelfie`: `{userId}/{timestamp}.{ext}`. Separate bucket
 * from selfies so access policies can differ (profile photos are shown
 * to matched users; selfies are admin-only).
 */
export async function uploadProfilePhoto(
  userId: string,
  buffer: Buffer,
  mime: string,
): Promise<UploadResult> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase Storage not configured");
  }

  const safeMime = normalizeImageMime(mime);
  const ext = safeMime === "image/png" ? "png" : "jpg";
  const path = `${userId}/${Date.now()}.${ext}`;

  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_PHOTO_BUCKET}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": safeMime,
      "x-upsert": "true",
    },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase upload failed: ${res.status} ${body}`);
  }

  return { path };
}

/**
 * Download a profile photo from Supabase Storage to a Buffer.
 *
 * Used by the verification pipeline to feed bytes into Rekognition without
 * the round-trip through a signed URL — service-role auth lets us pull
 * from a private bucket directly. Returns `null` on any failure (storage
 * not configured, object missing, transient error); the verification
 * pipeline treats a null as `photo_download_failed`, a retryable outcome —
 * never a rejection, and never `pending_review` — for our own outage.
 */
export async function downloadProfilePhoto(path: string): Promise<Buffer | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!isSafeStorageObjectPath(path)) return null;

  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_PHOTO_BUCKET}/${path}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch {
    return null;
  }
}

/**
 * Download a profile-photo image regardless of where it's stored. The
 * format of `pathOrFileId` discriminates the source:
 *   - contains "/"  → Supabase Storage object path (`{userId}/{ts}.jpg`)
 *   - no "/"        → Telegram `file_id`, fetched via Bot API
 *
 * The discriminator is unambiguous: Supabase paths are always
 * `{userId}/{timestamp}.{ext}` and Telegram file_ids are base64-ish
 * tokens with no slashes.
 *
 * Returns `null` on any failure (storage misconfigured, object missing,
 * Telegram getFile error, network blip). The verification pipeline treats
 * null as `photo_download_failed` → the retryable `pending` state.
 *
 * `api` is required even when the path turns out to be Supabase, so
 * callers don't have to branch on the format themselves.
 */
export async function downloadProfileImage(
  pathOrFileId: string,
  api: Api<RawApi>,
): Promise<Buffer | null> {
  if (!pathOrFileId) return null;
  if (pathOrFileId.includes("/")) {
    return downloadProfilePhoto(pathOrFileId);
  }
  return downloadTelegramFile(api, pathOrFileId);
}

/**
 * Download a Telegram-hosted file by `file_id`. Two-step: `getFile` to
 * resolve the temporary `file_path`, then a plain HTTPS GET against the
 * Bot API file endpoint. Single source of truth for Telegram file
 * downloads — `face-match-gate.ts` and the diagnostic scripts both
 * delegate here.
 */
export async function downloadTelegramFile(
  api: Api<RawApi>,
  fileId: string,
): Promise<Buffer | null> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) return null;
    const url = `https://api.telegram.org/file/bot${api.token}/${file.file_path}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.warn("[storage] downloadTelegramFile failed", { fileId, err });
    return null;
  }
}

/**
 * Mint a short-lived signed URL for a private profile photo. Returned to
 * the mobile client so it can render the image without exposing the raw
 * object key.
 */
export async function createProfilePhotoSignedUrl(
  path: string,
  expiresInSeconds: number = 600,
): Promise<string | null> {
  return createSignedUrl(env.SUPABASE_PHOTO_BUCKET, path, expiresInSeconds);
}

/**
 * A 50 MB video over a 20 s budget needs 2.5 MB/s sustained, which a slow
 * Supabase region round-trip does not always give. Photos keep the short one.
 */
const PROFILE_VIDEO_STORAGE_TIMEOUT_MS = 120_000;

export type ProfileVideoAssetRole = "video" | "thumb";

/**
 * Upload a native profile video or its poster (`POST /v1/me/video`).
 *
 * Same bucket and `{userId}/…` prefix as profile photos, for two reasons: the
 * partner-visibility rules are the same, and account deletion already sweeps
 * every `{userId}/…` string out of `profileMedia` from that bucket. A fresh name
 * per upload, so a phone holding the previous signed URL never plays a
 * half-replaced file.
 */
export async function uploadProfileVideoAsset(
  userId: string,
  role: ProfileVideoAssetRole,
  buffer: Buffer,
  mime: string,
): Promise<UploadResult> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase Storage not configured");
  }
  const contentType = role === "video" ? "video/mp4" : normalizeImageMime(mime);
  const ext = role === "video" ? "mp4" : contentType === "image/png" ? "png" : "jpg";
  const path = `${userId}/${role === "video" ? "video" : "video-thumb"}-${Date.now()}.${ext}`;
  if (!isSafeStorageObjectPath(path)) throw new Error("Unsafe profile video path");

  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_PHOTO_BUCKET}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(PROFILE_VIDEO_STORAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase upload failed: ${res.status} ${body}`);
  }
  return { path };
}

/**
 * Best-effort removal of a replaced or removed profile video's stored objects.
 *
 * Refs without a slash are Telegram `file_id`s (same discriminator as
 * `downloadProfileImage`) — Telegram owns those, nothing to delete here. A
 * failed delete leaves an orphan in the bucket rather than failing the edit:
 * the profile row is the source of truth, as with photo deletes.
 */
export async function deleteProfileVideoObjects(
  refs: readonly (string | undefined)[],
): Promise<void> {
  const stored = refs.filter((ref): ref is string => typeof ref === "string" && ref.includes("/"));
  await Promise.all(
    stored.map((ref) =>
      deleteStorageObject(env.SUPABASE_PHOTO_BUCKET, ref).catch((err) => {
        console.warn("[storage] profile video object delete failed", { ref, err });
        return false;
      }),
    ),
  );
}

/**
 * Download a native profile video's bytes — the Telegram pitch sends them as a
 * file body, because such a video has no Telegram `file_id`. `null` on any
 * failure; the caller drops the video from that send rather than the album.
 */
export async function downloadProfileVideo(path: string): Promise<Buffer | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!isSafeStorageObjectPath(path)) return null;
  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_PHOTO_BUCKET}/${path}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      signal: AbortSignal.timeout(PROFILE_VIDEO_STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Upload a chat attachment (mobile chat agent multimodal input) to Supabase
 * Storage. Path format `{userId}/{timestamp}.{ext}` mirrors the photo/selfie
 * helpers so the same ownership-by-prefix check works across all buckets.
 */
export async function uploadChatImage(
  userId: string,
  buffer: Buffer,
  mime: string,
): Promise<UploadResult> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase Storage not configured");
  }

  const safeMime = normalizeImageMime(mime);
  const ext =
    safeMime === "image/png" ? "png" : safeMime === "image/webp" ? "webp" : "jpg";
  const path = `${userId}/${Date.now()}.${ext}`;

  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_CHAT_BUCKET}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": safeMime,
      "x-upsert": "true",
    },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase upload failed: ${res.status} ${body}`);
  }

  return { path };
}

/**
 * Mint a short-lived signed URL for a chat attachment. The default TTL is
 * 5 minutes — long enough for the OpenAI vision call to fetch it, short
 * enough that we don't have to worry about leaked URLs.
 */
export async function createChatImageSignedUrl(
  path: string,
  expiresInSeconds: number = 300,
): Promise<string | null> {
  return createSignedUrl(env.SUPABASE_CHAT_BUCKET, path, expiresInSeconds);
}

/**
 * Upload a native-client voice prompt.
 *
 * Only the native rail ever reaches this: a Telegram-recorded prompt is a
 * `file_id` and Telegram is its store, so nothing is written here for it. The
 * path is `${userId}/…` on purpose — `collectOwnedPaths` in account-deletion.ts
 * filters on exactly that prefix, so a key outside it would survive an erasure
 * request silently.
 */
export async function uploadVoicePrompt(
  userId: string,
  buffer: Buffer,
  mime: string,
): Promise<UploadResult> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase Storage not configured");
  }

  const safeMime = mime === "audio/mp4" || mime === "audio/m4a" ? "audio/mp4" : "audio/ogg";
  const ext = safeMime === "audio/mp4" ? "m4a" : "ogg";
  const path = `${userId}/${Date.now()}.${ext}`;

  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_VOICE_BUCKET}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": safeMime,
      "x-upsert": "true",
    },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase upload failed: ${res.status} ${body}`);
  }
  return { path };
}

/** Short-lived signed URL for playing a voice prompt in the native client. */
export async function createVoicePromptSignedUrl(
  path: string,
  expiresInSeconds: number = 300,
): Promise<string | null> {
  return createSignedUrl(env.SUPABASE_VOICE_BUCKET, path, expiresInSeconds);
}

/** The container a native voice upload is stored under, by the MIME it declared. */
function voicePromptExtension(mime: string): "m4a" | "ogg" {
  return mime === "audio/ogg" || mime === "audio/opus" ? "ogg" : "m4a";
}

/**
 * Mint a one-shot signed PUT for a native voice prompt (voice-prompts.md §4.2).
 *
 * The bytes go phone → Supabase and never through the single Node process
 * that also runs the bot, every cron and both APIs. The commit then names the
 * returned `path`, and the server downloads it once for moderation — so the
 * object is untrusted until that commit, which is also why the key is minted
 * HERE rather than chosen by the client: the `${userId}/` prefix is what
 * `collectOwnedPaths` erases on account deletion and what the commit checks
 * ownership against.
 *
 * Null when storage is not configured or Supabase refuses; the caller then
 * advertises `uploadUrl: null` and the client falls back to the base64 body,
 * which is exactly the contract that existed before this.
 */
export async function createVoicePromptSignedUpload(
  userId: string,
  mime: string,
): Promise<{ uploadUrl: string; path: string } | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;

  const suffix = randomBytes(6).toString("hex");
  const path = `${userId}/${Date.now()}-${suffix}.${voicePromptExtension(mime)}`;
  if (!isSafeStorageObjectPath(path)) return null;

  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/upload/sign/${env.SUPABASE_VOICE_BUCKET}/${path}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { url?: string };
    if (!json.url) return null;
    const uploadUrl = json.url.startsWith("http")
      ? json.url
      : `${env.SUPABASE_URL}/storage/v1${json.url}`;
    return { uploadUrl, path };
  } catch {
    return null;
  }
}

/** A native upload is the caller's only if the server minted it under their prefix. */
export function isOwnVoicePromptUploadPath(path: string, userId: string): boolean {
  return isSafeStorageObjectPath(path) && path.startsWith(`${userId}/`) && path.split("/").length === 2;
}

export type VoicePromptUploadDownload =
  | { ok: true; audio: Buffer }
  | { ok: false; reason: "missing" | "too_large" };

/**
 * Read back an object the client PUT through a signed upload, refusing to
 * buffer anything over `maxBytes`.
 *
 * A signed upload carries no size limit of its own, so the declared
 * `Content-Length` is checked before the body is read — the commit must never
 * be the step that loads an arbitrary blob into this process's memory.
 */
export async function downloadVoicePromptUpload(
  path: string,
  maxBytes: number,
): Promise<VoicePromptUploadDownload> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { ok: false, reason: "missing" };
  if (!isSafeStorageObjectPath(path)) return { ok: false, reason: "missing" };
  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_VOICE_BUCKET}/${path}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: "missing" };
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.byteLength > maxBytes) return { ok: false, reason: "too_large" };
    if (audio.byteLength === 0) return { ok: false, reason: "missing" };
    return { ok: true, audio };
  } catch {
    return { ok: false, reason: "missing" };
  }
}

export type AnnouncementAssetRole = "media" | "poster";

const ANNOUNCEMENT_MIME_EXT: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
};

/**
 * Upload an announcement's image, video or poster (admin only).
 *
 * The key is `{announcementId}/{role}-{timestamp}.{ext}`: no user id, because
 * nobody owns it but the product, and a re-upload gets a fresh name so a phone
 * holding yesterday's signed URL never plays a half-replaced file. `mime` must
 * already be sniffed by the caller — this function only refuses what it cannot
 * name.
 */
export async function uploadAnnouncementAsset(
  announcementId: string,
  role: AnnouncementAssetRole,
  buffer: Buffer,
  mime: string,
): Promise<UploadResult> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase Storage not configured");
  }
  const ext = ANNOUNCEMENT_MIME_EXT[mime];
  if (!ext) throw new Error(`Unsupported announcement media type: ${mime}`);
  const path = `${announcementId}/${role}-${Date.now()}.${ext}`;
  if (!isSafeStorageObjectPath(path)) throw new Error("Unsafe announcement media path");

  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_ANNOUNCEMENT_BUCKET}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": mime,
      "x-upsert": "true",
    },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase upload failed: ${res.status} ${body}`);
  }
  return { path };
}

/** Signed URL for an announcement asset, handed to the app and to APNs. */
export async function createAnnouncementAssetSignedUrl(
  path: string,
  expiresInSeconds: number,
): Promise<string | null> {
  return createSignedUrl(env.SUPABASE_ANNOUNCEMENT_BUCKET, path, expiresInSeconds);
}

/** Download a stored voice prompt (validation, or minting a Telegram file_id). */
export async function downloadVoicePrompt(path: string): Promise<Buffer | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!isSafeStorageObjectPath(path)) return null;
  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_VOICE_BUCKET}/${path}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Download a private chat attachment for server-side validation/copying. */
export async function downloadChatImage(path: string): Promise<Buffer | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!isSafeStorageObjectPath(path)) return null;

  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_CHAT_BUCKET}/${path}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Delete an object from a Supabase Storage bucket. Returns `true` on
 * successful delete or when the object is already absent, `false` otherwise
 * (including "not configured" and transient errors). Ordinary media edits may
 * proceed best-effort; account deletion treats `false` as a retryable blocker.
 *
 * The HTTP status alone cannot decide this. Supabase does NOT answer a missing
 * object with an HTTP 404 — it returns **HTTP 400** carrying a body-encoded
 * `{"statusCode":"404","error":"not_found"}`. Reading only `res.status` made
 * "already absent" look like a failure, which permanently wedged account
 * deletion for anyone whose stored path no longer resolves (config drift, a
 * half-finished earlier cleanup).
 *
 * A missing *bucket* returns that identical shape, so "absent" is only treated
 * as erased once the bucket we were pointed at is confirmed to exist —
 * otherwise a typo'd bucket name would silently report every object as erased
 * while the real files live on.
 */
export async function deleteStorageObject(
  bucket: string,
  path: string,
): Promise<boolean> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return false;
  if (!isSafeStorageObjectPath(path)) return false;

  const url = `${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (res.ok) return true;
    if (!(await isAbsentObjectResponse(res))) return false;

    // Ambiguous branch only: the object is gone, or the bucket never existed.
    if (!(await storageBucketExists(bucket))) {
      console.error("[storage] delete target bucket is unreachable", { bucket, path });
      return false;
    }
    console.warn("[storage] object already absent, treating as erased", { bucket, path });
    return true;
  } catch {
    return false;
  }
}

/** Page size for `listStorageObjects` — Supabase's own default for `list`. */
const STORAGE_LIST_PAGE_SIZE = 100;
/**
 * Upper bound on pages one listing may walk (100 000 objects). Reaching it
 * answers `null` rather than a truncated list: the caller is account deletion,
 * and a partial list it treated as complete would leave objects behind while
 * reporting the account erased.
 */
const STORAGE_LIST_MAX_PAGES = 1_000;
/** Folder nesting a listing follows. Every key this module mints is one level. */
const STORAGE_LIST_MAX_DEPTH = 4;

/**
 * Every object key under `prefix/` in `bucket`, as full keys
 * (`{prefix}/{name}`), or `null` when the listing could not be completed —
 * storage not configured, a refused prefix, a non-OK answer (including a
 * missing bucket), a malformed body, or the page cap.
 *
 * Exists for account deletion (A13-M12). Erasing only the paths a row still
 * points at missed everything no row points at any more: a replaced liveness
 * selfie, a re-recorded voice prompt, a chat image uploaded and never sent. The
 * bucket itself is the only complete record of what we hold for someone, so the
 * erasure asks the bucket.
 *
 * Same REST transport and service-role auth as `deleteStorageObject`
 * (`POST /storage/v1/object/list/{bucket}`). Supabase answers names relative to
 * the prefix and reports a sub-folder as an entry with `id: null`; those are
 * walked too, so a future nested key under the user's prefix cannot hide.
 */
export async function listStorageObjects(
  bucket: string,
  prefix: string,
): Promise<string[] | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!isSafeStorageObjectPath(prefix)) return null;

  const keys: string[] = [];
  const folders: Array<{ path: string; depth: number }> = [{ path: prefix, depth: 0 }];
  let pages = 0;

  for (let folder = folders.shift(); folder; folder = folders.shift()) {
    for (let offset = 0; ; offset += STORAGE_LIST_PAGE_SIZE) {
      pages += 1;
      if (pages > STORAGE_LIST_MAX_PAGES) {
        console.error("[storage] listing exceeded the page cap", { bucket, prefix });
        return null;
      }
      const entries = await fetchStorageListPage(bucket, folder.path, offset);
      if (!entries) return null;
      for (const entry of entries) {
        const key = `${folder.path}/${entry.name}`;
        if (entry.isFolder) {
          if (folder.depth + 1 > STORAGE_LIST_MAX_DEPTH) {
            console.error("[storage] listing exceeded the folder depth cap", { bucket, key });
            return null;
          }
          folders.push({ path: key, depth: folder.depth + 1 });
        } else {
          keys.push(key);
        }
      }
      if (entries.length < STORAGE_LIST_PAGE_SIZE) break;
    }
  }
  return keys;
}

/** One page of a folder listing; `null` on any failure. */
async function fetchStorageListPage(
  bucket: string,
  folder: string,
  offset: number,
): Promise<Array<{ name: string; isFolder: boolean }> | null> {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prefix: folder,
        limit: STORAGE_LIST_PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      }),
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return null;
    const entries: Array<{ name: string; isFolder: boolean }> = [];
    for (const item of body) {
      if (typeof item !== "object" || item === null || !("name" in item)) return null;
      const name = item.name;
      const id = "id" in item ? item.id : undefined;
      // A name we would refuse to address is not skipped: skipping it would
      // report an object as erased that nothing ever deleted.
      if (typeof name !== "string" || !isSafeStorageObjectPath(name)) return null;
      entries.push({ name, isFolder: id === null });
    }
    return entries;
  } catch {
    return null;
  }
}

/** Minimal shape of the error responses this module inspects. */
interface InspectableResponse {
  status: number;
  json: () => Promise<unknown>;
}

/**
 * Does this failed response mean "the object isn't there"? Accepts both a real
 * HTTP 404 and Supabase's body-encoded one. Anything else — notably a 403
 * `Invalid Compact JWS` from a bad service-role key — must stay a failure so
 * account deletion keeps failing closed on credential/permission problems.
 */
async function isAbsentObjectResponse(res: InspectableResponse): Promise<boolean> {
  if (res.status === 404) return true;
  if (res.status !== 400) return false;
  try {
    const body = (await res.json()) as { statusCode?: unknown } | null;
    return String(body?.statusCode) === "404";
  } catch {
    return false;
  }
}

/**
 * Confirm a bucket actually exists. Unlike the object endpoint, this one does
 * distinguish the two "404"s (`error: "Bucket not found"`), which is what lets
 * the caller above tell an erased object from a misconfigured destination.
 * Unreachable counts as "no" — fail closed.
 */
async function storageBucketExists(bucket: string): Promise<boolean> {
  return (await storageBucketState(bucket)) === "present";
}

/**
 * Whether a bucket exists, as a three-way answer: `missing` only when Supabase
 * says so outright (`Bucket not found`); an outage, a refusal or unconfigured
 * storage is `unreachable`, never `missing`.
 *
 * Account deletion needs the distinction (A13-M12). It lists every bucket, and a
 * bucket that was never created — the voice bucket on an install where voice
 * prompts were never switched on — has nothing in it to erase; treating that as
 * a failure would make every account on that install undeletable. An unreachable
 * bucket, on the other hand, might hold the very selfie the request is about.
 */
export async function storageBucketState(
  bucket: string,
): Promise<"present" | "missing" | "unreachable"> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return "unreachable";

  try {
    const res = await fetch(`${env.SUPABASE_URL}/storage/v1/bucket/${bucket}`, {
      headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (res.ok) return "present";
    if (res.status !== 400 && res.status !== 404) return "unreachable";
    const body = (await res.json().catch(() => null)) as
      | { statusCode?: unknown; error?: unknown }
      | null;
    return body?.error === "Bucket not found" || String(body?.statusCode) === "404"
      ? "missing"
      : "unreachable";
  } catch {
    return "unreachable";
  }
}

async function createSignedUrl(
  bucket: string,
  path: string,
  expiresInSeconds: number,
): Promise<string | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!isSafeStorageObjectPath(path)) return null;

  const url = `${env.SUPABASE_URL}/storage/v1/object/sign/${bucket}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const signed = json.signedUrl ?? json.signedURL;
  if (!signed) return null;
  return signed.startsWith("http") ? signed : `${env.SUPABASE_URL}/storage/v1${signed}`;
}
