import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import { ButterflyLoader } from "../butterfly-loader-react.js";
import { Ticket3D } from "../ticket/Ticket3D.js";
import { LockMark } from "../ticket/marks.js";
import { useActionBarSpace } from "../ticket/action-bar.js";
import { pickLang as pickTicketLang, strings as ticketStrings } from "../ticket/i18n.js";
import { CanvasApiError, fetchDateState, postBump, type DateStateResponse } from "../canvas/api.js";
import { isCanvasState } from "../canvas/sheet.js";
import { backoffFor, pollIntervalFor } from "../canvas/poll.js";
import { createShakeDetector, requestMotionPermission } from "../canvas/shake.js";
import { createImpulseGate } from "./kinetics.js";
import { Shockwave, type ShockwaveHandle } from "./Shockwave.js";
import { fill, pickLang, stringsFor, type TerminalStrings } from "./i18n.js";
import {
  FIX_MAX_AGE_MS,
  GEOFENCE_RADIUS_M,
  distanceMeters,
  formatClock,
  formatDistance,
  syncOpensAt,
  syncUnlocked,
  terminalPhase,
  wantsLocation,
  withinGeofence,
  type MotionStatus,
  type TerminalPhase,
} from "./terminal-state.js";

/**
 * The Date Terminal — Contact Sync on the date-day ticket (decision 2026-09-11).
 *
 * One screen, three jobs, in the order the evening needs them:
 *   1. **Arrival.** From T-45m (the bot's invite) it counts down the distance
 *      to the venue from this phone's own GPS. Nothing about the partner is
 *      shown or sent from here — the radar's privacy rule, unchanged.
 *   2. **The lock.** Contact Sync stays shut until the server's window is open
 *      AND this phone is within 100 m of the venue (`terminalPhase`). Inside,
 *      a tap arms the accelerometer (iOS demands the tap), every swing of the
 *      hand buzzes `impactOccurred("medium")` and sends a Liquid Glass
 *      shockwave through the page, and every full shake is posted to
 *      `POST /v1/dates/:id/bump` — which re-checks the window, the radius and
 *      the other phone's shake on its own.
 *   3. **The climax.** On a SERVER-confirmed mutual sync — this call's own
 *      `verified`, or the partner's shake arriving through the poll —
 *      `impactOccurred("rigid")` then `notificationOccurred("success")`, the
 *      ticket tears along its perforation and the at-the-table deck slides out
 *      of the tear. Opened after the fact, it shows the torn ticket and the
 *      deck as they are, without replaying the moment.
 *
 * The API keeps its name, `bump`: "Contact Sync" is what the screen calls the
 * gesture, not a second contract (see the decision journal for why the rename
 * was not done).
 */

const app = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const matchId = params.get("match") ?? "";
const lang = pickLang(params.get("lang") ?? app?.initDataUnsafe?.user?.language_code ?? null);
const initData = app?.initData ?? "";
document.documentElement?.setAttribute("lang", lang);

type GeoStatus = "idle" | "locating" | "fixed" | "denied" | "unavailable";

interface Fix {
  lat: number;
  lng: number;
  at: number;
}

const GEO_WATCH: PositionOptions = { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 };
const GEO_ONCE: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 8_000 };
/** How long the tear plays before the deck starts sliding out of it. */
const DEAL_DELAY_MS = 480;
/** The deck is written by the call that verified the pair; the other side polls for it. */
const DECK_POLL_MS = 1_500;
/** Where the arrival ring starts filling, in metres from the venue. */
const RING_FAR_M = 1000;

type HapticKind = "light" | "medium" | "rigid" | "success" | "error";

function haptic(kind: HapticKind): void {
  const h = app?.HapticFeedback;
  if (!h) return;
  try {
    if (kind === "success" || kind === "error") h.notificationOccurred(kind);
    else h.impactOccurred(kind);
  } catch {
    // Older clients expose a partial HapticFeedback. A missing buzz is never
    // worth an exception on a screen that is otherwise working.
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function freshFix(): Promise<Fix | null> {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, at: Date.now() }),
      () => resolve(null),
      GEO_ONCE,
    );
  });
}

