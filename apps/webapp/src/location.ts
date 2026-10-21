import "./location.css";
import {
  apiBase,
  searchLocations,
  resolveLocation,
  newLocationSessionToken,
  selectLocation,
  fetchVenueIntentState,
  interpretVenueIntentTma,
  confirmVenueIntentTma,
  CalendarApiError,
  type LocationSearchHit,
  type VenueIntentDraft,
  type VenueIntentTmaState,
} from "./api.js";
import { sceneOffers, mergeSceneIntent, type SceneOffer } from "./venue-scenes.js";
import sceneCopy from "./venue-scene-copy.json";
import { pickLang, tr, type Lang } from "./i18n.js";
import { wireContentInsets } from "./telegram-insets.js";
import { keepOpenOnVerticalSwipe } from "./telegram-swipes.js";
import { isInsideMarket, type MarketBounds } from "./market-gate.js";
import { boundaryEvent } from "./haptics.js";
// maplibre-gl v6 is ESM-only and has NO default export — named only. `Map`
// would shadow the global, so the package's own `MapLibreMap` alias is used.
import { AttributionControl, MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { mapStyle } from "./map-style.js";
import { startPulse } from "./pulse.js";

startPulse("mini_location");

/**
 * Location Mini App entry point (Phase 3.7 — concierge venue, map picker).
 *
 * Full-screen "Premium Lavender Glass" web app (shared visual language with the
 * venue-change / ticket Mini Apps): the dark map is a full-bleed backdrop and
 * the controls float over it as weightless liquid-glass islands. There is no
 * chrome header or footer divider — the old sandwich layout was retired.
 *
 * UX:
 *   1. Opened via the bot's `web_app` inline button. URL carries
 *      `?match=<id>&lang=<en|ru|uk|de|pl>` (start_param fallback for inline mode).
 *   2. A dark map (MapLibre GL over our own vector-tile proxy) opens centred
 *      on Kyiv (default city — no prior coords at first open). A **fixed centre
 *      pin** marks the selected point; the map moves under it (easier one-handed
 *      than dragging a marker), so whatever sits under the pin is the departure
 *      point.
 *   3. The user can:
 *      - Tap the 📍 FAB → browser geolocation prompt → immediate save.
 *      - Type a query → debounced `GET /v1/location/search` (Places
 *        Autocomplete, one session token per typing episode) → floating glass
 *        dropdown of up to 8 hits. Tap one → `GET /v1/location/resolve` buys
 *        the coordinates for that single place and the map recentres under the
 *        pin. The split is a billing one: a prediction is cheap and carries no
 *        coordinates, so the expensive half is paid once per CHOICE instead of
 *        once per keystroke.
 *      - Pan the map → the point under the pin becomes a "custom point".
 *   4. In V2, Continue opens the same photo chooser as iOS: five scenes and
 *      optional words. One tap interprets and confirms via the authenticated
 *      venue-intent routes, then closes into the existing chat search.
 *      The legacy/off path continues to POST `/v1/location/select`.
 *
 * No reverse-geocode on free-form pans to keep this v1 narrow — we don't need a
 * separate Geocoding API enabled, and the venue searcher works off lat/lng.
 */

const DEFAULT_CENTER: [number, number] = [50.4501, 30.5234]; // Kyiv center [lat, lng]
const DEFAULT_ZOOM = 14;
const PICK_ZOOM = 16;
// CARTO "dark-matter-nolabels" VECTOR basemap. The style itself is vendored
// (`map-style.ts`) rather than fetched from a hosted style URL, and it carries
// no glyphs and no sprite — so the whole map resolves to exactly ONE runtime
// URL, the bot's own /v1/vectortiles proxy (see public/server.ts). The phone
// therefore still talks only to our origin, which is the property the proxy
// exists for: it works where the CARTO CDN is unreachable directly.

const SEARCH_DEBOUNCE_MS = 350;
const MIN_QUERY_LEN = 2;
const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 60_000,
};
// Hard cap on the loading cover (#boot in location.html). It normally lifts the
// moment the first map tile paints; this is the floor under that, so a tile
// proxy outage shows a blank map with working controls rather than trapping the
// user behind a loader that will never finish.
const BOOT_REVEAL_MAX_MS = 2500;

const app = window.Telegram?.WebApp;
app?.ready();
app?.expand();
keepOpenOnVerticalSwipe(app);

// Bot API 8.0+ — immersive fullscreen so the map fills the screen edge-to-edge.
// Older clients silently fall through to expand().
// Guarded like the `setAttribute("lang", …)` call below: this runs at module
// scope, so a host without a populated `documentElement` (a test DOM stub) would
// otherwise throw before the app ever boots. A real client always has one, and
// falls back to the dark chrome when the theme attribute is absent.
const chromeColor =
  document.documentElement?.dataset.theme === "light" ? "#f5f5f5" : "#030303";
try {
  if (app?.isVersionAtLeast?.("8.0") && !app.isFullscreen) {
    app.requestFullscreen?.();
  }
  app?.setHeaderColor?.(chromeColor);
  app?.setBackgroundColor?.(chromeColor);
  app?.setBottomBarColor?.(chromeColor);
} catch {
  // Best-effort cosmetic boot — never crash over chrome theming.
}
// Reserve room for Telegram's floating close × / menu ⋯ in fullscreen.
wireContentInsets(app);
// We drive Confirm with our own in-page glass button; make sure a stale
// MainButton from a previous version can never linger over the composition.
app?.MainButton?.hide?.();

