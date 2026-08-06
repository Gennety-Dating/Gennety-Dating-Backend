import "./location.css";
import {
  apiBase,
  searchLocations,
  selectLocation,
  fetchVenueIntentState,
  interpretVenueIntentTma,
  confirmVenueIntentTma,
  CalendarApiError,
  type LocationSearchHit,
  type VenueIntentDraft,
  type VenueIntentTmaState,
  type VenueExperience,
  type VenueAmbience,
  type VenueFormat,
} from "./api.js";
import { pickLang, tr, type Lang } from "./i18n.js";
import { wireContentInsets } from "./telegram-insets.js";
import { isInsideMarket, type MarketBounds } from "./market-gate.js";

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
 *   2. A dark map (Leaflet + CARTO dark tiles) opens centred on Kyiv (default
 *      city — no prior coords at first open). A **fixed centre pin** marks the
 *      selected point; the map moves under it (easier one-handed than dragging a
 *      marker), so whatever sits under the pin is the departure point.
 *   3. The user can:
 *      - Tap the 📍 FAB → browser geolocation prompt → immediate save.
 *      - Type a query → debounced `GET /v1/location/search` → floating glass
 *        dropdown of up to 8 hits. Tap one → map recentres under the pin.
 *      - Pan the map → the point under the pin becomes a "custom point".
 *   4. The in-page **Confirm** island POSTs `lat/lng + address` to
 *      `/v1/location/select`, which writes vibeLat/Lng/Address on the match and
 *      triggers `tryFinalize`. App closes on success. (We drive Confirm with our
 *      own glass button, not the opaque native MainButton — same choice as
 *      venue-change — so the floating-glass composition stays intact.)
 *
 * No reverse-geocode on free-form pans to keep this v1 narrow — we don't need a
 * separate Geocoding API enabled, and the venue searcher works off lat/lng.
 */

const DEFAULT_CENTER: [number, number] = [50.4501, 30.5234]; // Kyiv center [lat, lng]
const DEFAULT_ZOOM = 14;
const PICK_ZOOM = 16;
// CARTO "dark_all" raster basemap — keyless, minimal, on a fast global CDN.
// Raster tiles are plain images (no WebGL, no vector glyphs/sprites), so the
// picker loads light and renders reliably inside the Telegram WebView.
// Tiles come through the bot's own /v1/maptiles proxy (see public/server.ts):
// the phone only talks to our origin, so it works even where the CARTO CDN is
// unreachable directly. The proxy fetches CARTO dark_all server-side.
const MAP_TILES_URL = `${apiBase}/v1/maptiles/{z}/{x}/{y}`;
const MAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
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

let map: L.Map | null = null;
let selectedLat: number = DEFAULT_CENTER[0];
let selectedLng: number = DEFAULT_CENTER[1];
let selectedAddress: string | null = null;
let confirming = false;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let venueState: VenueIntentTmaState | null = null;
let draft: VenueIntentDraft | null = null;
/**
 * Departure-point gate (PRODUCT_SPEC §3.7). Null until `/state` answers, and
 * null forever for an account we cannot place — both mean "do not gate", so
 * the screen never blocks Confirm over data it is still waiting for.
 */
