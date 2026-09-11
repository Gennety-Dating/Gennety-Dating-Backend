/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the bot's public API. Production: `https://dating-api.gennety.com`.
   * Local dev: a `cloudflared` tunnel that exposes :3101 over HTTPS.
   * Falls back to "" (same-origin) if unset, which only makes sense if you're
   * proxying both Mini App and API behind the same hostname.
   */
  readonly VITE_API_BASE_URL?: string;
  /**
   * Our Uber developer app's client id, sent as `client_id` on the transit
   * dock's Uber link — what attributes a ride to Gennety, and so what an
   * affiliate agreement hangs on. Unset, the link goes out without one rather
   * than with an empty one (`src/deep-links.ts`).
   */
  readonly VITE_UBER_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