const params = new URLSearchParams(location.search);
const matchId = app?.initDataUnsafe?.start_param ?? params.get("match") ?? "";
const lang: Lang = pickLang(params.get("lang") ?? app?.initDataUnsafe?.user?.language_code);
document.documentElement?.setAttribute("lang", lang);

const searchEl = document.getElementById("search") as HTMLInputElement | null;
const resultsEl = document.getElementById("results");
const shareCurrentEl = document.getElementById("share-current") as HTMLButtonElement | null;
const confirmEl = document.getElementById("confirm") as HTMLButtonElement | null;
const ctaTextEl = confirmEl?.querySelector(".cta-text") ?? null;
const shareTextEl = shareCurrentEl?.querySelector(".loc-btn-text") ?? null;
const addrLabelEl = document.getElementById("addr-label");
const selectedEl = document.getElementById("selected");
const noContextEl = document.getElementById("no-context");
const bootEl = document.getElementById("boot");
const marketBlockEl = document.getElementById("market-block");
const marketBlockTextEl = document.getElementById("market-block-text");
const marketJumpEl = document.getElementById("market-jump") as HTMLButtonElement | null;

let bootDismissed = false;

/**
 * Lift the loading cover and reveal the screen behind it.
 *
 * Telegram opens a Mini App at ~half the screen height and expands it only when
 * loading finishes, so this page's opening frame is on screen long enough to be
 * a design surface. `#boot` covers it (location.html carries both the markup and
 * its critical CSS, since this module's stylesheet hasn't landed yet at that
 * point); this is where it comes off.
 *
 * Called by whichever comes first: the map painting its first tile (the honest
 * "there is a real screen here now" moment), one of the paths that never shows a
 * map at all, or the BOOT_REVEAL_MAX_MS cap. Idempotent — every one of those may
 * fire.
 */
function dismissBoot(): void {
  const el = bootEl;
  if (bootDismissed || !el) return;
  bootDismissed = true;
  el.classList.add("done");
  // Drop it once the fade is over so it can never swallow a tap on the map.
  setTimeout(() => el.remove(), 400);
}
setTimeout(dismissBoot, BOOT_REVEAL_MAX_MS);

let map: MapLibreMap | null = null;
let selectedLat: number = DEFAULT_CENTER[0];
let selectedLng: number = DEFAULT_CENTER[1];
let selectedAddress: string | null = null;
let confirming = false;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
/**
 * Sequence number of the newest dispatched search.
 *
 * Debounced typing still overlaps — a slow request can settle after a later,
 * faster one — and the failure notice below is what makes that matter: without
 * this guard a single stale rejection would paint "search is unavailable" over
 * results that had already arrived. Only the newest query may touch the list.
 */
let searchSeq = 0;
/**
 * The Places autocomplete session token for the typing episode in progress.
 *
 * Minted on the first keystroke of an episode and dropped the moment a place is
 * resolved, because Google defines a session as "the keystrokes that led to one
 * choice" and bills a reused token as though there were none. Null between
 * episodes, which is exactly when there is nothing to charge for.
 */
let searchSession: string | null = null;
let venueState: VenueIntentTmaState | null = null;
let draft: VenueIntentDraft | null = null;
/**
 * Departure-point gate (PRODUCT_SPEC §3.7). Null until `/state` answers, and
 * null forever for an account we cannot place — both mean "do not gate", so
 * the screen never blocks Confirm over data it is still waiting for.
 */
let market: MarketBounds | null = null;
/**
 * Сторона границы рынка на прошлом расчёте гейта. `null` — экран только что
 * открылся: первый расчёт обязан молчать, иначе черновик с точкой вне рынка
 * встречал бы человека упором в границу, которую он не пересекал.
 */
let wasInsideMarket: boolean | null = null;
let demoMode = false;
/** True once the user has deliberately chosen a point (search / geolocation). */
let originPicked = false;
// Venue Intent V2: the Location Mini App owns the WHOLE two-step flow again —
// origin (the map) then the vibe + canonical chips on the in-app "step 2" screen
// (2026-07: reverted from the short-lived chat-chip presentation because inline
// Telegram buttons can't carry the brand's liquid-glass design). On reopen, any
// intent already on file — draft OR confirmed — restores the vibe stage with the
// saved origin and description, so the user never re-picks their origin.
// Applies to every mode; shadow/off simply never create an in-app draft.
//
// Restored intent opens the chooser with its description and origin; Continue
// explicitly interprets and confirms the updated choice in one submission.
if (matchId && app) {
  void fetchVenueIntentState(app.initData, matchId)
    .then((state) => {
      venueState = state;
      market = state.market ?? null;
      demoMode = state.demoMode === true;
      // Centre on the user's actual city rather than the hardcoded Kyiv
      // fallback — but only while they haven't chosen a point themselves, so a
      // late `/state` can never yank the map out from under them.
      if (market && !originPicked) {
        recenter(market.latitude, market.longitude, null);
      }
      applyMarketGate();
      if (state.intent?.state === "draft" || state.intent?.state === "confirmed") {
        draft = state.intent;
        if (draft.origin) {
          selectedLat = draft.origin.lat;
          selectedLng = draft.origin.lng;
          selectedAddress = draft.origin.address;
          originPicked = true;
        }
        showVibeStage();
        restoreVibe();
      }
    })
    .catch(() => undefined);
}

