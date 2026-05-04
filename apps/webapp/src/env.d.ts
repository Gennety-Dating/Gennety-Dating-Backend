/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the bot's public API. Production: `https://dating-api.gennety.com`.
   * Local dev: a `cloudflared` tunnel that exposes :3101 over HTTPS.
   * Falls back to "" (same-origin) if unset, which only makes sense if you're
   * proxying both Mini App and API behind the same hostname.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
