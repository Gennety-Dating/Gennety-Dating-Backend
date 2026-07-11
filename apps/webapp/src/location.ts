import "./location.css";
import {
  apiBase,
  searchLocations,
  selectLocation,
  CalendarApiError,
  type LocationSearchHit,
} from "./api.js";
import { pickLang, tr, type Lang } from "./i18n.js";
import { wireContentInsets } from "./telegram-insets.js";

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

const app = window.Telegram?.WebApp;
app?.ready();
app?.expand();

// Bot API 8.0+ — immersive fullscreen so the map fills the screen edge-to-edge.
// Older clients silently fall through to expand().
const chromeColor =
  document.documentElement.dataset.theme === "light" ? "#f5f5f5" : "#030303";
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

let map: L.Map | null = null;
let selectedLat: number = DEFAULT_CENTER[0];
let selectedLng: number = DEFAULT_CENTER[1];
let selectedAddress: string | null = null;
let confirming = false;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

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
}

function initMap(): void {
  // Leaflet is loaded from a `<script>` tag in location.html — global `L`. If
  // for any reason it didn't load (offline tunnel during dev), surface a
  // graceful message rather than crashing.
  if (!window.L) {
    if (selectedEl) selectedEl.textContent = tr(lang, "locErrMapUnavailable");
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
    window.L.tileLayer(MAP_TILES_URL, {
      attribution: MAP_ATTRIBUTION,
      maxZoom: 20,
    }).addTo(map);

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

function pickHit(hit: LocationSearchHit): void {
  if (searchEl) searchEl.value = hit.name;
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
  startSaving(false);
  await saveLocation(selectedLat, selectedLng, selectedAddress);
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
  recenter(lat, lng, label);
  await saveLocation(lat, lng, label);
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
