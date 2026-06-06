import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * Multi-entry Vite config — calendar, feedback, location, onboarding, and
 * verification Mini Apps ship from the same `dist/`, so a single Caddy site
 * (`dating-calendar.gennety.com`) serves them all. Adding a new Mini App
 * later is a one-line `input` addition.
 */
export default defineConfig({
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        feedback: resolve(__dirname, "feedback.html"),
        location: resolve(__dirname, "location.html"),
        onboarding: resolve(__dirname, "onboarding.html"),
        verification: resolve(__dirname, "verification.html"),
        ticket: resolve(__dirname, "ticket.html"),
        "venue-change": resolve(__dirname, "venue-change.html"),
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    /// Telegram Mini Apps require HTTPS — local dev forwards through a
    /// cloudflared / ngrok tunnel. Vite's host-header check blocks any
    /// host except `localhost` by default; ".trycloudflare.com" covers
    /// `cloudflared tunnel --url`. Production build is unaffected.
    allowedHosts: [".trycloudflare.com", ".ngrok-free.app", ".ngrok-free.dev", ".ngrok.io"],
    /// Proxy public-API calls to the bot process. The Mini App posts to
    /// `/v1/feedback/post-date` and `/v1/calendar/pick` via a relative
    /// path (`apiBase=""` in dev), so without this the cloudflared tunnel
    /// would route those requests to vite itself and the Mini App would
    /// see the index.html as the JSON response.
    /// Production is unaffected: the prod build sets
    /// `VITE_API_BASE_URL=https://dating-api.gennety.com`, so requests
    /// bypass this dev-only proxy entirely.
    proxy: {
      "/v1": {
        target: "http://localhost:3101",
        changeOrigin: true,
      },
    },
  },
});