if (searchEl) searchEl.placeholder = tr(lang, "locSearchPlaceholder");
if (shareTextEl) shareTextEl.textContent = tr(lang, "locShareCurrent");
if (shareCurrentEl) shareCurrentEl.setAttribute("aria-label", tr(lang, "locShareCurrent"));
if (addrLabelEl) addrLabelEl.textContent = tr(lang, "locSelectedPrefix").replace(/[:：]\s*$/, "");
if (ctaTextEl) ctaTextEl.textContent = tr(lang, "locConfirm");

if (!matchId) {
  showNoContext();
} else {
  initMap();
  initSearch();
  initShareCurrentLocation();
  initMarketJump();
  initKeyboardBottomBar();
  confirmEl?.addEventListener("click", () => {
    void handleConfirm();
  });
}

/**
 * Keep the bottom island (address readout + "use my location" + Confirm) out of
 * the way while the user is typing a search query. When the search field is
 * focused the on-screen keyboard is up, and in the Telegram WebView a fixed
 * bottom bar rides up to sit just above the keyboard — covering the results list
 * and leaving no room for it. Measuring the keyboard is unreliable here (the
 * WebView shrinks `window.innerHeight` alongside `visualViewport`, so the delta
 * reads ~0 and a translate-down never fires), so instead we simply tuck the
 * whole bottom island off-screen on focus and slide it back on blur. Confirm /
 * geolocation aren't needed mid-search, so hiding them frees the full space
 * between the search box and the keyboard for the dropdown.
 */
function initKeyboardBottomBar(): void {
  if (!searchEl || typeof document.querySelector !== "function") return;
  const bottom = document.querySelector<HTMLElement>(".layer.bottom");
  if (!bottom) return;
  searchEl.addEventListener("focus", () => bottom.classList.add("kb-open"));
  searchEl.addEventListener("blur", () => bottom.classList.remove("kb-open"));
}

function showNoContext(): void {
  if (noContextEl) {
    noContextEl.style.display = "flex";
    noContextEl.textContent = tr(lang, "noContext");
  }
  dismissBoot();
}

function initMap(): void {
  // Isolate init so a map failure only costs the preview — search, "use my
  // location", and Confirm must still work (they operate on lat/lng). This
  // catch is also the WebGL fallback: MapLibre throws from its constructor on
  // a device that cannot give it a GL context, and the user still gets a
  // working picker rather than a dead screen.
  try {
    // This WebView leaves the `inset:0` map container at 0 height (verified on
    // device: #map=375x0), so the renderer would size its canvas to nothing
    // and paint nothing. Force an explicit pixel size from the real window
    // dimensions
    // before init, and keep it in sync as the fullscreen viewport settles.
    const mapEl = document.getElementById("map");
    const sizeMapContainer = (): void => {
      if (!mapEl || typeof window.innerWidth !== "number") return;
      mapEl.style.width = `${window.innerWidth}px`;
      mapEl.style.height = `${window.innerHeight}px`;
    };
    sizeMapContainer();

    // MapLibre takes [lng, lat] where DEFAULT_CENTER is [lat, lng] — the one
    // ordering difference from the Leaflet map this replaced, and the only
    // thing worth double-checking when touching this file.
    map = new MapLibreMap({
      container: "map",
      style: mapStyle(apiBase),
      center: [DEFAULT_CENTER[1], DEFAULT_CENTER[0]],
      zoom: DEFAULT_ZOOM,
      maxZoom: 20,
      // The picker is a fixed centre pin over a north-up map. MapLibre enables
      // two-finger rotate/pitch by default, which would tilt the ground under a
      // pin that cannot tilt with it — so the extra freedom is switched off
      // rather than left as an affordance that leads somewhere confusing.
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
    });
    map.touchZoomRotate?.disableRotation?.();
    // OSM + CARTO credit is a licence condition, so it is added explicitly and
    // never in `compact` mode — a credit hidden behind an ⓘ the user has to
    // find is not a credit. The string rides the style's own source.
    map.addControl(new AttributionControl({ compact: false }), "bottom-right");
    // `idle` — the map has painted everything it was asked to paint — rather
    // than `load`, which resolves as soon as the style parses and one frame
    // goes out. Neither is proof on its own: in this WebView the container can
    // still measure 0x0 at init, and a map asked for no tiles reaches both
    // events instantly. That is what the size-kick below and the
    // BOOT_REVEAL_MAX_MS floor are for; `idle` is simply the closer of the two.
    map.once("idle", dismissBoot);

    // The point under the fixed centre pin is the selection. Any manual pan
    // makes it a "custom point"; programmatic recentres (search / geolocation)
    // override the label right after, so a labelled pick never flickers.
    map.on("moveend", () => {
      if (!map) return;
      const c = map.getCenter();
      setSelected(c.lat, c.lng, null);
    });

    setSelected(DEFAULT_CENTER[0], DEFAULT_CENTER[1], null);
    // Telegram opens this in immersive fullscreen, so the viewport (and the map
    // container) settles a few hundred ms AFTER init. The renderer sizes its
    // canvas from the container, so measuring only once at init would leave a
    // 0-height canvas and stay blank forever. Recompute on every viewport
    // change plus a few staggered ticks so it paints as soon as the size is
    // real.
    const kickResize = (): void => {
      sizeMapContainer();
      map?.resize();
    };
    if (typeof window.addEventListener === "function") {
      window.addEventListener("resize", kickResize);
    }
    app?.onEvent?.("viewportChanged", kickResize);
    app?.onEvent?.("fullscreenChanged", kickResize);
    for (const ms of [120, 400, 800, 1500]) setTimeout(kickResize, ms);
  } catch {
    map = null;
    if (selectedEl) selectedEl.textContent = tr(lang, "locErrMapUnavailable");
    dismissBoot();
  }
}

