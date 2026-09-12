/**
 * The transit dock — how the canvas gets someone from "your date is at 19:00"
 * into a car or onto a route (decision 2026-09-11). Two glass islands sitting
 * on the sheet, the shape of Bump's transit HUD: a control pill (on foot / by
 * car, a wide Uber, and both maps apps as their own tiles) over a status card
 * ("9 min by car" / "You're 2.4 km away").
 *
 * This file is the DOM, the GPS watch and the taps. When the dock may show and
 * what its numbers are live in `transit.ts`; what its links carry lives in
 * `deep-links.ts` — both pure and tested without a browser.
 *
 * The position never leaves this SCREEN. It is read while the dock can show,
 * turned into a distance and a number of minutes, handed to the map beside it
 * as `onFix` so the user can see where they are leaving from (change of
 * 2026-09-12), and dropped with the watch. Nothing carries it off the phone:
 * no request has it in a body or a query, and the partner links name the venue
 * alone.
 */

import { brandMark, type BrandMarkName } from "../brand-marks.js";
import { distanceMeters, formatDistance } from "../date-terminal/terminal-state.js";
import {
  MAPS_APP_NAME,
  mapsAppsFor,
  mapsLink,
  openExternal,
  uberLink,
  type Destination,
  type MapsApp,
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
  /**
   * The fix this dock is holding, or null when it has none (change of
   * 2026-09-12, "show me where I'm leaving from"). The map draws the user's own
   * point and the line to the venue from it.
   *
   * This is the ONE way a position leaves this closure, and it goes exactly as
   * far as the map on the same screen: a marker and a `<canvas>`, both local.
   * The file's promise is about the network, and it still holds — no request
   * carries it, and the links name the venue alone.
   */
  onFix?: (fix: { lat: number; lng: number } | null) => void;
}): TransitDock {
  const { sheet, strings: s, lang, app, uberClientId, onLayout, onFix } = options;
  // Decided once: a phone does not change its maps app while a page is open.
  const [firstMaps, secondMaps] = mapsAppsFor(app?.platform, navigator.userAgent);

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
  /**
   * The chip that slides between the two icons (change of 2026-09-12). It used
   * to be a background colour on whichever button was pressed, so the selection
   * teleported: the eye got a new state with no account of how it got there.
   * One element that travels is the account. It is `aria-hidden` and the
   * buttons keep their own `aria-pressed` — nothing about what is announced
   * changes, only what is seen.
   */
  const thumb = document.createElement("span");
  thumb.className = "dock-thumb";
  thumb.setAttribute("aria-hidden", "true");
  modes.appendChild(thumb);
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

  /**
   * The row's weights, changed 2026-09-12. Uber is the button that ENDS the
   * question — a car is coming, nothing more to decide — so it takes the width
   * left over and keeps its wordmark. The two maps apps are a hand-off to
   * another screen, and their app tiles are recognised faster than their names
   * are read, so they shrink to one thumb-sized square each. The name they lose
   * from the face they keep in `aria-label`.
   */
  const uber = partnerButton("dock-uber", "Uber", s.dockUber);
  const mapsButtons = [firstMaps, secondMaps].map(mapsButton);
  const mapsRow = document.createElement("div");
  mapsRow.className = "dock-maps-apps";
  mapsRow.append(...mapsButtons);
  const partners = document.createElement("div");
  partners.className = "dock-partners";
  partners.append(uber, mapsRow);

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

  /** One maps app: its own tile for the eye, its name for everything else. */
  function mapsButton(which: MapsApp): HTMLButtonElement {
    const name = MAPS_APP_NAME[which];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dock-partner dock-maps";
    button.dataset.app = which;
    button.setAttribute("aria-label", s.dockMaps.replace("{app}", name));
    // A tooltip for a pointer, and the one place the name still shows on a
    // screen wide enough to hover.
    button.title = name;
    button.appendChild(brandMark(`${which}-maps` as BrandMarkName, "dock-maps-mark"));
    button.addEventListener("click", () => {
      if (!venue) return;
      haptic("light");
      openExternal(mapsLink(which, venue, mode()), app);
    });
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
      // could show it. The map is told in the same breath, so the user's own
      // point and the line to the venue go with it rather than lingering at a
      // place the dock has already forgotten.
      fix = null;
      geo = "idle";
      onFix?.(null);
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
        onFix?.(fix);
        render();
      },
      (err) => {
        // A refusal blanks the trip. A lost signal (a tunnel, a lift) keeps the
        // last fix: the venue has not moved, and in a minute neither has the
        // user, much.
        if (err.code === 1) {
          fix = null;
          geo = "denied";
          onFix?.(null);
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
    // What the sliding chip follows. CSS owns where it lands, so the travel
    // stays one declaration rather than arithmetic in two places.
    modes.dataset.mode = m;

    if (d === null) {
      // No distance yet, or none coming. The card names the place and the
      // buttons still work — Uber and the maps apps find the phone themselves.
      setEta(venue?.name ?? s.dockLabel);
      away.textContent = geo === "denied" || geo === "unavailable" ? s.dockNoLocation : s.dockLocating;
    } else {
      const minutes = etaMinutes(d, m);
      setEta(
        minutes === null
          ? (venue?.name ?? s.dockLabel)
          : (m === "walking" ? s.dockEtaWalking : s.dockEtaDriving).replace(
              "{time}",
              formatTravelTime(minutes, s),
            ),
      );
      away.textContent = formatDistance(d, lang, {
        metres: s.dockAwayMetres,
        kilometres: s.dockAwayKilometres,
      });
    }
    syncLayout();
  }

  /**
   * The headline, swapped with a beat of its own.
   *
   * Only when the words actually change: this runs on every GPS reading, and a
   * line that flickers each time the metres tick would be a nervous tic rather
   * than an answer. The travel is the same distance and curve the chip below it
   * moves on, so tapping "on foot" reads as ONE gesture — the chip slides, the
   * number follows it — instead of two things happening near each other.
   */
  function setEta(text: string): void {
    if (eta.textContent === text) return;
    const had = eta.textContent !== "";
    eta.textContent = text;
    if (!had || stillFrames() || typeof eta.animate !== "function") return;
    eta.animate(
      [
        { opacity: 0, transform: "translateY(5px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
  }

  /** The user asked the OS for less motion — honour it here as the CSS does. */
  function stillFrames(): boolean {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
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
