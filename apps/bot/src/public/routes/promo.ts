import { Router, type Request, type Response } from "express";
import { env } from "../../config.js";
import { normalizePromoCode, resolvePromoCode } from "../../services/promo.js";
import { fingerprint, recordAttribution } from "../../services/promo-attribution.js";

/**
 * Public promo surface (PROMO_CODES_PRODUCT_SPEC.md), mounted UNDER `/v1` (the
 * only path Caddy proxies to this process) and BEFORE the JWT routers — these
 * endpoints are pre-install / pre-auth by design.
 *
 * - `GET  /v1/promo/:code` — the ad-link landing. Stashes a coarse device
 *   fingerprint → code (for iOS deferred attribution), serves a tiny page that
 *   copies `GENNETY:<CODE>` to the clipboard (the stronger second signal), then
 *   bounces to the App Store. A Telegram user never lands here — they use the
 *   `t.me/<bot>?start=promo_<CODE>` deep link.
 * - `POST /v1/promo/attribution` — the same fingerprint record for a landing
 *   hosted off-origin (e.g. `gennety.com/promo/:code`) that records via fetch.
 *
 * Everything 404s when `PROMO_FEATURE_ENABLED` is off.
 */
export function createPromoRouter(): Router {
  const router = Router();

  function clientFingerprint(req: Request): string {
    return fingerprint({
      ip: req.ip,
      userAgent: req.header("user-agent") ?? undefined,
      acceptLanguage: req.header("accept-language") ?? undefined,
    });
  }

  router.get("/:code", async (req: Request, res: Response): Promise<void> => {
    if (!env.PROMO_FEATURE_ENABLED) {
      res.status(404).send("Not found");
      return;
    }
    const code = normalizePromoCode(String(req.params.code ?? ""));
    // Record only for a currently-redeemable code (avoids stashing typos/expired
    // codes), but always redirect so a stale link still lands in the store.
    const resolved = await resolvePromoCode(code);
    if (resolved) recordAttribution(clientFingerprint(req), resolved.code);

    // `PROMO_APP_STORE_URL` is already validated as an https: URL at config
    // load; escaping here is the second layer, so a value carrying `"` can
    // never break out of the attribute below.
    const dest = env.PROMO_APP_STORE_URL;
    const safeDest = escapeHtmlAttribute(dest);
    const safeCode = code.replace(/[^A-Z0-9_-]/g, "");
    // Minimal, self-contained landing: copy the code, then bounce to the store.
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Gennety — your gift is waiting</title>
<style>
  html,body{margin:0;height:100%;background:#030303;color:#f5f5f5;
    font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
  .card{text-align:center;padding:2rem;max-width:22rem}
  .badge{font-size:2.5rem}
  h1{font-size:1.5rem;margin:.75rem 0 .5rem}
  p{color:#bdbdbd;line-height:1.4}
  .code{display:inline-block;margin:1rem 0;padding:.6rem 1rem;border-radius:.6rem;
    background:rgba(139,37,59,.18);border:1px solid rgba(139,37,59,.5);
    font-weight:700;letter-spacing:.06em}
  a.btn{display:inline-block;margin-top:.5rem;padding:.85rem 1.5rem;border-radius:999px;
    background:linear-gradient(180deg,#a3324a,#8b253b);color:#fff;text-decoration:none;font-weight:700}
</style></head><body>
<div class="card">
  <div class="badge">🎟✨</div>
  <h1>Your Gennety gift is waiting</h1>
  <p>A free date ticket and 3 months of Premium are attached to this code. Open the app to claim them.</p>
  <div class="code">${safeCode}</div>
  ${dest ? `<a class="btn" id="go" href="${safeDest}">Open Gennety</a>` : ""}
</div>
<script>
  (function(){
    try { navigator.clipboard && navigator.clipboard.writeText("GENNETY:${safeCode}"); } catch (e) {}
    ${dest ? `setTimeout(function(){ location.href=${JSON.stringify(dest)}; }, 1200);` : ""}
  })();
</script>
</body></html>`;
    res.status(200).type("html").send(html);
  });

  router.post("/attribution", (req: Request, res: Response): void => {
    if (!env.PROMO_FEATURE_ENABLED) {
      res.status(404).json({ error: "promo-disabled" });
      return;
    }
    const raw = typeof req.body?.code === "string" ? req.body.code : "";
    const code = normalizePromoCode(raw);
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
      res.status(400).json({ error: "invalid-code" });
      return;
    }
    // Fire-and-forget resolve: only stash a real, redeemable code.
    void resolvePromoCode(code).then((resolved) => {
      if (resolved) recordAttribution(clientFingerprint(req), resolved.code);
    });
    res.json({ ok: true });
  });

  return router;
}

/** Escape a value destined for a double-quoted HTML attribute. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
