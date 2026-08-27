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
        tickets: resolve(__dirname, "tickets.html"),
        "venue-change": resolve(__dirname, "venue-change.html"),
        premium: resolve(__dirname, "premium.html"),
        radar: resolve(__dirname, "radar.html"),
        referral: resolve(__dirname, "referral.html"),
        canvas: resolve(__dirname, "canvas.html"),
      },
    },
  },
  test: {
    /// Vitest stubs every CSS import to an empty string by default, which also
    /// swallows an explicit `?raw` one. These stylesheets are asserted on as
    /// text, so they have to come through for real:
    ///   - `liveness-theme.css` — that it never restyles the biometric capture
    ///     surface (oval, light challenge, recording indicator).
    ///   - `butterfly-loader.css` — that the shared loading mark's keyframes
    ///     exist and that verification.html's inlined pre-paint copy of them
    ///     hasn't drifted from this one.
    ///   - `butterfly-success.css` — that the shared success mark's flight and
    ///     stroke-draw keep the SAME keyframe stops. They are two animations on
    ///     two elements selling one illusion, so a drift between them is not a
    ///     styling nit but a butterfly flying beside its own stroke.
    ///   - `onboarding.css` — that every surface which makes room for the soft
    ///     keyboard follows the one shared curve, and that the curve cannot
    ///     regress to something that puts a third of the travel in one frame.
    ///     The shipped stylesheet is the only honest source for that: a TS
    ///     mirror of the numbers would be the thing that drifts.
    ///   - `premium.css` — that the plan picker's SELECTED cell is always more
    ///     present than its neighbours in BOTH themes. Reusing the shared glass
    ///     tokens inverted that on cream (a white-gradient fill on a white page
    ///     made the chosen plan read as the background), and the polarity is
    ///     invisible to every other kind of test.
    ///   - `location.css` — that the departure-point gate's copy and its
    ///     demo-only action stay ONE flex column. Putting the button back
    ///     beside the sentence is a one-line edit that looks harmless and
    ///     shreds the sentence into a word-per-line strip.
    /// Scoped rather than `css: true` so no other test starts paying for CSS
    /// processing.
    css: {
      include: [
        /liveness-theme\.css/,
        /butterfly-loader\.css/,
        /butterfly-success\.css/,
        /onboarding\.css/,
        /canvas\.css/,
        /premium\.css/,
        /location\.css/,
      ],
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
