/**
 * DEV-ONLY tunnel shim.
 *
 * The free ngrok tunnel used for local Mini App dev injects an HTML
 * "browser warning" interstitial for any request from a browser-like
 * User-Agent (Telegram's WebView counts) that lacks the
 * `ngrok-skip-browser-warning` header. That HTML comes back as a 200 in place
 * of the API's JSON, so `res.json()` throws and every Mini App shows a generic
 * "couldn't send request" error — while nothing ever reaches the local API.
 *
 * Telegram's WebView gives us no way to set the header per fetch from the
 * button side, so in dev we wrap `window.fetch` to always send the bypass
 * header. This is compiled out of production builds (`import.meta.env.DEV` is
 * false there) where the API is a real HTTPS domain with no interstitial, and
 * the extra header would be harmless even if it leaked.
 *
 * Imported once by `api.ts`, which every Mini App entry pulls in, so the patch
 * applies to all of them (calendar, onboarding, tickets, venue-change, ...).
 */
if (import.meta.env.DEV && typeof window !== "undefined" && typeof window.fetch === "function") {
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!headers.has("ngrok-skip-browser-warning")) {
      headers.set("ngrok-skip-browser-warning", "true");
    }
    return original(input, { ...init, headers });
  };
}
