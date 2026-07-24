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
  type VenueDietary,
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

let map: L.Map | null = null;
let selectedLat: number = DEFAULT_CENTER[0];
let selectedLng: number = DEFAULT_CENTER[1];
let selectedAddress: string | null = null;
let confirming = false;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let venueState: VenueIntentTmaState | null = null;
let draft: VenueIntentDraft | null = null;
// Venue Intent V2: the Location Mini App owns the WHOLE two-step flow again —
// origin (the map) then the vibe + canonical chips on the in-app "step 2" screen
// (2026-07: reverted from the short-lived chat-chip presentation because inline
// Telegram buttons can't carry the brand's liquid-glass design). On reopen, if a
// draft (or a confirmed-but-no_candidates intent needing relaxation) already
// exists, jump straight back to the vibe stage so the user doesn't re-pick their
// origin. Applies to every mode; shadow/off simply never create an in-app draft.
if (matchId && app) {
  void fetchVenueIntentState(app.initData, matchId)
    .then((state) => {
      venueState = state;
      if (
        state.intent?.state === "draft" ||
        (state.intent?.state === "confirmed" && state.selectionError?.startsWith("no_candidates:"))
      ) {
        draft = state.intent;
        if (draft.origin) {
          selectedLat = draft.origin.lat;
          selectedLng = draft.origin.lng;
          selectedAddress = draft.origin.address;
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
  recenter(lat, lng, label);
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
const DIET_IDS: VenueDietary[] = ["vegan", "vegetarian", "halal", "kosher", "gluten_free"];
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
  const constraintIds = [...DIET_IDS, "alcohol_free", "step_free", "required_indoor", "required_outdoor", ...(venueState?.selectionError?.startsWith("no_candidates:commute_12_km:") ? ["commute_12_km"] : [])];
  if (constraints) constraints.replaceChildren(...constraintIds.map((id) => {
    const hard = draft!.hardConstraints;
    const active = DIET_IDS.includes(id as VenueDietary) ? hard.dietary.includes(id as VenueDietary) : id === "alcohol_free" ? hard.alcoholFree : id === "step_free" ? hard.stepFree : id === "required_indoor" ? hard.setting === "indoor" : id === "required_outdoor" ? hard.setting === "outdoor" : hard.maxCommuteKm === 12;
    return chipButton(label(id), active, () => {
      if (DIET_IDS.includes(id as VenueDietary)) hard.dietary = toggleList(hard.dietary, id as VenueDietary);
      else if (id === "alcohol_free") hard.alcoholFree = !hard.alcoholFree;
      else if (id === "step_free") hard.stepFree = !hard.stepFree;
      else if (id === "required_indoor") hard.setting = hard.setting === "indoor" ? null : "indoor";
      else if (id === "required_outdoor") hard.setting = hard.setting === "outdoor" ? null : "outdoor";
      else if (id === "commute_12_km") hard.maxCommuteKm = hard.maxCommuteKm === 12 ? 8 : 12;
      renderDraft();
    });
  }));
}

document.getElementById("vibe-back")?.addEventListener("click", () => {
  const stage = document.getElementById("vibe-stage") as HTMLElement | null;
  if (stage) stage.hidden = true;
});
document.getElementById("vibe-interpret")?.addEventListener("click", async () => {
  if (!app) return;
  const text = (document.getElementById("vibe-text") as HTMLTextAreaElement | null)?.value.trim() ?? "";
  const error = document.getElementById("vibe-error");
  if (!text) { if (error) error.textContent = VIBE_ERRORS[lang].describe; return; }
  try {
    draft = await interpretVenueIntentTma(app.initData, matchId, text, { lat: selectedLat, lng: selectedLng, address: selectedAddress });
    if (error) error.textContent = "";
    renderDraft();
  } catch { if (error) error.textContent = tr(lang, "errNetwork"); }
});
document.getElementById("vibe-confirm")?.addEventListener("click", async () => {
  if (!app || !draft) return;
  const error = document.getElementById("vibe-error");
  if (draft.experiences.length === 0) { if (error) error.textContent = VIBE_ERRORS[lang].experience; return; }
  try {
    venueState = await confirmVenueIntentTma(app.initData, matchId, {
      experiences: draft.experiences, ambiences: draft.ambiences, formats: draft.formats,
      hardConstraints: draft.hardConstraints,
      origin: { lat: selectedLat, lng: selectedLng, address: selectedAddress },
    });
    if (venueState.selectionError?.startsWith("no_candidates:")) {
      draft = venueState.intent;
      renderDraft();
      if (error) error.textContent = VIBE_ERRORS[lang].relax + label(venueState.selectionError.split(":")[1] ?? "");
      return;
    }
    app.HapticFeedback?.notificationOccurred?.("success");
    setTimeout(() => app.close(), 250);
  } catch { if (error) error.textContent = tr(lang, "errNetwork"); }
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