/** Recentre the map under the pin and label the point in one step. */
function recenter(lat: number, lng: number, address: string | null): void {
  // jumpTo (no animation) is instant and fires `moveend` synchronously
  // (setting a null "custom point"); we then override with the real label
  // below. MapLibre is [lng, lat].
  map?.jumpTo({ center: [lng, lat], zoom: PICK_ZOOM });
  setSelected(lat, lng, address);
}

function setSelected(lat: number, lng: number, address: string | null): void {
  selectedLat = lat;
  selectedLng = lng;
  selectedAddress = address;
  renderSelectedLine();
  applyMarketGate();
}

/**
 * Departure-point gate (PRODUCT_SPEC §3.7): reflect whether the current pin is
 * inside the launched market. Runs on every pan, so the answer is on screen
 * before the user reaches for Confirm rather than after they press it.
 *
 * Never *moves* the pin — someone panning across the map is exploring, and
 * snapping them back would fight the gesture. It only refuses to let a point
 * we cannot serve be submitted.
 */
function applyMarketGate(): boolean {
  const inside = isInsideMarket(market, selectedLat, selectedLng);

  // Тактильная сторона гейта — паритет с iOS (`boundaryBump`/`pinSettle`).
  // Играет ПЕРЕСЕЧЕНИЕ, а не состояние: эта функция вызывается на каждом пане
  // карты, и отклик от состояния означал бы вибрацию всё время, пока пин
  // снаружи. Первый расчёт молчит — сторона границы ещё неизвестна.
  const crossing = boundaryEvent(wasInsideMarket, inside);
  wasInsideMarket = inside;
  if (crossing === "exit") {
    app?.HapticFeedback?.impactOccurred?.("rigid");
  } else if (crossing === "enter") {
    app?.HapticFeedback?.impactOccurred?.("soft");
  }

  if (confirmEl && !confirming) confirmEl.disabled = !inside;
  if (marketBlockEl) marketBlockEl.hidden = inside;
  if (!inside && market) {
    if (marketBlockTextEl) {
      marketBlockTextEl.textContent = tr(lang, "locOutsideMarket").replaceAll(
        "{city}",
        market.city,
      );
    }
    // Demo only: the visitor is often genuinely abroad, so they get a way past
    // a gate that is otherwise correct to show them (DEMO_MODE.md).
    if (marketJumpEl) {
      marketJumpEl.hidden = !demoMode;
      marketJumpEl.textContent = tr(lang, "locJumpToCity").replaceAll("{city}", market.city);
    }
  }
  return inside;
}

function renderSelectedLine(): void {
  if (!selectedEl) return;
  selectedEl.textContent = selectedAddress ?? tr(lang, "locCustomPoint");
}

function initSearch(): void {
  if (!searchEl || !resultsEl) return;
  searchEl.addEventListener("input", () => {
    const q = searchEl.value.trim();
    if (searchDebounce !== null) clearTimeout(searchDebounce);
    if (q.length < MIN_QUERY_LEN) {
      hideResults();
      return;
    }
    searchDebounce = setTimeout(() => {
      void runSearch(q);
    }, SEARCH_DEBOUNCE_MS);
  });
  // Close dropdown when tapping outside.
  document.addEventListener("click", (ev) => {
    if (
      ev.target instanceof Node &&
      !searchEl.contains(ev.target) &&
      !resultsEl.contains(ev.target)
    ) {
      hideResults();
    }
  });
}

async function runSearch(query: string): Promise<void> {
  if (!app) return;
  const seq = ++searchSeq;
  try {
    // Bias the search by the current pin position so "metro" disambiguates to
    // the user's city, not a global hit.
    const center = map ? { lat: selectedLat, lng: selectedLng } : null;
    // One token for the whole episode: minted here on the first keystroke that
    // reaches the network, reused by every later one, and spent by the resolve
    // in `pickHit`. Sending it is what turns these requests into a single
    // billable session instead of a request each.
    searchSession ??= newLocationSessionToken();
    const hits = await searchLocations(app.initData, query, center, searchSession);
    if (seq !== searchSeq) return;
    renderResults(hits);
  } catch {
    if (seq !== searchSeq) return;
    // Soft-fail — searching is supplemental; the user can still pan the map,
    // and that is exactly what this row tells them. What it is NOT any more is
    // silent: hiding the dropdown made a dead provider look identical to "no
    // such place", so the picker found nothing and gave nobody a reason. It
    // still refuses to throw a modal — the point can be dropped by hand, so
    // this is a footnote, not an interruption.
    showSearchNotice(tr(lang, "locSearchUnavailable"));
  }
}