let market: MarketBounds | null = null;
let demoMode = false;
/** True once the user has deliberately chosen a point (search / geolocation). */
let originPicked = false;
// Venue Intent V2: the Location Mini App owns the WHOLE two-step flow again —
// origin (the map) then the vibe + canonical chips on the in-app "step 2" screen
// (2026-07: reverted from the short-lived chat-chip presentation because inline
// Telegram buttons can't carry the brand's liquid-glass design). On reopen, any
// intent already on file — draft OR confirmed — restores the vibe stage with the
// saved origin and chips, so the user never re-picks their origin.
// Applies to every mode; shadow/off simply never create an in-app draft.
//
// `confirmed` restores for the same reason `draft` does. Reopening after
// confirming used to drop the user on a blank map centred on the city default,
// with nothing on screen acknowledging the submission they had already made —
// indistinguishable from the flow having reset, on the one screen where being
// wrong about that is most alarming. The data was always safe (the server
// refuses to let a stray interpret clobber a confirmed intent), so this only
// makes the screen agree with the server. It also gives the stage its first
// way to change your mind before the partner submits: re-confirming overwrites
// this side's intent and is otherwise a no-op.
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
        renderDraft();
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
  // Leaflet is loaded from a `<script>` tag in location.html — global `L`. If
  // for any reason it didn't load (offline tunnel during dev), surface a
  // graceful message rather than crashing.
  if (!window.L) {
    if (selectedEl) selectedEl.textContent = tr(lang, "locErrMapUnavailable");
    dismissBoot();
    return;
  }

  // Isolate init so a map failure only costs the preview — search, "use my
  // location", and Confirm must still work (they operate on lat/lng).
  try {
    // This WebView leaves the `inset:0` map container at 0 height (verified on
    // device: #map=375x0), so Leaflet would build a 0-tile grid and show
    // nothing. Force an explicit pixel size from the real window dimensions
    // before init, and keep it in sync as the fullscreen viewport settles.
    const mapEl = document.getElementById("map");
    const sizeMapContainer = (): void => {
      if (!mapEl || typeof window.innerWidth !== "number") return;
      mapEl.style.width = `${window.innerWidth}px`;
      mapEl.style.height = `${window.innerHeight}px`;
    };
    sizeMapContainer();

    // Leaflet coordinates are [lat, lng] — the same order as DEFAULT_CENTER.
    map = window.L.map("map", {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: false,
      attributionControl: true,
    });
    // Drop Leaflet's "Leaflet" prefix from the attribution so no library
    // watermark shows — only the required OSM/CARTO credit remains.
    map.attributionControl?.setPrefix?.(false);
    const tiles = window.L.tileLayer(MAP_TILES_URL, {
      attribution: MAP_ATTRIBUTION,
      maxZoom: 20,
    });
    // First painted tile = the map is genuinely showing something, so that is
    // when the loading cover lifts. Deliberately `tileload` (one real tile) and
    // not the layer's `load` (all visible tiles): in this WebView the container
    // can still measure 0×0 at init, which builds a zero-tile grid — `load`
    // would then resolve against nothing and reveal a blank map.
    tiles.once?.("tileload", dismissBoot);
    tiles.addTo(map);

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
    // container) settles a few hundred ms AFTER init. Leaflet builds its tile
    // grid from the container size, so measuring only once at init would request
    // ZERO tiles and stay blank forever. Recompute on every viewport change plus
    // a few staggered ticks so tiles load as soon as the size is real.
    const kickResize = (): void => {
      sizeMapContainer();
      map?.invalidateSize();
    };
    if (typeof window.addEventListener === "function") {
      window.addEventListener("resize", kickResize);
    }
    const tgEvents = app as unknown as
      | { onEvent?: (event: string, cb: () => void) => void }
      | undefined;
    tgEvents?.onEvent?.("viewportChanged", kickResize);
    tgEvents?.onEvent?.("fullscreenChanged", kickResize);
    for (const ms of [120, 400, 800, 1500]) setTimeout(kickResize, ms);
  } catch {
    map = null;
    if (selectedEl) selectedEl.textContent = tr(lang, "locErrMapUnavailable");
    dismissBoot();
  }
}

/** Recentre the map under the pin and label the point in one step. */
function recenter(lat: number, lng: number, address: string | null): void {
  // setView (no animation) is instant and fires `moveend` synchronously
  // (setting a null "custom point"); we then override with the real label
  // below. Leaflet is [lat, lng].
  map?.setView([lat, lng], PICK_ZOOM, { animate: false });
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
  try {
    // Bias the search by the current pin position so "metro" disambiguates to
    // the user's city, not a global hit.
    const center = map ? { lat: selectedLat, lng: selectedLng } : null;
    const hits = await searchLocations(app.initData, query, center);
    renderResults(hits);
  } catch {
    // Soft-fail — searching is supplemental; the user can still pan the map.
    // Don't surface a modal alert that would feel intrusive.
    hideResults();
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
      pickHit(hit);
    });
    resultsEl.appendChild(item);
  }
  resultsEl.classList.add("visible");
}

