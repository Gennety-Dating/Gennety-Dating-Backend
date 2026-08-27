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
 * The Scratch Map's fog is here now that it has an endpoint to fill it
 * (§Scratch Map). It is drawn only once tiles have actually arrived: a
 * fully-fogged map with no data hides the city the canvas exists to show and
 * looks exactly like a bug.
 */

import "./theme.css";
import "./canvas.css";
import { isLang, stringsFor, type Lang } from "./canvas/i18n.js";
import { isCanvasState, sheetFor, type CanvasState, type RadarReading } from "./canvas/sheet.js";
import { backoffFor, pollIntervalFor } from "./canvas/poll.js";
import { createShakeDetector, requestMotionPermission } from "./canvas/shake.js";
import {
  fetchDateState,
  fetchScratchMap,
  postBump,
  postProximity,
  postScratchPing,
  type DateStateResponse,
  type ScratchState,
} from "./canvas/api.js";
import { fogPath, formatExplored } from "./canvas/fog.js";

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
/**
 * A bump needs TWO permissions, and only one of them used to be explained.
 * `currentPosition()` returning null just dropped the shake, so a user with
 * location denied shook the phone at the table and nothing happened at all —
 * no message, no haptic, no state change — under a sheet still telling them to
 * shake. Same treatment as `motionDenied`, one line up.
 */
let geoDenied = false;
let scratch: ScratchState | null = null;
let fogLayer: SVGSVGElement | null = null;
const detector = createShakeDetector();

function dismissBoot(): void {
  if (bootDismissed || !el.boot) return;
  bootDismissed = true;
  el.boot.classList.add("gone");
  window.setTimeout(() => el.boot?.remove(), 400);
}

function haptic(style: "light" | "rigid" | "success" | "error"): void {
  const h = app?.HapticFeedback;
  if (!h) return;
  try {
    if (style === "success" || style === "error") h.notificationOccurred?.(style);
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
    renderFog();
  };
  // The veil is drawn in container pixels, so every pan and zoom moves it.
  // `move`/`zoom` rather than their `*end` twins: waiting for the gesture to
  // finish would leave the holes visibly lagging the city under them.
  map.on?.("move", renderFog);
  map.on?.("zoom", renderFog);
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
// Fog of war
// ---------------------------------------------------------------------------

/**
 * Redraw the veil.
 *
 * An SVG overlay rather than a Leaflet layer: the whole thing is ONE path with
 * one hole per tile, and even-odd fill cuts them out in a single composite.
 * A layer of N rectangles would seam visibly where two uncovered tiles touch,
 * which is the common case — people walk through adjacent tiles.
 */
function renderFog(): void {
  if (!map || !window.L || !el.map) return;
  const tiles = scratch?.exploredTiles ?? [];

  const project = map.latLngToContainerPoint;
  // Without a projection there is no fog to draw, and a veil positioned by
  // guesswork would sit over the wrong streets — worse than none.
  if (!project) return;

  const size = map.getSize?.() ?? { x: el.map.clientWidth, y: el.map.clientHeight };
  const path = fogPath(tiles, {
    width: size.x,
    height: size.y,
    project: (lat, lng) => project.call(map!, [lat, lng]),
  });

  if (!path) {
    fogLayer?.remove();
    fogLayer = null;
    return;
  }

  if (!fogLayer) {
    fogLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    fogLayer.setAttribute("class", "fog");
    fogLayer.setAttribute("aria-hidden", "true");
    el.map.appendChild(fogLayer);
  }
  fogLayer.setAttribute("width", String(size.x));
  fogLayer.setAttribute("height", String(size.y));
  fogLayer.innerHTML =
    `<path d="${path}" fill-rule="evenodd" class="fog-veil" />`;
}

async function loadScratchMap(): Promise<void> {
  try {
    scratch = await fetchScratchMap(initData);
    renderFog();
  } catch {
    // No fog beats wrong fog: without the tiles the map is simply the map.
  }
}

async function pingScratch(): Promise<void> {
  if (!scratch?.optIn) return;
  const here = await currentPosition();
  if (!here) return;
  try {
    const res = await postScratchPing(initData, here);
    scratch = res;
    // Only a ping that actually uncovered ground is worth redrawing for, and
    // only that one is worth a haptic: the map does not celebrate standing
    // still.
    if (res.uncovered) {
      haptic("light");
      renderFog();
      render();
    }
  } catch {
    // Opted out mid-session, or outside the market. Neither is an error the
    // screen should shout about.
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
    // Its own clock: a `proposed` match has no agreed time yet, and this is
    // the one state whose deadline is running.
    deadlineAt: match?.deadlineAt ? new Date(match.deadlineAt) : null,
    venueName: match?.venue?.name ?? null,
    bumpMine: match?.bump?.mine ?? false,
    bumpVerified: match?.bump?.verified ?? false,
    // Read from the state, never from the bump response: that one carries BOTH
    // sides' halves and the client is not told which side it is, so it could
    // only guess. `/v1/date/state` resolves the side on the server.
    deck: match?.deck ?? [],
    // Only once something has actually been uncovered: "0%" on a fresh
    // account is a feature announcing that it has nothing to show.
    ...(scratch?.optIn && scratch.exploredPercent > 0
      ? { exploredLabel: formatExplored(scratch.exploredPercent) }
      : {}),
    radar,
  });

  el.title.textContent = view.title;
  el.body.textContent =
    view.action === "shake"
      ? motionDenied
        ? s.bumpDenied
        : geoDenied
          ? s.bumpNoLocation
          : view.body
      : view.body;
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
  if (!here) {
    // Say so rather than swallowing the shake — see `geoDenied`.
    geoDenied = true;
    haptic("error");
    render();
    return;
  }
  geoDenied = false;
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

    // The scratch map fills while the canvas is being used AS a map — the
    // states where the screen is about a date have something better to do with
    // the user's attention and their battery.
    if (latest.state === "IDLE_EXPLORING") void pingScratch();
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
void loadScratchMap();
void tick();