function renderResults(hits: LocationSearchHit[]): void {
  if (!resultsEl) return;
  resultsEl.innerHTML = "";
  if (hits.length === 0) {
    hideResults();
    return;
  }
  for (const hit of hits) {
    const item = document.createElement("div");
    item.className = "result";
    const primary = document.createElement("div");
    primary.className = "primary";
    primary.textContent = hit.name;
    const secondary = document.createElement("div");
    secondary.className = "secondary";
    secondary.textContent = hit.address;
    item.append(primary, secondary);
    item.addEventListener("click", () => {
      void pickHit(hit);
    });
    resultsEl.appendChild(item);
  }
  resultsEl.classList.add("visible");
}

function hideResults(): void {
  resultsEl?.classList.remove("visible");
}

/**
 * One non-selectable row saying why the list has nothing in it.
 *
 * It borrows the results island so the explanation lands where the user is
 * already looking, and carries `notice` so nothing about it — cursor, press
 * state, click handler — reads as something that can be picked.
 */
function showSearchNotice(text: string): void {
  if (!resultsEl) return;
  resultsEl.innerHTML = "";
  const item = document.createElement("div");
  item.className = "result notice";
  item.textContent = text;
  resultsEl.appendChild(item);
  resultsEl.classList.add("visible");
}

function initShareCurrentLocation(): void {
  shareCurrentEl?.addEventListener("click", handleShareCurrentLocation);
}

/**
 * Demo-only shortcut (DEMO_MODE.md): drop the pin in the launched city. The
 * gate is NOT waived — this just produces a valid pin, so the visitor sees the
 * real block card with the real reason and still gets through it. Hidden
 * outside demo mode, where "pretend you're in Kyiv" would be nonsense.
 */
function initMarketJump(): void {
  marketJumpEl?.addEventListener("click", () => {
    if (!market) return;
    originPicked = true;
    recenter(market.latitude, market.longitude, market.city);
  });
}

async function pickHit(hit: LocationSearchHit): Promise<void> {
  if (searchEl) searchEl.value = hit.name;
  // Held for the whole tap, the resolve round trip included, so a late `/state`
  // cannot recentre the map out from under a choice already in flight. Rolled
  // back on every path below that fails to move the pin.
  originPicked = true;
  hideResults();
  // Dismiss the keyboard so the bottom island (Confirm) slides back in and the
  // map/pin is visible again now that a place has been chosen.
  searchEl?.blur();
  // Compose a human label combining name + short address. The address is often
  // the full street + city; combining gives the bot's confirmation message a
  // stable "[Name], [Address]" shape.
  const label = hit.address ? `${hit.name}, ${hit.address}` : hit.name;

  // The legacy Text Search branch, and the dev stub, both carry coordinates.
  if (hit.lat != null && hit.lng != null) {
    recenter(hit.lat, hit.lng, label);
    app?.HapticFeedback?.selectionChanged?.();
    return;
  }

  // An autocomplete prediction does not. This is where coordinates are bought —
  // once, for the ONE place the user actually chose — and sending the session
  // token is what closes the session and makes every keystroke that led here
  // free.
  if (!app || !hit.placeId) {
    originPicked = false;
    return;
  }
  try {
    const resolved = await resolveLocation(app.initData, hit.placeId, searchSession ?? "");
    if (resolved.lat == null || resolved.lng == null) {
      failedPick();
      return;
    }
    // Spent only now that it has actually closed a session. A FAILED resolve
    // deliberately keeps the token, so a retry can still close the same
    // session — whereas carrying a spent one into the next typing episode
    // would be billed as though there were no token at all.
    searchSession = null;
    recenter(
      resolved.lat,
      resolved.lng,
      resolved.address ? `${hit.name}, ${resolved.address}` : label,
    );
    app.HapticFeedback?.selectionChanged?.();
  } catch (err) {
    // Soft-fail like `runSearch` — no modal — but NOT silent. Before this, a
    // failed resolve did nothing observable at all: the row was dismissed, the
    // pin did not move, and the tap simply had no effect, which reads as a
    // broken app rather than as a failed lookup. The one refusal the server
    // gives a reason for gets that reason shown; everything else puts the list
    // back so the choice is still there to retry or change.
    if (
      err instanceof CalendarApiError &&
      err.reason === "origin-outside-market" &&
      market
    ) {
      showMarketRefusal();
    }
    failedPick();
  }
}

/**
 * Undo a pick that never landed: release the `originPicked` hold, re-open the
 * results list, and give the same "that did not work" haptic the rest of the
 * app uses. Re-showing the list is the part that matters — it is what makes
 * the failure legible as "this row, again" rather than as nothing happening.
 */
function failedPick(): void {
  originPicked = false;
  app?.HapticFeedback?.notificationOccurred?.("error");
  if (resultsEl && resultsEl.childElementCount > 0) {
    resultsEl.classList.add("visible");
  }
}

/**
 * The out-of-market banner, shown for a REFUSED pick rather than for a panned
 * pin. Same element and same sentence the map gate already uses
 * (`applyMarketGate`), because it is the same refusal arriving through a
 * different door.
 */
function showMarketRefusal(): void {
  if (!market) return;
  if (marketBlockTextEl) {
    marketBlockTextEl.textContent = tr(lang, "locOutsideMarket").replaceAll(
      "{city}",
      market.city,
    );
  }
  if (marketBlockEl) marketBlockEl.hidden = false;
}