function hideResults(): void {
  resultsEl?.classList.remove("visible");
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

function pickHit(hit: LocationSearchHit): void {
  if (searchEl) searchEl.value = hit.name;
  originPicked = true;
  hideResults();
  // Dismiss the keyboard so the bottom island (Confirm) slides back in and the
  // map/pin is visible again now that a place has been chosen.
  searchEl?.blur();
  // Compose a human label combining name + short address. The address is often
  // the full street + city; combining gives the bot's confirmation message a
  // stable "[Name], [Address]" shape.
  const label = hit.address ? `${hit.name}, ${hit.address}` : hit.name;
  recenter(hit.lat, hit.lng, label);
  app?.HapticFeedback?.selectionChanged?.();
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
    (document.getElementById("vibe-text") as HTMLTextAreaElement | null)?.focus?.();
    return;
  }
  await saveLocation(lat, lng, address);
}

const EXPERIENCE_IDS: VenueExperience[] = ["conversation", "coffee_treats", "meal_discovery", "walk_view", "art_culture", "drinks_evening", "playful_activity", "surprise_me"];
const AMBIENCE_IDS: VenueAmbience[] = ["quiet", "cozy_public", "lively", "design_forward", "scenic", "romantic_public"];
// Format is presented as a SINGLE choice over the "shape" of the date; the soft
// indoor/outdoor setting is dropped here (its hard form lives in Must-haves as
// required_indoor/outdoor), so the group can't offer contradictory picks.
const FORMAT_DISPLAY_IDS: VenueFormat[] = ["seated", "walking", "interactive"];
const VIBE_ERRORS: Record<Lang, { describe: string; experience: string; relax: string }> = {
  en: { describe: "Please describe the vibe first.", experience: "Choose at least one experience.", relax: "No verified place matches every requirement. Please relax: " },
  ru: { describe: "Сначала опишите вайб.", experience: "Выберите хотя бы один формат встречи.", relax: "Нет проверенного места со всеми условиями. Ослабьте ограничение: " },
  uk: { describe: "Спочатку опишіть вайб.", experience: "Оберіть хоча б один формат зустрічі.", relax: "Немає перевіреного місця з усіма умовами. Послабте обмеження: " },
  de: { describe: "Beschreibe zuerst die Stimmung.", experience: "Wähle mindestens ein Erlebnis.", relax: "Kein geprüfter Ort erfüllt alle Bedingungen. Bitte lockere: " },
  pl: { describe: "Najpierw opisz klimat.", experience: "Wybierz co najmniej jeden rodzaj spotkania.", relax: "Żadne zweryfikowane miejsce nie spełnia wszystkich warunków. Poluzuj: " },
};
const INITIAL_PRICE_NOTE: Record<Lang, string> = {
  en: "The first place is always a quality, comfortable-price option. Premium and exclusive venues are available only through Venue Change.",
  ru: "Первое место всегда подбирается качественным и комфортным по цене. Премиальные и эксклюзивные варианты доступны только через смену места.",
  uk: "Перше місце завжди добирається якісним і комфортним за ціною. Преміальні та ексклюзивні варіанти доступні лише через зміну місця.",
  de: "Der erste Ort ist immer hochwertig und preislich angenehm. Premium- und exklusive Orte gibt es nur über den Ortswechsel.",
  pl: "Pierwsze miejsce jest zawsze dobrej jakości i w komfortowej cenie. Miejsca premium i ekskluzywne są dostępne tylko przy zmianie miejsca.",
};
const LABELS: Record<Lang, Record<string, string>> = {
  en: { conversation: "Easy conversation", coffee_treats: "Coffee & treats", meal_discovery: "Discover food", walk_view: "Walk & views", art_culture: "Art & culture", drinks_evening: "Evening drinks", playful_activity: "Playful activity", surprise_me: "Surprise me", quiet: "Quiet", cozy_public: "Cozy", lively: "Lively", design_forward: "Design-led", scenic: "Scenic", romantic_public: "Romantic", seated: "Seated", walking: "Walking", interactive: "Interactive", indoor: "Indoor", outdoor: "Outdoor", vegan: "Vegan", vegetarian: "Vegetarian", halal: "Halal", kosher: "Kosher", gluten_free: "Gluten-free", alcohol_free: "No alcohol", step_free: "Step-free", required_indoor: "Must be indoors", required_outdoor: "Must be outdoors", free: "Free", inexpensive: "Inexpensive", moderate: "Moderate", max_price: "Maximum price", commute_12_km: "Allow up to 12 km" },
  ru: { conversation: "Спокойно поговорить", coffee_treats: "Кофе и десерт", meal_discovery: "Новая еда", walk_view: "Прогулка и виды", art_culture: "Искусство", drinks_evening: "Вечерние напитки", playful_activity: "Активность", surprise_me: "Удивите меня", quiet: "Тихо", cozy_public: "Уютно", lively: "Живо", design_forward: "Стильный дизайн", scenic: "Красивый вид", romantic_public: "Романтично", seated: "За столиком", walking: "Прогулка", interactive: "Интерактивно", indoor: "В помещении", outdoor: "На улице", vegan: "Веган", vegetarian: "Вегетарианское", halal: "Халяль", kosher: "Кошер", gluten_free: "Без глютена", alcohol_free: "Без алкоголя", step_free: "Без ступеней", required_indoor: "Только в помещении", required_outdoor: "Только на улице", free: "Бесплатно", inexpensive: "Недорого", moderate: "Умеренно", max_price: "Максимальная цена", commute_12_km: "Разрешить до 12 км" },
  uk: { conversation: "Спокійно поговорити", coffee_treats: "Кава й десерт", meal_discovery: "Нова їжа", walk_view: "Прогулянка й краєвиди", art_culture: "Мистецтво", drinks_evening: "Вечірні напої", playful_activity: "Активність", surprise_me: "Здивуйте мене", quiet: "Тихо", cozy_public: "Затишно", lively: "Жваво", design_forward: "Стильний дизайн", scenic: "Гарний краєвид", romantic_public: "Романтично", seated: "За столиком", walking: "Прогулянка", interactive: "Інтерактивно", indoor: "У приміщенні", outdoor: "Надворі", vegan: "Веган", vegetarian: "Вегетаріанське", halal: "Халяль", kosher: "Кошер", gluten_free: "Без глютену", alcohol_free: "Без алкоголю", step_free: "Без сходинок", required_indoor: "Лише в приміщенні", required_outdoor: "Лише надворі", free: "Безкоштовно", inexpensive: "Недорого", moderate: "Помірно", max_price: "Максимальна ціна", commute_12_km: "Дозволити до 12 км" },
  de: { conversation: "Gut reden", coffee_treats: "Kaffee & Süßes", meal_discovery: "Essen entdecken", walk_view: "Spaziergang & Aussicht", art_culture: "Kunst & Kultur", drinks_evening: "Drinks am Abend", playful_activity: "Aktivität", surprise_me: "Überrasch mich", quiet: "Ruhig", cozy_public: "Gemütlich", lively: "Lebhaft", design_forward: "Designorientiert", scenic: "Schöne Aussicht", romantic_public: "Romantisch", seated: "Sitzend", walking: "Spaziergang", interactive: "Interaktiv", indoor: "Drinnen", outdoor: "Draußen", vegan: "Vegan", vegetarian: "Vegetarisch", halal: "Halal", kosher: "Koscher", gluten_free: "Glutenfrei", alcohol_free: "Ohne Alkohol", step_free: "Barrierearm", required_indoor: "Nur drinnen", required_outdoor: "Nur draußen", free: "Kostenlos", inexpensive: "Günstig", moderate: "Moderat", max_price: "Höchstpreis", commute_12_km: "Bis 12 km erlauben" },
  pl: { conversation: "Spokojna rozmowa", coffee_treats: "Kawa i słodkości", meal_discovery: "Odkrywanie jedzenia", walk_view: "Spacer i widoki", art_culture: "Sztuka i kultura", drinks_evening: "Wieczorne drinki", playful_activity: "Aktywność", surprise_me: "Zaskocz mnie", quiet: "Cicho", cozy_public: "Przytulnie", lively: "Żywo", design_forward: "Dobry design", scenic: "Widokowo", romantic_public: "Romantycznie", seated: "Przy stoliku", walking: "Spacer", interactive: "Interaktywnie", indoor: "W środku", outdoor: "Na zewnątrz", vegan: "Wegańskie", vegetarian: "Wegetariańskie", halal: "Halal", kosher: "Koszerne", gluten_free: "Bez glutenu", alcohol_free: "Bez alkoholu", step_free: "Bez schodów", required_indoor: "Tylko wewnątrz", required_outdoor: "Tylko na zewnątrz", free: "Bezpłatnie", inexpensive: "Niedrogo", moderate: "Umiarkowanie", max_price: "Maksymalna cena", commute_12_km: "Zezwól do 12 km" },
};
const label = (id: string): string => LABELS[lang][id] ?? id.replaceAll("_", " ");

