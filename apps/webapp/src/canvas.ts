/**
 * The Living Canvas — a dark map of the city with one sheet on it
 * (PRODUCT_SPEC §6.1).
 *
 * This file is the wiring and nothing else: the decisions live in
 * `canvas/sheet.ts` (what a state says), `canvas/poll.ts` (how often to ask)
 * and `canvas/shake.ts` (what a shake is), all pure and all tested without a
 * browser. What is left here is the DOM, Leaflet, and the two permission
 * dances the platform forces on us.
 *
 * Deliberately NOT here: the Scratch Map's fog. That layer has no data until
 * §6.4 ships, and a fully-fogged map is strictly worse than no fog at all —
 * it would hide the city the canvas exists to show. It lands with its own
 * endpoint rather than as an empty layer waiting for one.
 */

import "./theme.css";
import "./canvas.css";
import { isLang, stringsFor, type Lang } from "./canvas/i18n.js";
import { isCanvasState, sheetFor, type CanvasState, type RadarReading } from "./canvas/sheet.js";
import { backoffFor, pollIntervalFor } from "./canvas/poll.js";
import { createShakeDetector, requestMotionPermission } from "./canvas/shake.js";
import {
  fetchDateState,
  postBump,
  postProximity,
  type DateStateResponse,
} from "./canvas/api.js";

const KYIV: [number, number] = [50.4501, 30.5234];
const MAP_ZOOM = 13;
const VENUE_ZOOM = 16;
const MAP_TILES_URL = `${(import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "")}/v1/maptiles/{z}/{x}/{y}`;
const MAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
/**
 * Floor under the boot cover. It normally lifts on the first painted tile;
 * this is what stops a tile-proxy outage trapping the user behind a loader
 * that will never finish — the same rule the Location Mini App follows.
 */
const BOOT_REVEAL_MAX_MS = 2500;
const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 30_000,
};

const app = window.Telegram?.WebApp;
app?.ready();
app?.expand();

const params = new URLSearchParams(location.search);
const langParam = params.get("lang") ?? app?.initDataUnsafe?.user?.language_code ?? null;
const lang: Lang = isLang(langParam) ? langParam : "en";
const s = stringsFor(lang);
const initData = app?.initData ?? "";

const el = {
  boot: document.getElementById("boot"),
  map: document.getElementById("map"),
  title: document.getElementById("sheet-title"),
  body: document.getElementById("sheet-body"),
  note: document.getElementById("sheet-note"),
  list: document.getElementById("sheet-list"),
  action: document.getElementById("sheet-action") as HTMLButtonElement | null,
  sheet: document.getElementById("sheet"),
};

let map: L.Map | null = null;
let venueMarker: L.Marker | null = null;
let bootDismissed = false;
let pollTimer: number | null = null;
let failures = 0;
let latest: DateStateResponse | null = null;
let radar: RadarReading | null = null;
let motionBound = false;
let motionDenied = false;
const detector = createShakeDetector();

function dismissBoot(): void {
  if (bootDismissed || !el.boot) return;
  bootDismissed = true;
  el.boot.classList.add("gone");
  window.setTimeout(() => el.boot?.remove(), 400);
}