async function handleConfirm(): Promise<void> {
  if (!app || confirming) return;
  if (!Number.isFinite(selectedLat) || !Number.isFinite(selectedLng)) {
    app.showAlert(tr(lang, "locErrInvalidCoords"));
    return;
  }
  // Belt-and-braces: the button is already disabled outside the market, so this
  // only catches a programmatic path (or an older cached page).
  if (!applyMarketGate()) return;
  startSaving(false);
  await completeLocationStep(selectedLat, selectedLng, selectedAddress);
}

function handleShareCurrentLocation(): void {
  if (!app || confirming) return;
  if (
    typeof navigator === "undefined" ||
    !navigator.geolocation ||
    window.isSecureContext === false
  ) {
    app.showAlert(tr(lang, "locErrGeoUnsupported"));
    return;
  }

  startSaving(true);
  // Browser/Telegram WebView location permission must be requested from this
  // user click; any denial or platform failure falls back to manual input.
  navigator.geolocation.getCurrentPosition(
    (position) => {
      void handleGeolocationSuccess(position);
    },
    (error) => {
      handleGeolocationError(error);
    },
    GEOLOCATION_OPTIONS,
  );
}

async function handleGeolocationSuccess(position: GeolocationPosition): Promise<void> {
  const lat = position.coords.latitude;
  const lng = position.coords.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    resetSaving();
    app?.showAlert(tr(lang, "locErrInvalidCoords"));
    return;
  }

  const label = tr(lang, "locCurrentLocation");
  originPicked = true;
  recenter(lat, lng, label);
  // Departure-point gate (PRODUCT_SPEC §3.7). This path used to save silently,
  // which made "use my location" the easiest way to put an out-of-market origin
  // on a match — someone travelling taps it without ever seeing the map. Show
  // them where they are, explain, and let them pick a real departure point.
  if (!applyMarketGate()) {
    resetSaving();
    app?.HapticFeedback?.notificationOccurred?.("warning");
    return;
  }
  await completeLocationStep(lat, lng, label);
}

function handleGeolocationError(error: GeolocationPositionError): void {
  resetSaving();
  app?.HapticFeedback?.notificationOccurred?.("warning");
  app?.showAlert(geolocationErrorMessage(error));
}

function geolocationErrorMessage(error: GeolocationPositionError): string {
  switch (error.code) {
    case 1:
      return tr(lang, "locErrGeoDenied");
    case 2:
      return tr(lang, "locErrGeoUnavailable");
    case 3:
      return tr(lang, "locErrGeoTimeout");
    default:
      return tr(lang, "locErrGeoUnavailable");
  }
}

function startSaving(fromShareCurrent: boolean): void {
  confirming = true;
  if (confirmEl) {
    confirmEl.disabled = true;
    confirmEl.classList.add("saving");
  }
  if (ctaTextEl) ctaTextEl.textContent = tr(lang, "locConfirming");
  if (shareCurrentEl) {
    shareCurrentEl.disabled = true;
    if (fromShareCurrent) shareCurrentEl.classList.add("loading");
  }
}

function resetSaving(): void {
  confirming = false;
  if (confirmEl) {
    confirmEl.disabled = false;
    confirmEl.classList.remove("saving");
  }
  if (ctaTextEl) ctaTextEl.textContent = tr(lang, "locConfirm");
  if (shareCurrentEl) {
    shareCurrentEl.disabled = false;
    shareCurrentEl.classList.remove("loading");
  }
}

async function saveLocation(
  lat: number,
  lng: number,
  address: string | null,
): Promise<void> {
  if (!app) return;
  try {
    await selectLocation(app.initData, matchId, lat, lng, address);
    app.HapticFeedback?.notificationOccurred?.("success");
    if (selectedEl) selectedEl.textContent = tr(lang, "locSaved");
    // Brief flash so the user perceives the success before the app closes
    // itself — without it Telegram dismisses too fast on iOS.
    setTimeout(() => app.close(), 350);
  } catch (err) {
    resetSaving();
    const msg = err instanceof CalendarApiError ? errorMessage(err) : tr(lang, "errNetwork");
    app.showAlert(msg);
  }
}

async function completeLocationStep(lat: number, lng: number, address: string | null): Promise<void> {
  // Venue Intent V2 (live): the Mini App owns the whole two-step flow. Instead of
  // saving the origin and closing, hold it in memory and advance to the in-app
  // vibe stage — interpret/confirm persist the origin, and the final in-app
  // confirm runs the V2 finalizer + delivers the scheduled confirmation. Non-live
  // (shadow/off legacy) keeps the origin-only save + close; the vibe is collected
  // elsewhere for those modes.
  if (!venueState && app) {
    // The boot fetch normally populates this well before Confirm; re-fetch once
    // if a very fast tap beat it, so we never fall through to legacy save in live.
    try {
      venueState = await fetchVenueIntentState(app.initData, matchId);
    } catch {
      /* fall through to the legacy origin-only save */
    }
  }
  if (venueState?.mode === "live") {
    selectedLat = lat;
    selectedLng = lng;
    selectedAddress = address;
    resetSaving();
    // Light tactile confirmation on the page turn (the origin→vibe advance had
    // no haptic before, so it read as an abrupt blink).
    app?.HapticFeedback?.impactOccurred?.("light");
    showVibeStage();
    return;
  }
  await saveLocation(lat, lng, address);
}

