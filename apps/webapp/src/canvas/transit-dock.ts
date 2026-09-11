/**
 * The transit dock — how the canvas gets someone from "your date is at 19:00"
 * into a car or onto a route (decision 2026-09-11). Two glass islands sitting
 * on the sheet, the shape of Bump's transit HUD: a control pill (on foot / by
 * car, Uber, the phone's maps app) over a status card ("9 min by car" /
 * "You're 2.4 km away").
 *
 * This file is the DOM, the GPS watch and the taps. When the dock may show and
 * what its numbers are live in `transit.ts`; what its links carry lives in
 * `deep-links.ts` — both pure and tested without a browser.
 *
 * The position never leaves this closure. It is read while the dock can show,
 * turned into a distance and a number of minutes, and dropped with the watch —
 * no request carries it, and the links name the venue alone.
 */

import { distanceMeters, formatDistance } from "../date-terminal/terminal-state.js";
import {
  MAPS_APP_NAME,
  mapsAppFor,
  mapsLink,
  openExternal,
  uberLink,
  type Destination,
  type TravelMode,
} from "../deep-links.js";
import { icon } from "../icons.js";
import type { CanvasStrings, Lang } from "./i18n.js";
import type { CanvasState } from "./sheet.js";
import {
  defaultModeFor,
  dockPresenceFor,
  dockShown,
  etaMinutes,
  formatTravelTime,
  type DockPresence,
} from "./transit.js";

export interface TransitDock {
  /** A fresh `/v1/date/state`. Returns the presence, so the caller can dress the pin. */
  update(state: CanvasState, venue: Destination | null): DockPresence;
  /** The venue pin was tapped. */
  summon(): void;
  /** The map around the pin was tapped. */
  dismiss(): void;
}

type GeoStatus = "idle" | "locating" | "fixed" | "denied" | "unavailable";

/**
 * A watch rather than the radar's one-off reads: the distance is the thing on
 * this card that changes while the user walks, and a number that moves only
 * once a poll reads as a frozen one.
 */
const GEO_WATCH: PositionOptions = { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 };

/** MIRRORS the `+ 10px` in canvas.css `#transit-dock { bottom }` — the gap over the sheet. */
const GAP_OVER_SHEET_PX = 10;

