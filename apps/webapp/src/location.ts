import {
  searchLocations,
  selectLocation,
  CalendarApiError,
  type LocationSearchHit,
} from "./api.js";
import { pickLang, tr, type Lang } from "./i18n.js";

/**
 * Location Mini App entry point (Phase 3.7 — concierge venue, map picker).
 *
 * UX:
 *   1. User opens via the bot's `web_app` inline button. URL carries
 *      `?match=<id>&lang=<en|ru|uk|de|pl>` (start_param fallback for inline mode).
 *   2. Map (Leaflet + OSM tiles) opens centred on Kyiv (default city — we
 *      don't have the user's prior coords yet at first open). Marker is
 *      dropped at the centre as a draggable starting point.
 *   3. User can:
 *      - Type a query → debounced `GET /v1/location/search` → dropdown
 *        of up to 8 hits. Tap one → map jumps + marker drops there.
 *      - Tap on the map → marker drops at that point. No reverse
 *        geocode — we just label it "Custom point".
 *      - Drag the marker → updates lat/lng silently.
 *   4. The Telegram MainButton ("Confirm") POSTs `lat/lng + address` to
 *      `/v1/location/select`, which writes vibeLat/Lng/Address on the
 *      match and triggers `tryFinalize`. App closes on success.
 *
 * No reverse-geocode on free-form taps to keep this v1 narrow — we don't
 * need a separate Geocoding API enabled, and the venue searcher works
 * off lat/lng anyway.
 */

const DEFAULT_CENTER: [number, number] = [50.4501, 30.5234]; // Kyiv center
const DEFAULT_ZOOM = 13;
const SEARCH_DEBOUNCE_MS = 350;
const MIN_QUERY_LEN = 2;

const app = window.Telegram?.WebApp;
app?.ready();
app?.expand();

const params = new URLSearchParams(location.search);
const matchId = app?.initDataUnsafe?.start_param ?? params.get("match") ?? "";
const lang: Lang = pickLang(params.get("lang"));

const titleEl = document.getElementById("title");
const searchEl = document.getElementById("search") as HTMLInputElement | null;
const resultsEl = document.getElementById("results");
const selectedEl = document.getElementById("selected");
const emptyHintEl = document.getElementById("empty-hint");
const noContextEl = document.getElementById("no-context");

let map: L.Map | null = null;
let marker: L.Marker | null = null;
let selectedLat: number = DEFAULT_CENTER[0];
let selectedLng: number = DEFAULT_CENTER[1];
let selectedAddress: string | null = null;
let confirming = false;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

if (titleEl) titleEl.textContent = tr(lang, "locTitle");
if (searchEl) searchEl.placeholder = tr(lang, "locSearchPlaceholder");
if (emptyHintEl) emptyHintEl.textContent = tr(lang, "locEmptyHint");

if (!matchId) {
  showNoContext();
} else {
  initMap();
  initSearch();
  if (app) {
    app.MainButton.setText(tr(lang, "locConfirm"));
    app.MainButton.onClick(handleConfirm);
    app.MainButton.show();
    app.MainButton.enable();
  }
}

function showNoContext(): void {
  if (noContextEl) {
    noContextEl.style.display = "block";
    noContextEl.textContent = tr(lang, "noContext");
  }
  const appEl = document.getElementById("app");
  if (appEl) appEl.style.display = "none";
}

function initMap(): void {
  // Leaflet is loaded from a `<script>` tag in location.html — global `L`.
  // If for any reason it didn't load (offline tunnel during dev), surface
  // a graceful error rather than crashing.
  if (!window.L) {
    if (selectedEl) selectedEl.textContent = "Map library failed to load.";
    return;
  }

  map = window.L.map("map", {
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: true,
    attributionControl: true,
  });
  window.L
    .tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
      maxZoom: 19,
    })
    .addTo(map);

  marker = window.L
    .marker(DEFAULT_CENTER, { draggable: true, autoPan: true })
    .addTo(map);

  marker.on("dragend", (e) => {
    const ll = e.target.getLatLng();
    setSelected(ll.lat, ll.lng, null);
  });

  map.on("click", (e) => {
    if (!marker) return;
    marker.setLatLng(e.latlng);
    setSelected(e.latlng.lat, e.latlng.lng, null);
  });

  setSelected(DEFAULT_CENTER[0], DEFAULT_CENTER[1], null);
  // Ensure tiles render correctly inside flexbox after layout settles.
  setTimeout(() => map?.invalidateSize(), 50);
}

function setSelected(lat: number, lng: number, address: string | null): void {
  selectedLat = lat;
  selectedLng = lng;
  selectedAddress = address;
  renderSelectedLine();
}

function renderSelectedLine(): void {
  if (!selectedEl) return;
  const labelHtml = selectedAddress
    ? `<strong>${escapeHtml(selectedAddress)}</strong>`
    : `${escapeHtml(tr(lang, "locCustomPoint"))} <span>(${selectedLat.toFixed(4)}, ${selectedLng.toFixed(4)})</span>`;
  selectedEl.innerHTML = `${escapeHtml(tr(lang, "locSelectedPrefix"))}${labelHtml}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    // Bias the search by current map center so "metro" disambiguates
    // to the user's city, not a global hit.
    const center = map ? { lat: selectedLat, lng: selectedLng } : null;
    const hits = await searchLocations(app.initData, query, center);
    renderResults(hits);
  } catch {
    // Soft-fail — searching is supplemental; the user can still tap
    // on the map. Don't surface a modal alert that would feel intrusive.
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

function pickHit(hit: LocationSearchHit): void {
  if (searchEl) searchEl.value = hit.name;
  hideResults();
  if (map && marker) {
    map.setView([hit.lat, hit.lng], 15);
    marker.setLatLng([hit.lat, hit.lng]);
  }
  // Compose a human label combining name + short address. The address
  // is often the full street + city; combining gives the bot's
  // confirmation message a stable "[Name], [Address]" shape.
  const label = hit.address ? `${hit.name}, ${hit.address}` : hit.name;
  setSelected(hit.lat, hit.lng, label);
  app?.HapticFeedback?.selectionChanged?.();
}

async function handleConfirm(): Promise<void> {
  if (!app || confirming) return;
  if (!Number.isFinite(selectedLat) || !Number.isFinite(selectedLng)) {
    app.showAlert(tr(lang, "locErrInvalidCoords"));
    return;
  }
  confirming = true;
  app.MainButton.setText(tr(lang, "locConfirming"));
  app.MainButton.showProgress();
  app.MainButton.disable();
  try {
    await selectLocation(
      app.initData,
      matchId,
      selectedLat,
      selectedLng,
      selectedAddress,
    );
    app.HapticFeedback?.notificationOccurred?.("success");
    if (selectedEl) selectedEl.textContent = tr(lang, "locSaved");
    // Brief flash so the user perceives the success before the app
    // closes itself — without it Telegram dismisses too fast on iOS.
    setTimeout(() => app.close(), 350);
  } catch (err) {
    confirming = false;
    app.MainButton.hideProgress();
    app.MainButton.enable();
    app.MainButton.setText(tr(lang, "locConfirm"));
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