/** Localized chrome for the step-2 vibe screen (title, help, group labels, CTAs). */
interface VibeUi {
  step: string;
  title: string;
  help: string;
  placeholder: string;
  continueBtn: string;
  reviewLabel: string;
  confirmBtn: string;
  groupExperience: string;
  groupAtmosphere: string;
  groupFormat: string;
  groupMustHaves: string;
  multiHint: string;
  singleHint: string;
  /** Status beats cycled inside "Continue" while the vibe is interpreted. */
  thinkingSteps: string[];
}
const VIBE_UI: Record<Lang, VibeUi> = {
  en: {
    step: "Step 2 of 2",
    title: "What kind of spot?",
    help: "Describe the vibe of the place — I'll find a real venue to match.",
    placeholder: "e.g. a quiet café to talk · a cozy wine bar · a rooftop with a view · a lively spot with music",
    continueBtn: "Continue",
    reviewLabel: "Here's what I picked up — tap to fine-tune:",
    confirmBtn: "Looks right — find our spot",
    groupExperience: "What we'll do",
    groupAtmosphere: "Atmosphere",
    groupFormat: "Format",
    groupMustHaves: "Must-haves",
    multiHint: "choose any",
    singleHint: "pick one",
    thinkingSteps: ["Reading your vibe…", "Thinking…", "Picking out the details…"],
  },
  ru: {
    step: "Шаг 2 из 2",
    title: "Какое место?",
    help: "Опишите атмосферу заведения — я подберу подходящее.",
    placeholder: "например: тихое кафе, чтобы поговорить · уютный винный бар · крыша с видом · живое место с музыкой",
    continueBtn: "Дальше",
    reviewLabel: "Вот что я уловил — нажмите, чтобы поправить:",
    confirmBtn: "Всё верно — подобрать место",
    groupExperience: "Что делаем",
    groupAtmosphere: "Атмосфера",
    groupFormat: "Формат",
    groupMustHaves: "Обязательно",
    multiHint: "можно несколько",
    singleHint: "выбери одно",
    thinkingSteps: ["Считываю вайб…", "Думаю…", "Выделяю детали…"],
  },
  uk: {
    step: "Крок 2 з 2",
    title: "Яке місце?",
    help: "Опишіть атмосферу закладу — я підберу відповідне.",
    placeholder: "наприклад: тихе кафе, щоб поговорити · затишний винний бар · дах із краєвидом · жваве місце з музикою",
    continueBtn: "Далі",
    reviewLabel: "Ось що я вловив — торкніться, щоб виправити:",
    confirmBtn: "Усе вірно — підібрати місце",
    groupExperience: "Що робимо",
    groupAtmosphere: "Атмосфера",
    groupFormat: "Формат",
    groupMustHaves: "Обов'язково",
    multiHint: "можна кілька",
    singleHint: "обери одне",
    thinkingSteps: ["Зчитую вайб…", "Думаю…", "Виділяю деталі…"],
  },
  de: {
    step: "Schritt 2 von 2",
    title: "Was für ein Ort?",
    help: "Beschreib die Atmosphäre des Orts — ich finde einen passenden.",
    placeholder: "z. B. ruhiges Café zum Reden · gemütliche Weinbar · Dachterrasse mit Aussicht · lebhafter Ort mit Musik",
    continueBtn: "Weiter",
    reviewLabel: "Das habe ich verstanden — zum Anpassen antippen:",
    confirmBtn: "Passt — Ort finden",
    groupExperience: "Was wir machen",
    groupAtmosphere: "Atmosphäre",
    groupFormat: "Format",
    groupMustHaves: "Unverzichtbar",
    multiHint: "mehrere möglich",
    singleHint: "nur eins",
    thinkingSteps: ["Lese deine Stimmung…", "Denke nach…", "Filtere die Details…"],
  },
  pl: {
    step: "Krok 2 z 2",
    title: "Jakie miejsce?",
    help: "Opisz atmosferę miejsca — dobiorę pasujące.",
    placeholder: "np. cicha kawiarnia na rozmowę · przytulny bar winny · dach z widokiem · żywe miejsce z muzyką",
    continueBtn: "Dalej",
    reviewLabel: "Oto, co zrozumiałem — dotknij, aby poprawić:",
    confirmBtn: "Wszystko się zgadza — znajdź miejsce",
    groupExperience: "Co robimy",
    groupAtmosphere: "Atmosfera",
    groupFormat: "Format",
    groupMustHaves: "Obowiązkowo",
    multiHint: "kilka opcji",
    singleHint: "wybierz jedno",
    thinkingSteps: ["Czytam twój klimat…", "Myślę…", "Wyłapuję szczegóły…"],
  },
};

