import { env } from "../config.js";

/**
 * Minimal Supabase Storage client — we upload selfies via the REST API
 * instead of pulling in `@supabase/supabase-js`. AGENTS.md: no new deps
 * without approval.
 *
 * The bucket is expected to be PRIVATE; reads go through signed URLs via
 * `createSignedUrl` so we never leak raw object keys.
 */

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
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase upload failed: ${res.status} ${body}`);
  }

  return { path };
}

/**
 * Mint a short-lived signed URL for a private selfie. Used by the admin
 * moderation panel; never returned to the mobile client.
 */
export async function createSelfieSignedUrl(
  path: string,
  expiresInSeconds: number = 300,
): Promise<string | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;

  const url = `${env.SUPABASE_URL}/storage/v1/object/sign/${env.SUPABASE_SELFIE_BUCKET}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const signed = json.signedUrl ?? json.signedURL;
  if (!signed) return null;
  return signed.startsWith("http") ? signed : `${env.SUPABASE_URL}/storage/v1${signed}`;
}