const VIBE_UI: Record<Lang, { thinkingSteps: string[] }> = {
  en: { thinkingSteps: ["Reading your vibe…", "Thinking…", "Picking out the details…"], },
  ru: { thinkingSteps: ["Считываю вайб…", "Думаю…", "Выделяю детали…"], },
  uk: { thinkingSteps: ["Зчитую вайб…", "Обмірковую…", "Виділяю деталі…"], },
  de: { thinkingSteps: ["Lese deine Stimmung…", "Denke nach…", "Filtere die Details…"], },
  pl: { thinkingSteps: ["Czytam twój klimat…", "Myślę…", "Wyłapuję szczegóły…"], },
};

const chooserCopy = sceneCopy[lang];
let pickedScene: SceneOffer["scene"]["id"] | null = null;
let allowLongerCommute = false;

function applyVibeUi(): void {
  const set = (id: string, value: string): void => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  set("vibe-title", chooserCopy["venue.text.title"]);
  set("vibe-help", chooserCopy["venue.text.help"]);
  set("vibe-own", chooserCopy["venue.text.own"]);
  set("vibe-back", chooserCopy["venue.back"]);
  const button = document.getElementById("vibe-interpret");
  const span = button?.querySelector?.(".cta-text");
  if (span) span.textContent = chooserCopy["venue.text.continue"];
  else if (button) button.textContent = chooserCopy["venue.text.continue"];
  document.getElementById("vibe-scenes")?.setAttribute("aria-label", chooserCopy["venue.text.title"]);
  document.getElementById("vibe-text")?.setAttribute("aria-label", chooserCopy["venue.text.own"]);
}

function setMapInert(hidden: boolean): void {
  for (const element of document.querySelectorAll?.<HTMLElement>("#map, .layer.top, .layer.bottom") ?? []) {
    element.inert = hidden;
    element.setAttribute("aria-hidden", String(hidden));
  }
}

function showVibeStage(): void {
  const stage = document.getElementById("vibe-stage");
  if (stage) stage.hidden = false;
  document.getElementById("search")?.blur?.();
  setMapInert(true);
  stage?.focus?.({ preventScroll: true });
  dismissBoot();
  applyVibeUi();
  renderScenes();
  renderRelaxation();
}

function restoreVibe(): void {
  const text = document.getElementById("vibe-text") as HTMLTextAreaElement | null;
  if (text && draft) text.value = draft.rawText;
  allowLongerCommute = draft?.hardConstraints.maxCommuteKm === 12;
  renderRelaxation();
}

function renderScenes(): void {
  const container = document.getElementById("vibe-scenes");
  if (!container) return;
  container.replaceChildren(...sceneOffers(venueState?.suggestions ?? []).map((offer) => {
    const { scene } = offer;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `venue-scene${scene.id === "surprise" ? " venue-scene-wide" : ""}`;
    button.setAttribute("aria-pressed", String(pickedScene === scene.id));
    button.setAttribute("data-scene", scene.id);
    button.style.setProperty?.("--scene-focus", scene.focus);
    const photo = document.createElement("img");
    photo.src = `/venue-scenes/${scene.asset}.jpg`;
    photo.alt = "";
    photo.draggable = false;
    const blur = document.createElement("span");
    blur.className = "venue-scene-blur";
    blur.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) blur.appendChild(document.createElement("i"));
    const caption = document.createElement("span");
    caption.className = "venue-scene-caption";
    const title = document.createElement("span");
    title.className = "venue-scene-title";
    title.textContent = chooserCopy[scene.id];
    caption.appendChild(title);
    const mood = scene.id === "surprise" ? chooserCopy["venue.scene.surprise.hint"]
      : offer.mood.map((id) => chooserCopy[id]).join(" · ");
    if (mood) {
      const subtitle = document.createElement("span");
      subtitle.className = "venue-scene-mood";
      subtitle.textContent = mood;
      caption.appendChild(subtitle);
    }
    const mark = document.createElement("span");
    mark.className = "venue-scene-mark";
    mark.textContent = "✓";
    mark.setAttribute("aria-hidden", "true");
    button.appendChild(photo);
    button.appendChild(blur);
    button.appendChild(caption);
    button.appendChild(mark);
    button.addEventListener("click", () => {
      if (vibeBusy) return;
      pickedScene = pickedScene === scene.id ? null : scene.id;
      const error = document.getElementById("vibe-error");
      if (error) error.textContent = "";
      app?.HapticFeedback?.selectionChanged?.();
      renderScenes();
      document.querySelector?.<HTMLElement>(`[data-scene="${scene.id}"]`)?.focus();
    });
    return button;
  }));
}

function renderRelaxation(): void {
  const noCandidates = venueState?.selectionError?.startsWith("no_candidates:") === true;
  const relax = document.getElementById("vibe-relax");
  if (relax) relax.hidden = !noCandidates;
  const help = document.getElementById("vibe-relax-help");
  if (help) help.textContent = chooserCopy["venue.waiting.relax"];
  const commute = document.getElementById("vibe-commute");
  if (commute) {
    commute.hidden = !venueState?.selectionError?.startsWith("no_candidates:commute_12_km:");
    commute.textContent = chooserCopy.commute_12_km;
    commute.setAttribute("aria-pressed", String(allowLongerCommute));
  }
}