/** Localize the step-2 chrome once when the stage opens. Guarded per element so
 *  a test DOM stub missing an id (or an older bundle) never throws. */
function applyVibeUi(): void {
  const ui = VIBE_UI[lang];
  const setText = (id: string, text: string): void => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const setCta = (btnId: string, text: string): void => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const span = btn.querySelector?.(".cta-text");
    if (span) span.textContent = text;
    else btn.textContent = text;
  };
  setText("vibe-step", ui.step);
  setText("vibe-title", ui.title);
  setText("vibe-help", ui.help);
  setText("vibe-review-label", ui.reviewLabel);
  setText("vibe-label-exp", ui.groupExperience);
  setText("vibe-label-amb", ui.groupAtmosphere);
  setText("vibe-label-fmt", ui.groupFormat);
  setText("vibe-label-must", ui.groupMustHaves);
  // Experience / Atmosphere / Must-haves accept several; Format is one choice.
  setText("vibe-hint-exp", ui.multiHint);
  setText("vibe-hint-amb", ui.multiHint);
  setText("vibe-hint-fmt", ui.singleHint);
  setText("vibe-hint-must", ui.multiHint);
  const ta = document.getElementById("vibe-text") as HTMLTextAreaElement | null;
  if (ta) ta.placeholder = ui.placeholder;
  setCta("vibe-interpret", ui.continueBtn);
  setCta("vibe-confirm", ui.confirmBtn);
}