export function DateTerminal(): ReactElement {
  const s = stringsFor(lang);
  const ticketS = ticketStrings(pickTicketLang(lang));
  const barRef = useActionBarSpace();

  const [dateState, setDateState] = useState<DateStateResponse | null>(null);
  const [failures, setFailures] = useState(0);
  const [geo, setGeo] = useState<GeoStatus>("idle");
  const [geoAttempt, setGeoAttempt] = useState(0);
  const [fix, setFix] = useState<Fix | null>(null);
  const [motion, setMotion] = useState<MotionStatus>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [shookAlone, setShookAlone] = useState(false);
  /** This phone's own POST came back `verified` — ahead of the next poll. */
  const [confirmed, setConfirmed] = useState(false);
  const [torn, setTorn] = useState(false);
  const [dealt, setDealt] = useState(false);

  const shockRef = useRef<ShockwaveHandle | null>(null);
  const ticketRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<TerminalPhase>("closed");
  const fixRef = useRef<Fix | null>(null);
  const postingRef = useRef(false);
  const climaxRef = useRef<"none" | "silent" | "played">("none");
  const loadedRef = useRef(false);
  const opensLabelRef = useRef("");

  const load = useCallback(async (): Promise<void> => {
    if (!initData || !matchId) return;
    try {
      const next = await fetchDateState(initData);
      setFailures(0);
      // An unknown state from a newer server reads as "nothing on", like the
      // canvas does — the contract declares states as open strings.
      setDateState(isCanvasState(next.state) ? next : { ...next, state: "IDLE_EXPLORING" });
    } catch {
      setFailures((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const match = dateState?.match ?? null;
  const venue =
    match?.venue && match.venue.lat !== null && match.venue.lng !== null
      ? { lat: match.venue.lat, lng: match.venue.lng }
      : null;
  const venueName = match?.venue?.name ?? null;
  const deck = match?.deck ?? [];
  const distanceM = fix && venue ? distanceMeters(fix, venue) : null;
  const agreedTime = match?.agreedTime ? new Date(match.agreedTime) : null;
  const timeLabel = agreedTime ? formatClock(agreedTime, lang) : "";
  const opensLabel = agreedTime ? formatClock(syncOpensAt(agreedTime), lang) : "";
  opensLabelRef.current = opensLabel;

  const phase: TerminalPhase = dateState
    ? terminalPhase({
        matchId,
        state: dateState.state,
        stateMatchId: match?.id ?? null,
        venue,
        bumpVerified: Boolean(match?.bump?.verified) || confirmed,
        distanceM,
        motion,
      })
    : "closed";
  phaseRef.current = phase;

  // ── Polling ────────────────────────────────────────────────────────────
  // The canvas cadence (5 s in the radar and sync windows, a minute otherwise),
  // a faster one while the deck is still being written, and none at all once
  // there is nothing left to wait for.
  const deckReady = deck.length > 0;
  useEffect(() => {
    if (!initData || !matchId) return;
    if (dateState && phase === "closed") return;
    if (phase === "synced" && deckReady) return;
    const delay =
      failures > 0
        ? backoffFor(failures)
        : phase === "synced"
          ? DECK_POLL_MS
          : dateState
            ? pollIntervalFor(dateState.state)
            : backoffFor(1);
    const id = window.setTimeout(() => void load(), delay);
    return () => window.clearTimeout(id);
  }, [dateState, failures, phase, deckReady, load]);

  // ── Location ───────────────────────────────────────────────────────────
  const watching = wantsLocation(phase) && venue !== null;
  useEffect(() => {
    if (!watching) return;
    if (!navigator.geolocation) {
      setGeo("unavailable");
      return;
    }
    setGeo((current) => (current === "fixed" ? current : "locating"));
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude, at: Date.now() };
        fixRef.current = next;
        setFix(next);
        setGeo("fixed");
      },
      (err) => setGeo(err.code === 1 ? "denied" : "unavailable"),
      GEO_WATCH,
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [watching, geoAttempt]);

  // ── Kinetics ───────────────────────────────────────────────────────────
  const pulse = useCallback((strength: number): void => {
    haptic("medium");
    const rect = ticketRef.current?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    shockRef.current?.fire(x, y, strength);
    const el = ticketRef.current;
    if (el && typeof el.animate === "function" && !prefersReducedMotion()) {
      const dx = (Math.random() - 0.5) * 12 * strength;
      const dy = (Math.random() - 0.5) * 8 * strength;
      el.animate(
        [
          { transform: "translate3d(0, 0, 0) scale(1)" },
          { transform: `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) scale(${(1 + 0.025 * strength).toFixed(3)})`, offset: 0.3 },
          { transform: "translate3d(0, 0, 0) scale(1)" },
        ],
        { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
    }
  }, []);

  const sendSync = useCallback(async (): Promise<void> => {
    if (postingRef.current) return;
    postingRef.current = true;
    try {
      const known = fixRef.current;
      const here = known && Date.now() - known.at <= FIX_MAX_AGE_MS ? known : await freshFix();
      if (!here) {
        setNotice(s.geoUnavailable);
        haptic("error");
        return;
      }
      const res = await postBump(initData, matchId, { lat: here.lat, lng: here.lng, when: new Date() });
      setNotice(null);
      if (res.verified) {
        setConfirmed(true);
      } else {
        setShookAlone(true);
      }
      // The state is what carries the deck, and the partner's view of the same
      // moment — the response is about this call, the state is about the pair.
      await load();
    } catch (err) {
      haptic("error");
      if (err instanceof CanvasApiError && err.code === "too-far") {
        setNotice(fill(s.tooFar, { radius: GEOFENCE_RADIUS_M }));
      } else if (err instanceof CanvasApiError && err.code === "too-early") {
        setNotice(fill(s.tooEarly, { time: opensLabelRef.current }));
      } else if (err instanceof CanvasApiError) {
        // wrong-state / too-late / not-participant: the screen is stale.
        setNotice(null);
        void load();
      } else {
        setNotice(s.offline);
      }
    } finally {
      postingRef.current = false;
    }
  }, [load, s]);

  // Bound only while armed. Locked means locked: out of range or out of the
  // window the hand gets no buzz and the server no shake.
  useEffect(() => {
    if (motion !== "armed") return;
    const detector = createShakeDetector();
    const gate = createImpulseGate();
    const onMotion = (event: DeviceMotionEvent): void => {
      const a = event.accelerationIncludingGravity;
      if (!a || !syncUnlocked(phaseRef.current)) return;
      const sample = { x: a.x, y: a.y, z: a.z, at: Date.now() };
      const impulse = gate.feed(sample);
      if (impulse) pulse(impulse.strength);
      if (detector.feed(sample)) void sendSync();
    };
    window.addEventListener("devicemotion", onMotion);
    return () => window.removeEventListener("devicemotion", onMotion);
  }, [motion, pulse, sendSync]);

  const arm = useCallback(async (): Promise<void> => {
    // Must run inside the tap: iOS only grants motion from a user gesture.
    const verdict = await requestMotionPermission(
      (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<"granted" | "denied"> } })
        .DeviceMotionEvent,
    );
    if (verdict !== "granted") {
      setMotion(verdict);
      setNotice(verdict === "unsupported" ? s.motionUnsupported : s.motionDenied);
      haptic("error");
      return;
    }
    setNotice(null);
    setMotion("armed");
    haptic("light");
  }, [s]);

  // ── The climax ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!dateState || phase !== "synced" || climaxRef.current !== "none") return;
    if (!loadedRef.current) {
      // Opened AFTER the sync — later in the evening, from the chat. The moment
      // already happened; show where it left the ticket, silently.
      climaxRef.current = "silent";
      setTorn(true);
      setDealt(true);
      return;
    }
    climaxRef.current = "played";
    haptic("rigid");
    window.setTimeout(() => haptic("success"), 140);
    const rect = ticketRef.current?.getBoundingClientRect();
    shockRef.current?.fire(
      rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
      rect ? rect.top + rect.height * 0.8 : window.innerHeight / 2,
      1,
    );
    setTorn(true);
  }, [dateState, phase]);

  useEffect(() => {
    if (dateState) loadedRef.current = true;
  }, [dateState]);

  // Its own effect, keyed on the tear alone, so a poll landing mid-tear cannot
  // cancel the deal and leave the deck face-down.
  useEffect(() => {
    if (!torn || dealt) return;
    const id = window.setTimeout(() => setDealt(true), DEAL_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [torn, dealt]);

  // ── Render ─────────────────────────────────────────────────────────────
  if (initData && matchId && !dateState && failures === 0) {
    return (
      <div className="ticket-page ticket-center terminal-page">
        <Shockwave handleRef={shockRef} />
        <ButterflyLoader label={s.loading} />
      </div>
    );
  }
  if (!dateState && failures > 0) {
    return (
      <div className="ticket-page ticket-center terminal-page">
        <Shockwave handleRef={shockRef} />
        <p className="terminal-notice">{s.offline}</p>
      </div>
    );
  }

  const inRange = withinGeofence(distanceM);
  const waiting = shookAlone || Boolean(match?.bump?.mine);
  const geoLine = geoNotice(geo, s);
  const shownNotice = notice ?? (wantsLocation(phase) ? geoLine : null);
  const openMap = (): void => {
    haptic("light");
    location.href = `canvas.html?${new URLSearchParams({ lang, theme: "dark" }).toString()}`;
  };

  return (
    <div className="ticket-page has-bar terminal-page" data-phase={phase}>
      <Shockwave handleRef={shockRef} />
      <div className="ticket-scroll">
        <header className="ticket-header terminal-header">
          <p className="terminal-kicker">{s.kicker}</p>
          <h1>{titleFor(phase, s, timeLabel)}</h1>
          <p>{subFor(phase, s, opensLabel, waiting)}</p>
        </header>

        {/* Arrival above the ticket, not under it: in the minutes before the
            date the distance is the one thing on this screen that changes, and
            below a full ticket a phone-height screen pushed it under the action
            bar. */}
        {wantsLocation(phase) && (
          <section className="terminal-radar" data-in-range={inRange ? "1" : "0"} aria-live="polite">
            <ArrivalRing distanceM={distanceM} />
            <div className="terminal-radar-copy">
              <span className="terminal-radar-label">
                {venueName ? fill(s.arrival, { venue: venueName }) : s.arrivalFallback}
              </span>
              <span className="terminal-radar-value">
                {distanceM !== null ? formatDistance(distanceM, lang, s) : geo === "locating" || geo === "idle" ? s.locating : "—"}
              </span>
              {inRange && (
                <span className="terminal-radar-ok">{fill(s.inRange, { radius: GEOFENCE_RADIUS_M })}</span>
              )}
            </div>
          </section>
        )}

        {shownNotice && (
          <p className="terminal-notice" role="status">
            {shownNotice}
          </p>
        )}

        <div className="terminal-ticket" ref={ticketRef}>
          <Ticket3D
            caption={venueName}
            stub={timeLabel ? { label: s.stubLabel, value: timeLabel } : null}
            torn={torn}
            strings={ticketS}
          />
        </div>

        {phase === "synced" && (
          <ol className={dealt ? "terminal-deck is-dealt" : "terminal-deck"}>
            {deckReady ? (
              deck.map((topic, i) => (
                <li className="deck-card" key={topic} style={{ "--i": i } as CSSProperties}>
                  <span className="deck-card-n">{i + 1}</span>
                  <span>{topic}</span>
                </li>
              ))
            ) : (
              <li className="deck-card deck-card-loading">{s.deckLoading}</li>
            )}
          </ol>
        )}
      </div>

      <footer className="action-bar terminal-bar" ref={barRef}>
        {phase === "ready" && (
          <button type="button" className="btn-hero" onClick={() => void arm()}>
            {s.activate}
          </button>
        )}
        {(phase === "early" || phase === "approach") &&
          (geo === "denied" ? (
            <button type="button" className="btn-primary" onClick={() => setGeoAttempt((n) => n + 1)}>
              {s.retryLocation}
            </button>
          ) : (
            <button type="button" className="btn-secondary terminal-locked" disabled>
              <LockMark />
              <span>{s.locked}</span>
            </button>
          ))}
        {(phase === "synced" || phase === "closed" || phase === "no-venue-point") && (
          <button type="button" className="btn-secondary" onClick={() => app?.close()}>
            {s.close}
          </button>
        )}
        {phase !== "closed" && phase !== "synced" && (
          <button type="button" className="btn-text" onClick={openMap}>
            {s.openMap}
          </button>
        )}
      </footer>
    </div>
  );
}

function titleFor(phase: TerminalPhase, s: TerminalStrings, time: string): string {
  switch (phase) {
    case "early":
      return fill(s.titleEarly, { time });
    case "approach":
      return s.titleApproach;
    case "ready":
      return s.titleReady;
    case "armed":
      return s.titleArmed;
    case "synced":
      return s.titleSynced;
    case "no-venue-point":
      return s.titleNoVenue;
    case "closed":
      return s.titleClosed;
  }
}

function subFor(phase: TerminalPhase, s: TerminalStrings, opens: string, waiting: boolean): string {
  switch (phase) {
    case "early":
      return fill(s.subEarly, { time: opens, radius: GEOFENCE_RADIUS_M });
    case "approach":
      return fill(s.subApproach, { radius: GEOFENCE_RADIUS_M });
    case "ready":
      return s.subReady;
    case "armed":
      return waiting ? s.subWaiting : s.subArmed;
    case "synced":
      return s.subSynced;
    case "no-venue-point":
      return s.subNoVenue;
    case "closed":
      return s.subClosed;
  }
}

function geoNotice(geo: GeoStatus, s: TerminalStrings): string | null {
  if (geo === "denied") return s.geoDenied;
  if (geo === "unavailable") return s.geoUnavailable;
  return null;
}

/**
 * The arrival ring: empty a kilometre out, full at the geofence. A position,
 * not a promise — it fills from this phone's own GPS and nothing else.
 */
function ArrivalRing(props: { distanceM: number | null }): ReactElement {
  const radius = 19;
  const circumference = 2 * Math.PI * radius;
  const closeness =
    props.distanceM === null
      ? 0
      : Math.max(0, Math.min(1, 1 - (props.distanceM - GEOFENCE_RADIUS_M) / (RING_FAR_M - GEOFENCE_RADIUS_M)));
  return (
    <svg className="terminal-ring" viewBox="0 0 46 46" aria-hidden="true">
      <circle className="terminal-ring-track" cx="23" cy="23" r={radius} fill="none" strokeWidth="3" />
      <circle
        className="terminal-ring-arc"
        cx="23"
        cy="23"
        r={radius}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={circumference.toFixed(2)}
        strokeDashoffset={(circumference * (1 - closeness)).toFixed(2)}
        transform="rotate(-90 23 23)"
      />
    </svg>
  );
}