document.getElementById("vibe-commute")?.addEventListener("click", () => {
  if (vibeBusy) return;
  allowLongerCommute = !allowLongerCommute;
  renderRelaxation();
});

/** How long each "thinking" status beat is held inside a busy CTA. */
const CTA_STATUS_STEP_MS = 1600;
/** One vibe-stage request at a time (a second tap while thinking is a no-op). */
let vibeBusy = false;

/**
 * Put a CTA into its "agent is working" state and cycle status beats through its
 * label until the caller stops it.
 *
 * Continue covers interpretation and confirmation in one request chain.
 * The interpreter may take seconds; venue selection continues in the chat. Before this the button simply sat
 * there inert — no haptic, no spinner, no copy change — so the tap read as "did
 * it even register?" and users re-tapped. The spinner + rotating status is the
 * same "agent is working" language the bot uses in chat (PRODUCT_SPEC §1.3).
 *
 * Returns a stop function that restores the original label and re-enables the
 * button, so a failed request lands back on a normal, tappable CTA.
 */
function startCtaThinking(btn: HTMLButtonElement, steps: string[]): () => void {
  const textEl = btn.querySelector?.(".cta-text") ?? null;
  const originalLabel = textEl?.textContent ?? "";
  btn.disabled = true;
  btn.classList.add("saving");
  let index = 0;
  const paint = (): void => {
    if (!textEl) return;
    textEl.textContent = steps[index % steps.length] ?? originalLabel;
    // Re-trigger the swap fade: drop the class, force a reflow, add it back.
    textEl.classList.remove("swap");
    void (textEl as HTMLElement).offsetWidth;
    textEl.classList.add("swap");
  };
  paint();
  const timer = setInterval(() => {
    index += 1;
    paint();
  }, CTA_STATUS_STEP_MS);
  return () => {
    clearInterval(timer);
    btn.disabled = false;
    btn.classList.remove("saving");
    if (textEl) {
      textEl.classList.remove("swap");
      textEl.textContent = originalLabel;
    }
  };
}

document.getElementById("vibe-back")?.addEventListener("click", () => {
  if (vibeBusy) return;
  const stage = document.getElementById("vibe-stage");
  if (stage) stage.hidden = true;
  setMapInert(false);
});
document.getElementById("vibe-interpret")?.addEventListener("click", async () => {
  if (!app || vibeBusy) return;
  const textArea = document.getElementById("vibe-text") as HTMLTextAreaElement | null;
  const text = textArea?.value.trim() ?? "";
  const offer = sceneOffers(venueState?.suggestions ?? []).find((item) => item.scene.id === pickedScene);
  const error = document.getElementById("vibe-error");
  if (!text && !offer) {
    app.HapticFeedback?.notificationOccurred?.("warning");
    if (error) error.textContent = chooserCopy["venue.error.describe"];
    return;
  }
  app.HapticFeedback?.impactOccurred?.("medium");
  textArea?.blur?.();
  vibeBusy = true;
  if (textArea) textArea.disabled = true;
  const stopThinking = startCtaThinking(
    document.getElementById("vibe-interpret") as HTMLButtonElement,
    VIBE_UI[lang].thinkingSteps,
  );
  try {
    const phrase = offer ? [chooserCopy[offer.scene.id], ...offer.ambiences.map((id) => chooserCopy[id])].join(", ") : "";
    const origin = { lat: selectedLat, lng: selectedLng, address: selectedAddress };
    const interpreted = await interpretVenueIntentTma(app.initData, matchId, text || phrase, origin);
    draft = mergeSceneIntent(interpreted, offer, Boolean(text));
    if (venueState?.selectionError?.startsWith("no_candidates:commute_12_km:")) {
      draft.hardConstraints.maxCommuteKm = allowLongerCommute ? 12 : 8;
    }
    venueState = await confirmVenueIntentTma(app.initData, matchId, {
      experiences: [...draft.experiences].sort(), ambiences: [...draft.ambiences].sort(), formats: [...draft.formats].sort(),
      hardConstraints: draft.hardConstraints, origin,
    });
    if (error) error.textContent = "";
    app.HapticFeedback?.notificationOccurred?.("success");
    // The existing chat search continues after the Mini App closes.
    setTimeout(() => app.close(), 200);
  } catch {
    app.HapticFeedback?.notificationOccurred?.("error");
    if (error) error.textContent = tr(lang, "errNetwork");
    vibeBusy = false;
  } finally {
    stopThinking();
    const submit = document.getElementById("vibe-interpret") as HTMLButtonElement | null;
    if (submit) submit.disabled = vibeBusy;
    if (!vibeBusy && textArea) textArea.disabled = false;
  }
});

function errorMessage(err: CalendarApiError): string {
  switch (err.reason) {
    case "expired":
    case "missing-hash":
    case "bad-hash":
    case "missing-auth-date":
      return tr(lang, "errExpired");
    case "match-not-found":
    case "user-not-found":
      return tr(lang, "errMatchGone");
    case "wrong-state":
      return tr(lang, "errWrongState");
    case "not-participant":
      return tr(lang, "errNotParticipant");
    case "invalid-coords":
      return tr(lang, "locErrInvalidCoords");
    default:
      return `${tr(lang, "errGeneric")} (HTTP ${err.status})`;
  }
}