export function createTransitDock(options: {
  sheet: HTMLElement | null;
  strings: CanvasStrings;
  lang: Lang;
  app: TelegramWebApp | undefined;
  uberClientId: string | null;
  /**
   * How much of the screen's bottom the dock and the sheet under it now cover —
   * 0 while the dock is down — so the map can keep the venue in what is left.
   * Called on a change only.
   */
  onLayout?: (coveredPx: number) => void;
}): TransitDock {
  const { sheet, strings: s, lang, app, uberClientId, onLayout } = options;
  // Decided once: a phone does not change its maps app while a page is open.
  const mapsApp = mapsAppFor(app?.platform, navigator.userAgent);
  const mapsName = MAPS_APP_NAME[mapsApp];

  let presence: DockPresence = "off";
  let venue: Destination | null = null;
  let summoned = false;
  /** The user's own pick. Once made it holds, whatever the distance does next. */
  let chosenMode: TravelMode | null = null;
  /**
   * The guess from the first fix, made once per venue. Guessing again on every
   * fix would flip the toggle under someone walking across the 2 km line.
   */
  let guessedMode: TravelMode | null = null;
  let fix: { lat: number; lng: number } | null = null;
  let geo: GeoStatus = "idle";
  let watchId: number | null = null;
  let covered = 0;

  const mode = (): TravelMode => chosenMode ?? guessedMode ?? "walking";
  const distance = (): number | null => (fix && venue ? distanceMeters(fix, venue) : null);

  // ── DOM ────────────────────────────────────────────────────────────────
  const root = document.createElement("section");
  root.id = "transit-dock";
  root.setAttribute("aria-label", s.dockLabel);
  root.dataset.open = "0";
  root.inert = true;

  const modes = document.createElement("div");
  modes.className = "dock-modes";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", s.dockModes);
  const modeButtons = (["walking", "driving"] as const).map((m) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dock-mode";
    button.dataset.mode = m;
    button.setAttribute("aria-label", m === "walking" ? s.dockWalking : s.dockDriving);
    button.appendChild(icon(m === "walking" ? "walk" : "car", "dock-mode-icon"));
    button.addEventListener("click", () => choose(m));
    modes.appendChild(button);
    return button;
  });

  const uber = partnerButton("dock-uber", "Uber", s.dockUber);
  const maps = partnerButton("dock-maps", mapsName, s.dockMaps.replace("{app}", mapsName));
  const partners = document.createElement("div");
  partners.className = "dock-partners";
  partners.append(uber, maps);

  const controls = document.createElement("div");
  controls.className = "dock-island dock-controls";
  controls.append(modes, partners);

  const eta = document.createElement("p");
  eta.className = "dock-eta";
  const away = document.createElement("p");
  away.className = "dock-away";
  // No `aria-live`: the distance changes every few metres of a walk, and a
  // screen reader reading each one out is noise rather than help. The
  // toggle's own `aria-pressed` is the answer to a tap.
  const status = document.createElement("div");
  status.className = "dock-island dock-status";
  status.append(eta, away);

  root.append(controls, status);
  document.body.appendChild(root);

  uber.addEventListener("click", () => {
    if (!venue) return;
    haptic("light");
    openExternal(uberLink(venue, { clientId: uberClientId }), app);
  });
  maps.addEventListener("click", () => {
    if (!venue) return;
    haptic("light");
    openExternal(mapsLink(mapsApp, venue, mode()), app);
  });

  // The dock sits on the sheet, whose height follows its content: measured on
  // every resize rather than guessed in CSS. The dock's own box is watched too
  // — a short screen drops its status card — because both feed `onLayout`.
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(syncLayout);
    if (sheet) observer.observe(sheet);
    observer.observe(root);
  }
  syncLayout();

  function syncLayout(): void {
    if (sheet) root.style.setProperty("--sheet-h", `${sheet.offsetHeight}px`);
    // Layout boxes, not client rects: the entry transition's transform must
    // not make the map chase a dock that is still sliding into place.
    const next =
      root.dataset.open === "1" && sheet ? sheet.offsetHeight + GAP_OVER_SHEET_PX + root.offsetHeight : 0;
    if (next === covered) return;
    covered = next;
    onLayout?.(covered);
  }

  function partnerButton(cls: string, label: string, name: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `dock-partner ${cls}`;
    button.textContent = label;
    button.setAttribute("aria-label", name);
    return button;
  }

  function haptic(kind: "light" | "selection"): void {
    const h = app?.HapticFeedback;
    if (!h) return;
    try {
      if (kind === "selection") h.selectionChanged();
      else h.impactOccurred(kind);
    } catch {
      // Older clients expose a partial HapticFeedback. A missing buzz is never
      // worth an exception on a screen that is otherwise working.
    }
  }

  function choose(next: TravelMode): void {
    const changed = mode() !== next;
    chosenMode = next;
    if (changed) haptic("selection");
    render();
  }

  function watch(on: boolean): void {
    if (!on) {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      // Dropped with the watch: a position is never older than the screen that
      // could show it.
      fix = null;
      geo = "idle";
      return;
    }
    if (watchId !== null) return;
    if (!navigator.geolocation) {
      geo = "unavailable";
      return;
    }
    geo = "locating";
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        fix = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        geo = "fixed";
        render();
      },
      (err) => {
        // A refusal blanks the trip. A lost signal (a tunnel, a lift) keeps the
        // last fix: the venue has not moved, and in a minute neither has the
        // user, much.
        if (err.code === 1) {
          fix = null;
          geo = "denied";
        } else if (!fix) {
          geo = "unavailable";
        }
        render();
      },
      GEO_WATCH,
    );
  }

  function render(): void {
    const d = distance();
    if (guessedMode === null && d !== null) guessedMode = defaultModeFor(d);
    const shown = dockShown({ presence, summoned, distanceM: d });
    root.dataset.open = shown ? "1" : "0";
    root.inert = !shown;

    const m = mode();
    for (const button of modeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === m));
    }

    if (d === null) {
      // No distance yet, or none coming. The card names the place and the
      // buttons still work — Uber and the maps app find the phone themselves.
      eta.textContent = venue?.name ?? s.dockLabel;
      away.textContent = geo === "denied" || geo === "unavailable" ? s.dockNoLocation : s.dockLocating;
    } else {
      const minutes = etaMinutes(d, m);
      eta.textContent =
        minutes === null
          ? (venue?.name ?? s.dockLabel)
          : (m === "walking" ? s.dockEtaWalking : s.dockEtaDriving).replace(
              "{time}",
              formatTravelTime(minutes, s),
            );
      away.textContent = formatDistance(d, lang, {
        metres: s.dockAwayMetres,
        kilometres: s.dockAwayKilometres,
      });
    }
    syncLayout();
  }

  return {
    update(state, next) {
      presence = dockPresenceFor(state, next !== null);
      if (presence === "off") summoned = false;
      // The pair changed the venue: a different trip, so the first guess is
      // made again for it. The user's own pick of mode stands.
      if (!venue || !next || venue.lat !== next.lat || venue.lng !== next.lng) guessedMode = null;
      venue = next;
      watch(presence === "auto" || (presence !== "off" && summoned));
      render();
      return presence;
    },
    summon() {
      if (presence === "off" || summoned) return;
      const wasShown = root.dataset.open === "1";
      summoned = true;
      watch(true);
      render();
      if (!wasShown) haptic("light");
    },
    dismiss() {
      if (!summoned) return;
      summoned = false;
      watch(presence === "auto");
      render();
    },
  };
}
