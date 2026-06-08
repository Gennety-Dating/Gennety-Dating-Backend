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

  const ext = mime.includes("png") ? "png" : "jpg";
  const path = `${userId}/${Date.now()}.${ext}`;

  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_SELFIE_BUCKET}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": mime || "application/octet-stream",
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

  const ext = mime.includes("png") ? "png" : "jpg";
  const path = `${userId}/${Date.now()}.${ext}`;

  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_PHOTO_BUCKET}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": mime || "application/octet-stream",
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
 * not configured, object missing, transient error); the caller treats a
 * null as "comparison_error" for that photo, which routes the user to
 * `pending_review` rather than rejecting them for our outage.
 */
export async function downloadProfilePhoto(path: string): Promise<Buffer | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;

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
 * Telegram getFile error, network blip). Caller treats null the same way
 * as the Supabase-only `downloadProfilePhoto` did — as
 * `comparison_error` → user lands in `pending_review`.
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
 * Upload a chat attachment (Aether Concierge multimodal input) to Supabase
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

  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  const path = `${userId}/${Date.now()}.${ext}`;

  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_CHAT_BUCKET}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": mime || "application/octet-stream",
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
 * Delete an object from a Supabase Storage bucket. Returns `true` on
 * successful delete, `false` otherwise (including "not configured" and
 * transient errors). Callers are expected to log + proceed: a dangling
 * storage object is far less bad than a failed DB mutation.
 */
export async function deleteStorageObject(
  bucket: string,
  path: string,
): Promise<boolean> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return false;

  const url = `${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function createSignedUrl(
  bucket: string,
  path: string,
  expiresInSeconds: number,
): Promise<string | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;

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