function showVibeStage(): void {
  const stage = document.getElementById("vibe-stage") as HTMLElement | null;
  if (stage) stage.hidden = false;
  // A restored draft/confirmed intent opens straight on step 2, so the map may
  // never paint a tile — the stage itself is the screen the cover was hiding.
  dismissBoot();
  applyVibeUi();
  const priceNote = document.getElementById("vibe-price-note");
  if (priceNote) priceNote.textContent = INITIAL_PRICE_NOTE[lang];
  // No prefill suggestion chips — the user types their vibe in their own words.
}

function chipButton(text: string, active: boolean, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `vibe-chip${active ? " active" : ""}`;
  button.textContent = text;
  button.addEventListener("click", action);
  return button;
}

function toggleList<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value].slice(0, 3);
}

/** Render one canonical-chip group (experience / ambience / format) into its own
 *  labelled container, so the review reads as structured sections — not one
 *  undifferentiated blob of 19 pills. */
function renderChipGroup(
  containerId: string,
  ids: readonly string[],
  isActive: (id: string) => boolean,
  toggle: (id: string) => void,
): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.replaceChildren(
    ...ids.map((id) =>
      chipButton(label(id), isActive(id), () => {
        toggle(id);
        renderDraft();
      }),
    ),
  );
}

function renderDraft(): void {
  if (!draft) return;
  // Price is owned by the automatic initial-venue policy, not by this user.
  // Clear a restored legacy draft so an invisible old chip cannot affect it.
  draft.hardConstraints.maxPrice = null;
  const text = document.getElementById("vibe-text") as HTMLTextAreaElement | null;
  if (text && !text.value) text.value = draft.rawText;
  const review = document.getElementById("vibe-review") as HTMLElement | null;
  if (review) review.hidden = false;
  // Once the review is open the top "Continue" button is gone for good: the
  // editable description stays for reference, but from here the extracted chips
  // are the only thing tuned and sent, and the final Confirm sits at the bottom
  // — so there is no second interpret button to bring back.
  const interpretBtn = document.getElementById("vibe-interpret") as HTMLElement | null;
  if (interpretBtn) interpretBtn.hidden = true;

  renderChipGroup(
    "vibe-chips-exp",
    EXPERIENCE_IDS,
    (id) => draft!.experiences.includes(id as VenueExperience),
    (id) => {
      draft!.experiences = toggleList(draft!.experiences, id as VenueExperience);
    },
  );
  renderChipGroup(
    "vibe-chips-amb",
    AMBIENCE_IDS,
    (id) => draft!.ambiences.includes(id as VenueAmbience),
    (id) => {
      draft!.ambiences = toggleList(draft!.ambiences, id as VenueAmbience);
    },
  );
  // Format is a SINGLE choice — seated / walking / interactive are the shape of
  // the date and mutually exclusive. Normalize to at most that one shape so what
  // is shown equals what is sent (drops any interpreted indoor/outdoor).
  const fmtActive = FORMAT_DISPLAY_IDS.find((id) => draft!.formats.includes(id)) ?? null;
  draft.formats = fmtActive ? [fmtActive] : [];
  renderChipGroup(
    "vibe-chips-fmt",
    FORMAT_DISPLAY_IDS,
    (id) => draft!.formats[0] === id,
    (id) => {
      draft!.formats = draft!.formats[0] === id ? [] : [id as VenueFormat];
    },
  );

  const constraints = document.getElementById("vibe-constraints");
  // Dietary / alcohol-free / step-free chips were removed 2026-07-30 (founder
  // decision). They were hard filters needing positive evidence on the venue,
  // the catalog had that evidence for 0 of 1207 rows, so each one guaranteed
  // "no place found" and the failure copy then asked the user to relax exactly
  // the requirement they cannot relax. Needs this specific are the person's own
  // to solve — via the venue-change board, or between the two of them on the
  // day. The server neutralises them too (`applyInitialVenueConstraintPolicy`),
  // so a cached bundle still sending them changes nothing.
  const constraintIds = ["required_indoor", "required_outdoor", ...(venueState?.selectionError?.startsWith("no_candidates:commute_12_km:") ? ["commute_12_km"] : [])];
  if (constraints) constraints.replaceChildren(...constraintIds.map((id) => {
    const hard = draft!.hardConstraints;
    const active = id === "required_indoor" ? hard.setting === "indoor" : id === "required_outdoor" ? hard.setting === "outdoor" : hard.maxCommuteKm === 12;
    return chipButton(label(id), active, () => {
      if (id === "required_indoor") hard.setting = hard.setting === "indoor" ? null : "indoor";
      else if (id === "required_outdoor") hard.setting = hard.setting === "outdoor" ? null : "outdoor";
      else if (id === "commute_12_km") hard.maxCommuteKm = hard.maxCommuteKm === 12 ? 8 : 12;
      renderDraft();
    });
  }));
}

