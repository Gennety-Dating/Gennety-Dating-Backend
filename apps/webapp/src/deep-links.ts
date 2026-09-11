/**
 * Mobility hand-offs: Uber, and the phone's own maps app (decision 2026-09-11,
 * the canvas's transit dock).
 *
 * ── Why every link is https ─────────────────────────────────────────────
 *
 * Not a style choice. `Telegram.WebApp.openLink` throws `WebAppTgUrlInvalid`
 * for anything that is not http(s) — telegram-web-app.js checks the protocol
 * before it posts `web_app_open_link` — and pointing the WebView itself at a
 * custom scheme is dropped or errors depending on the client. So `uber://`,
 * `maps://` and `bolt://` cannot be reached from a Mini App at all. An https
 * link the partner's app has claimed (`apple-app-site-association` on iOS, App
 * Links on Android) opens the native app when it is installed and the
 * partner's mobile web when it is not: the fallback is the same URL, so there
 * is no second path to drift.
 *
 * ── What the links carry ────────────────────────────────────────────────
 *
 * The destination and nothing else — the venue's point and its name. Never
 * the person's own position: Uber resolves `pickup=my_location` on the phone,
 * and both maps apps start the route from the current location when no origin
 * is given. The venue is a public place the product chose; where the user is
 * stays on the phone, the same rule the radar holds (PRODUCT_SPEC §6.3). No
 * function here takes an origin, so one cannot be added by accident without
 * changing a signature.
 *
 * ── Bolt ────────────────────────────────────────────────────────────────
 *
 * Deliberately absent. bolt.eu's `apple-app-site-association` declares only
 * `webcredentials`, no `applinks`, so on an iPhone no bolt.eu link opens the
 * app; and Bolt publishes no link that pre-fills a destination. A button would
 * open a web page and leave the user to type the address — the opposite of a
 * one-tap hand-off. Adding it is one function here once Bolt issues a partner
 * link.
 */

export interface Destination {
  lat: number;
  lng: number;
  /** The venue's name — the label the partner app shows for the drop-off. */
  name: string | null;
  address: string | null;
}

export type TravelMode = "walking" | "driving";

export type MapsApp = "apple" | "google";

/** What the buttons print. Brand names, so they live in no translation table. */
export const MAPS_APP_NAME: Record<MapsApp, string> = {
  apple: "Apple Maps",
  google: "Google Maps",
};

/**
 * Encoded by hand rather than with `URLSearchParams`, which writes a space as
 * `+`. That is correct form encoding and wrong here: iOS's `URLComponents`
 * keeps `+` literal, so a venue called "Trishky Bilshe" would reach the Uber
 * app as "Trishky+Bilshe". `encodeURIComponent` writes `%20`, which every
 * reader decodes the same way.
 */
function query(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

/** Six decimals is ~0.1 m — finer than any GPS, and it keeps the URL short. */
function coord(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Uber's rider universal link — `m.uber.com/looking`, the form Uber documents
 * today (the older `/ul/?action=setPickup` still resolves; both paths are in
 * Uber's app-site association). `client_id` attributes the ride to our Uber
 * developer app, which is what an affiliate agreement hangs on; while there is
 * none it is left out entirely rather than sent empty.
 */
export function uberLink(dest: Destination, options: { clientId?: string | null } = {}): string {
  const drop: Record<string, string | number> = {
    latitude: coord(dest.lat),
    longitude: coord(dest.lng),
  };
  if (dest.name) drop.addressLine1 = dest.name;
  if (dest.address) drop.addressLine2 = dest.address;
  const pairs: [string, string][] = [
    ["pickup", "my_location"],
    ["drop[0]", JSON.stringify(drop)],
  ];
  if (options.clientId) pairs.push(["client_id", options.clientId]);
  return `https://m.uber.com/looking?${query(pairs)}`;
}

/**
 * Apple Maps directions. `maps.apple.com` is Apple's own https form of the
 * `maps://` scheme, and iOS hands it straight to the Maps app. The legacy
 * `daddr` query rather than the 2025 `/directions` path: it reads on every iOS
 * a Telegram client still runs on. No `saddr` — the route starts at the phone.
 */
export function appleMapsLink(dest: Destination, mode: TravelMode): string {
  return `https://maps.apple.com/?${query([
    ["daddr", `${coord(dest.lat)},${coord(dest.lng)}`],
    ["dirflg", mode === "walking" ? "w" : "d"],
  ])}`;
}

/**
 * Google Maps directions — Google's documented cross-platform "Maps URLs"
 * form, which opens the app where it is installed and the web map where it is
 * not. The point, not the name, is the destination: a name is geocoded again
 * on Google's side and can land on a namesake across town, while the point is
 * the venue by construction. No `origin` — the current location is the default.
 */
export function googleMapsLink(dest: Destination, mode: TravelMode): string {
  return `https://www.google.com/maps/dir/?${query([
    ["api", "1"],
    ["destination", `${coord(dest.lat)},${coord(dest.lng)}`],
    ["travelmode", mode],
  ])}`;
}

export function mapsLink(app: MapsApp, dest: Destination, mode: TravelMode): string {
  return app === "apple" ? appleMapsLink(dest, mode) : googleMapsLink(dest, mode);
}

/**
 * Which maps app this phone has. Telegram names its own platform, which is
 * better evidence than a user agent: "ios" and "macos" ship Apple Maps,
 * "android" ships Google Maps. The web clients ("weba", "webk"), the desktop
 * one and no Telegram at all fall back to the user agent — Telegram Web runs
 * on iPhones too.
 */
export function mapsAppFor(platform: string | undefined, userAgent: string): MapsApp {
  if (platform === "ios" || platform === "macos") return "apple";
  if (platform === "android") return "google";
  return /iPhone|iPad|iPod|Macintosh/.test(userAgent) ? "apple" : "google";
}

/**
 * Hand a link to Telegram, which opens it outside the Mini App — in the
 * partner's app when the link is one it claims. Outside Telegram (the dev
 * harness, a plain browser) it is a new tab, and so is a client too old or too
 * strict to take the call: a tap that does nothing is the one outcome these
 * buttons must never have.
 */
export function openExternal(
  url: string,
  app: Pick<TelegramWebApp, "openLink"> | undefined,
  fallback: (url: string) => void = (u) => void window.open(u, "_blank", "noopener"),
): void {
  try {
    if (app?.openLink) {
      app.openLink(url);
      return;
    }
  } catch {
    // Fall through to the tab.
  }
  fallback(url);
}