function haptic(style: "light" | "rigid" | "success"): void {
  const h = app?.HapticFeedback;
  if (!h) return;
  try {
    if (style === "success") h.notificationOccurred?.("success");
    else h.impactOccurred?.(style);
  } catch {
    // Older clients expose a partial HapticFeedback object. A missing buzz is
    // never worth an exception on a screen that is otherwise fine.
  }
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function initMap(): void {
  if (!window.L || !el.map) {
    // No Leaflet (the CDN is unreachable) is not a dead screen: the sheet is
    // the product here and the map is its backdrop, so we drop the cover and
    // let the sheet render over the page's own background.
    dismissBoot();
    return;
  }

  const sizeMap = (): void => {
    if (!el.map) return;
    el.map.style.width = `${window.innerWidth}px`;
    el.map.style.height = `${window.innerHeight}px`;
  };
  sizeMap();

  map = window.L.map("map", {
    center: KYIV,
    zoom: MAP_ZOOM,
    zoomControl: false,
    attributionControl: true,
  });
  map.attributionControl?.setPrefix?.(false);

  const tiles = window.L.tileLayer(MAP_TILES_URL, {
    attribution: MAP_ATTRIBUTION,
    maxZoom: 20,
  });
  // One real tile, not the layer's `load`: Telegram settles this WebView's
  // viewport a few hundred ms after init, so the container can measure 0×0 and
  // build a zero-tile grid — `load` would then resolve against nothing.
  tiles.once?.("tileload", dismissBoot);
  tiles.addTo(map);

  const kick = (): void => {
    sizeMap();
    map?.invalidateSize();
  };
  window.addEventListener("resize", kick);
  app?.onEvent?.("viewportChanged", kick);
  [120, 350, 800].forEach((ms) => window.setTimeout(kick, ms));
}

function showVenue(lat: number, lng: number): void {
  if (!map || !window.L) return;
  if (!venueMarker) {
    venueMarker = window.L.marker([lat, lng], {
      icon: window.L.divIcon({
        className: "venue-pin",
        html: '<span class="venue-pulse"></span><span class="venue-dot"></span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
    }).addTo(map);
    map.setView([lat, lng], VENUE_ZOOM);
  } else {
    venueMarker.setLatLng([lat, lng]);
  }
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

function render(): void {
  if (!latest || !el.title || !el.body || !el.action) return;

  const match = latest.match;
  const view = sheetFor({
    state: latest.state,
    lang,
    serverNow: new Date(latest.serverNow),
    nextDropAt: latest.nextDropAt ? new Date(latest.nextDropAt) : null,
    agreedTime: match?.agreedTime ? new Date(match.agreedTime) : null,
    venueName: match?.venue?.name ?? null,
    bumpMine: match?.bump?.mine ?? false,
    bumpVerified: match?.bump?.verified ?? false,
    // Read from the state, never from the bump response: that one carries BOTH
    // sides' halves and the client is not told which side it is, so it could
    // only guess. `/v1/date/state` resolves the side on the server.
    deck: match?.deck ?? [],
    radar,
  });

  el.title.textContent = view.title;
  el.body.textContent = motionDenied && view.action === "shake" ? s.bumpDenied : view.body;
  el.sheet?.setAttribute("data-tone", view.tone);

  if (el.note) {
    el.note.textContent = view.note ?? "";
    el.note.hidden = !view.note;
  }
  if (el.list) {
    el.list.replaceChildren(
      ...(view.list ?? []).map((line) => {
        const li = document.createElement("li");
        li.textContent = line;
        return li;
      }),
    );
    el.list.hidden = !view.list?.length;
  }

  el.action.hidden = view.action === null;
  el.action.textContent = view.actionLabel ?? "";
  el.action.dataset.action = view.action ?? "";
}

el.action?.addEventListener("click", () => {
  const action = el.action?.dataset.action;
  if (action === "chat") {
    haptic("light");
    // The flows this points at live in the bot, so the honest action is to
    // hand the user back to it rather than rebuild an accept button here.
    app?.close?.();
    return;
  }
  if (action === "shake") void armShake();
});

// ---------------------------------------------------------------------------
// Bump
// ---------------------------------------------------------------------------

async function armShake(): Promise<void> {
  const verdict = await requestMotionPermission(
    (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<"granted" | "denied"> } })
      .DeviceMotionEvent,
  );
  if (verdict !== "granted") {
    // "unsupported" and "denied" read the same to the user here — either way
    // this phone will not produce a shake — but they are kept apart at the
    // source so a later surface can tell them apart.
    motionDenied = true;
    render();
    return;
  }
  motionDenied = false;
  if (motionBound) return;
  motionBound = true;
  detector.reset();
  window.addEventListener("devicemotion", onMotion);
  haptic("light");
}

function onMotion(event: DeviceMotionEvent): void {
  const a = event.accelerationIncludingGravity;
  if (!a) return;
  const shook = detector.feed({ x: a.x, y: a.y, z: a.z, at: Date.now() });
  if (shook) void sendBump();
}

async function sendBump(): Promise<void> {
  const matchId = latest?.match?.id;
  if (!matchId) return;
  const here = await currentPosition();
  if (!here) return;
  haptic("rigid");
  try {
    const res = await postBump(initData, matchId, { ...here, when: new Date() });
    if (res.verified) haptic("success");
    // Whatever the server says, re-reading the state is what updates the
    // sheet — the response is about this call, the sheet is about the pair.
    await tick();
  } catch {
    // A refused bump (too early, too far) is not worth an error screen: the
    // sheet already describes the state, and the next poll re-reads it.
  }
}

// ---------------------------------------------------------------------------
// Radar
// ---------------------------------------------------------------------------

async function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  if (!navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      GEO_OPTIONS,
    );
  });
}

async function pingRadar(): Promise<void> {
  const matchId = latest?.match?.id;
  if (!matchId) return;
  const here = await currentPosition();
  if (!here) return;
  try {
    const res = await postProximity(initData, matchId, here);
    const wasBoth = radar?.bothArrived ?? false;
    radar = {
      peer: res.peer,
      ...(res.peerEtaLocal ? { peerEtaLocal: res.peerEtaLocal } : {}),
      bothArrived: res.bothArrived,
    };
    // The one celebratory beat, and only on the edge into it — a haptic on
    // every poll while both stand at the venue would be a buzzing phone.
    if (radar.bothArrived && !wasBoth) haptic("success");
    render();
  } catch {
    // Outside the window, or the network. The sheet keeps its last reading
    // until the presence TTL makes the server answer `unknown` anyway.
  }
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

function schedule(ms: number): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => void tick(), ms);
}

async function tick(): Promise<void> {
  try {
    const next = await fetchDateState(initData);
    failures = 0;
    latest = isCanvasState(next.state) ? next : { ...next, state: "IDLE_EXPLORING" as CanvasState };

    const venue = latest.match?.venue;
    if (venue?.lat != null && venue.lng != null) showVenue(venue.lat, venue.lng);

    if (latest.state !== "DATE_RADAR_ACTIVE") radar = null;
    render();
    dismissBoot();

    if (latest.state === "DATE_RADAR_ACTIVE") void pingRadar();
    if (latest.state === "DATE_BUMP_PENDING" && !latest.match?.bump?.mine) void armShake();
    if (latest.state !== "DATE_BUMP_PENDING" && motionBound) {
      window.removeEventListener("devicemotion", onMotion);
      motionBound = false;
    }

    schedule(pollIntervalFor(latest.state));
  } catch {
    failures += 1;
    if (!latest && el.body) el.body.textContent = s.offline;
    dismissBoot();
    schedule(backoffFor(failures));
  }
}

window.setTimeout(dismissBoot, BOOT_REVEAL_MAX_MS);
initMap();
void tick();