/** How long each "thinking" status beat is held inside a busy CTA. */
const CTA_STATUS_STEP_MS = 1600;
/** One vibe-stage request at a time (a second tap while thinking is a no-op). */
let vibeBusy = false;

/**
 * Put a CTA into its "agent is working" state and cycle status beats through its
 * label until the caller stops it.
 *
 * Both vibe-stage CTAs fire a real server round-trip (an LLM interpret pass, then
 * the venue selector), which takes seconds. Before this the button simply sat
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
  const stage = document.getElementById("vibe-stage") as HTMLElement | null;
  if (stage) stage.hidden = true;
});
document.getElementById("vibe-interpret")?.addEventListener("click", async () => {
  if (!app || vibeBusy) return;
  const textArea = document.getElementById("vibe-text") as HTMLTextAreaElement | null;
  const text = textArea?.value.trim() ?? "";
  const error = document.getElementById("vibe-error");
  if (!text) {
    app.HapticFeedback?.notificationOccurred?.("warning");
    if (error) error.textContent = VIBE_ERRORS[lang].describe;
    return;
  }
  // Acknowledge the tap before anything else — the request itself takes seconds.
  app.HapticFeedback?.impactOccurred?.("medium");
  // Dismiss the keyboard so the chips that replace this button are visible the
  // moment they arrive.
  textArea?.blur?.();
  vibeBusy = true;
  const stopThinking = startCtaThinking(
    document.getElementById("vibe-interpret") as HTMLButtonElement,
    VIBE_UI[lang].thinkingSteps,
  );
  try {
    draft = await interpretVenueIntentTma(app.initData, matchId, text, { lat: selectedLat, lng: selectedLng, address: selectedAddress });
    if (error) error.textContent = "";
    stopThinking();
    // renderDraft() hides this button for good and reveals the chips.
    renderDraft();
    app.HapticFeedback?.notificationOccurred?.("success");
  } catch {
    stopThinking();
    app.HapticFeedback?.notificationOccurred?.("error");
    if (error) error.textContent = tr(lang, "errNetwork");
  } finally {
    vibeBusy = false;
  }
});
/**
 * Final confirm — hand off to the chat and get out of the way.
 *
 * The server persists the confirmation and runs the venue selector in the
 * BACKGROUND (`awaitFinalization: false`), so this call returns in
 * milliseconds. Deliberately NO thinking status here: the concierge narrates
 * the search with its own shimmer in the Telegram chat and then drops the date
 * card, which is where that moment belongs — a Mini App idling on a spinner for
 * the whole selection is exactly what we're removing.
 *
 * A "no eligible venue" outcome is therefore also a chat event now (the
 * concierge DMs the affected side to reopen this screen and relax one
 * condition, which restores the draft plus the relax chip). We never re-render
 * a relax hint off this response — with the selector still running its
 * `selectionError` is whatever the PREVIOUS attempt left behind, so trusting it
 * would strand the user on a stale error instead of closing.
 */
document.getElementById("vibe-confirm")?.addEventListener("click", async () => {
  if (!app || !draft || vibeBusy) return;
  const error = document.getElementById("vibe-error");
  if (draft.experiences.length === 0) {
    app.HapticFeedback?.notificationOccurred?.("warning");
    if (error) error.textContent = VIBE_ERRORS[lang].experience;
    return;
  }
  app.HapticFeedback?.impactOccurred?.("medium");
  vibeBusy = true;
  const confirmBtn = document.getElementById("vibe-confirm") as HTMLButtonElement | null;
  if (confirmBtn) confirmBtn.disabled = true;
  try {
    venueState = await confirmVenueIntentTma(app.initData, matchId, {
      experiences: draft.experiences, ambiences: draft.ambiences, formats: draft.formats,
      hardConstraints: draft.hardConstraints,
      origin: { lat: selectedLat, lng: selectedLng, address: selectedAddress },
    });
    app.HapticFeedback?.notificationOccurred?.("success");
    // Brief beat so the success haptic registers before Telegram dismisses.
    setTimeout(() => app.close(), 200);
  } catch {
    if (confirmBtn) confirmBtn.disabled = false;
    app.HapticFeedback?.notificationOccurred?.("error");
    if (error) error.textContent = tr(lang, "errNetwork");
  } finally {
    vibeBusy = false;
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
