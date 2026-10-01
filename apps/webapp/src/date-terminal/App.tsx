import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import { ButterflyLoader } from "../butterfly-loader-react.js";
import { Ticket3D } from "../ticket/Ticket3D.js";
import { LockMark } from "../ticket/marks.js";
import { useActionBarSpace } from "../ticket/action-bar.js";
import { pickLang as pickTicketLang, strings as ticketStrings } from "../ticket/i18n.js";
import { CanvasApiError, fetchDateState, postBump, type DateStateResponse } from "../canvas/api.js";
import { isCanvasState } from "../canvas/sheet.js";
import {
  backoffFor,
  connectionTroubleFor,
  pollIntervalFor,
  type ConnectionTrouble,
} from "../canvas/poll.js";
import { TerminalGlass } from "./Glass.js";
import { fill, pickLang, stringsFor, type TerminalStrings } from "./i18n.js";
import type { CeremonyHapticId, CeremonyPlan, CeremonyRole } from "./ceremony/ceremony-stand.js";
import { ownDevice, planFor, type CeremonyLabels } from "./ceremony/adapter.js";
import { createServerClock, parseServerTime, wallNow } from "./ceremony/clock.js";
import { GATE_START, cueFromHold, cueFromState, type CeremonyCue, type CeremonyGate } from "./ceremony/cue.js";
import { CeremonyOverlay } from "./ceremony/CeremonyOverlay.js";
import { HoldCapsule, PlacementHint } from "./ceremony/HoldCapsule.js";
import { Render } from "./ceremony/render-stand.js";
import {
  FIX_MAX_AGE_MS,
  GEOFENCE_RADIUS_M,
  distanceMeters,
  formatClock,
  formatDistance,
  shownPhase,
  syncOpensAt,
  terminalPhase,
  wantsLocation,
  withinGeofence,
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
 *      the gesture is a HOLD (2026-09-29, it replaced the shake): the phones
 *      lie top edge to top edge, each person holds the capsule for 0.6 s, and
 *      the hold is posted to `POST /v1/dates/:id/bump` with `hold: true`. The
 *      server re-checks the window and the radius, and keeps the request open
 *      up to 10 s for the other phone's hold.
 *   3. **The meeting ceremony.** When the pair verifies, the answer names a
 *      start on the server's clock and this phone's role; both phones play the
 *      stand's scene (`ceremony/`) at that moment — the mascot leaps off the
 *      phone that waited and lands on the other, winks, and becomes the mark
 *      of the plaque «Meeting confirmed». After it, the torn ticket and the
 *      at-the-table deck — without the old tear climax, which the scene
 *      replaced. A server without the long-poll sends no `ceremony`; the scene
 *      then plays locally, once, when the poll reports the sync (`cue.ts`).
 *      Opened after the fact, the terminal shows the torn ticket and the deck
 *      as they are, without replaying the moment.
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
// The ceremony draws its words on a canvas, which does not wait for a face to
// arrive the way the DOM does — ask for the weights it uses up front.
void document.fonts?.load?.("600 17px Inter").catch(() => undefined);
void document.fonts?.load?.("13px Inter").catch(() => undefined);

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
/** State reads taken while the finger fills the capsule, to sharpen the clock. */
const CLOCK_WARMUP_READS = 2;
/** `ceremonyLaunch` in Telegram: a soft push, then a lighter slide off it. */
const LAUNCH_SLIDE_MS = 80;
/** The deck is written by the call that verified the pair; the other side polls for it. */
const DECK_POLL_MS = 1_500;
/**
 * After a hold comes back unpaired, the partner's may still complete the pair
 * — at once on a server without the long-poll, which answers every hold
 * immediately. Poll at the deck's pace for this long, so the sync (and the
 * locally played scene) is not up to a whole 5 s radar interval late.
 */
const ALONE_WATCH_MS = 12_000;
/** Where the arrival ring starts filling, in metres from the venue. */
const RING_FAR_M = 1000;

type HapticKind = "soft" | "light" | "medium" | "rigid" | "success" | "error";

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

/** The stand's haptic beats, in the nearest Telegram styles (the stand's `tg` field). */
function ceremonyHaptic(id: CeremonyHapticId): void {
  if (id === "ceremonyLaunch") {
    haptic("soft");
    window.setTimeout(() => haptic("light"), LAUNCH_SLIDE_MS);
  } else if (id === "magSafeSnap") {
    haptic("rigid");
  } else {
    haptic("success");
  }
}

/**
 * This phone's screen in the stand's terms, and the scene planned on it.
 * `capY` is the hold capsule's centre, when there is one to start from.
 */
function planCeremony(s: TerminalStrings, capY: number | null): CeremonyPlan {
  const device = ownDevice({
    w: window.innerWidth,
    h: window.innerHeight,
    home: app?.safeAreaInset?.bottom ?? 0,
  });
  const markDX = Render.plaqueMarkDX(s.ceremonyTitle, s.ceremonySub);
  return planFor(device, {
    rm: prefersReducedMotion(),
    markDX,
    ...(capY !== null ? { capY } : {}),
  });
}

interface CeremonyShown {
  plan: CeremonyPlan;
  /** Null while the hold waits for the server. */
  scene: { role: CeremonyRole; startAt: number } | null;
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
  /** Why the last state read failed, when it is something to tell the user. */
  const [trouble, setTrouble] = useState<ConnectionTrouble | null>(null);
  const [geo, setGeo] = useState<GeoStatus>("idle");
  const [geoAttempt, setGeoAttempt] = useState(0);
  const [fix, setFix] = useState<Fix | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** When the last hold came back unpaired (local ms), or null. */
  const [aloneAt, setAloneAt] = useState<number | null>(null);
  /** A hold request is out (the server may keep it up to 10 s). */
  const [holdBusy, setHoldBusy] = useState(false);
  /** This phone's own POST came back `verified` — ahead of the next poll. */
  const [confirmed, setConfirmed] = useState(false);
  /** The ceremony overlay: the waiting capsule, then the scene. */
  const [ceremony, setCeremony] = useState<CeremonyShown | null>(null);
  const [torn, setTorn] = useState(false);
  const [dealt, setDealt] = useState(false);
  /** Torn by a ceremony: shown already torn, without the tear playing. */
  const [settled, setSettled] = useState(false);

  const fixRef = useRef<Fix | null>(null);
  const holdInFlightRef = useRef(false);
  const climaxRef = useRef<"none" | "silent" | "ceremony">("none");
  const gateRef = useRef<CeremonyGate>(GATE_START);
  const clockRef = useRef(createServerClock());
  const warmingRef = useRef(false);
  /** Where the finger held the capsule — the scene starts from there. */
  const capYRef = useRef<number | null>(null);
  const opensLabelRef = useRef("");

  const load = useCallback(async (): Promise<void> => {
    if (!initData || !matchId) return;
    try {
      const sentAt = wallNow();
      const next = await fetchDateState(initData);
      clockRef.current.record({ sentAt, receivedAt: wallNow(), serverNow: parseServerTime(next.serverNow) });
      setFailures(0);
      setTrouble(null);
      // An unknown state from a newer server reads as "nothing on", like the
      // canvas does — the contract declares states as open strings.
      setDateState(isCanvasState(next.state) ? next : { ...next, state: "IDLE_EXPLORING" });
    } catch (err) {
      setFailures((n) => n + 1);
      // A13-M31: once the ticket is drawn a failed poll used to change nothing
      // on screen, so a dead connection kept presenting the last state as live.
      setTrouble(connectionTroubleFor(err instanceof CanvasApiError ? err.status : null));
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
  // The venue's clock, not the phone's (A13-L25).
  const venueZone = dateState?.timeZone ?? null;
  const timeLabel = agreedTime ? formatClock(agreedTime, lang, venueZone) : "";
  const opensLabel = agreedTime ? formatClock(syncOpensAt(agreedTime), lang, venueZone) : "";
  opensLabelRef.current = opensLabel;

  const phase: TerminalPhase = dateState
    ? terminalPhase({
        matchId,
        state: dateState.state,
        stateMatchId: match?.id ?? null,
        venue,
        bumpVerified: Boolean(match?.bump?.verified) || confirmed,
        distanceM,
        holding: holdBusy || ceremony !== null,
      })
    : "closed";
  // Until the scene has played, the screen stays on the hold (terminal-state).
  const shown = shownPhase(phase, ceremony !== null);

  // ── Polling ────────────────────────────────────────────────────────────
  // The canvas cadence (5 s in the radar and sync windows, a minute otherwise),
  // a faster one while the deck is still being written, and none at all once
  // there is nothing left to wait for.
  const deckReady = deck.length > 0;
  useEffect(() => {
    if (!initData || !matchId) return;
    if (dateState && phase === "closed") return;
    if (phase === "synced" && deckReady) return;
    const watchingPartner = aloneAt !== null && Date.now() - aloneAt < ALONE_WATCH_MS;
    const delay =
      failures > 0
        ? backoffFor(failures)
        : phase === "synced" || watchingPartner
          ? DECK_POLL_MS
          : dateState
            ? pollIntervalFor(dateState.state)
            : backoffFor(1);
    const id = window.setTimeout(() => void load(), delay);
    return () => window.clearTimeout(id);
  }, [dateState, failures, phase, deckReady, aloneAt, load]);

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

  // ── The ceremony ───────────────────────────────────────────────────────
  const labels: CeremonyLabels = {
    waiting: s.ceremonyWaiting,
    ready: s.ceremonyReady,
    title: s.ceremonyTitle,
    sub: s.ceremonySub,
  };

  const startScene = useCallback(
    (cue: CeremonyCue): void => {
      setCeremony((current) => ({
        plan: current?.plan ?? planCeremony(s, capYRef.current),
        scene: { role: cue.role, startAt: cue.startAt },
      }));
    },
    [s],
  );

  const finishCeremony = useCallback((): void => {
    climaxRef.current = "ceremony";
    setCeremony(null);
    setSettled(true);
    setTorn(true);
    setDealt(true);
  }, []);

  // Every read this screen shows goes past the gate: a date seen unverified
  // and then verified with no scene yet is the degrade path (cue.ts); a date
  // verified at the first read is the silent synced view.
  useEffect(() => {
    if (!dateState || phase === "closed") return;
    const verified = phase === "synced";
    const step = cueFromState(gateRef.current, {
      verified,
      holdInFlight: holdBusy,
      serverNow: clockRef.current.now(),
    });
    gateRef.current = step.gate;
    if (step.cue) {
      startScene(step.cue);
      return;
    }
    if (verified && !gateRef.current.played && ceremony === null && !holdBusy && climaxRef.current === "none") {
      // Opened AFTER the sync — later in the evening, from the chat. The moment
      // already happened; show where it left the ticket, silently.
      climaxRef.current = "silent";
      setTorn(true);
      setDealt(true);
    }
  }, [dateState, phase, holdBusy, ceremony, startScene]);

  // ── The hold ───────────────────────────────────────────────────────────
  /** A couple of quick state reads while the finger fills the capsule. */
  const warmClock = useCallback((): void => {
    if (warmingRef.current || !initData) return;
    warmingRef.current = true;
    void (async () => {
      try {
        for (let i = 0; i < CLOCK_WARMUP_READS; i += 1) {
          const sentAt = wallNow();
          const next = await fetchDateState(initData);
          clockRef.current.record({ sentAt, receivedAt: wallNow(), serverNow: parseServerTime(next.serverNow) });
        }
      } catch {
        // The regular poll keeps sampling; a failed warm-up costs precision only.
      } finally {
        warmingRef.current = false;
      }
    })();
  }, []);

  const onHoldPress = useCallback((): void => {
    haptic("light");
    warmClock();
  }, [warmClock]);

  const sendHold = useCallback(
    async (centerY: number): Promise<void> => {
      if (holdInFlightRef.current) return;
      holdInFlightRef.current = true;
      capYRef.current = centerY;
      setHoldBusy(true);
      setAloneAt(null);
      // The waiting capsule takes over from the one under the finger at once.
      setCeremony({ plan: planCeremony(s, centerY), scene: null });
      try {
        const known = fixRef.current;
        const here = known && Date.now() - known.at <= FIX_MAX_AGE_MS ? known : await freshFix();
        if (!here) {
          setCeremony(null);
          setNotice(s.geoUnavailable);
          haptic("error");
          return;
        }
        const res = await postBump(
          initData,
          matchId,
          { lat: here.lat, lng: here.lng, when: new Date() },
          { hold: true },
        );
        const receivedAt = wallNow();
        setNotice(null);
        if (res.ceremony) clockRef.current.hint(receivedAt, parseServerTime(res.ceremony.serverNow));
        const step = cueFromHold(gateRef.current, res.ceremony);
        gateRef.current = step.gate;
        if (step.cue) {
          setConfirmed(true);
          startScene(step.cue);
        } else {
          // Unpaired — or verified by a server that sends no scene, in which
          // case the state read below takes the degrade path.
          setCeremony(null);
          if (res.verified) setConfirmed(true);
          else setAloneAt(Date.now());
        }
      } catch (err) {
        setCeremony(null);
        haptic("error");
        const holdTrouble = connectionTroubleFor(err instanceof CanvasApiError ? err.status : null);
        if (err instanceof CanvasApiError && err.code === "too-far") {
          setNotice(fill(s.tooFar, { radius: GEOFENCE_RADIUS_M }));
        } else if (err instanceof CanvasApiError && err.code === "too-early") {
          setNotice(fill(s.tooEarly, { time: opensLabelRef.current }));
        } else if (holdTrouble) {
          // No answer at all, and also 401 / 429 / 5xx — never a hold that
          // silently did not count (A13-M31).
          setNotice(troubleText(holdTrouble, s));
        } else {
          // wrong-state / too-late / not-participant: the screen is stale.
          setNotice(null);
        }
      } finally {
        holdInFlightRef.current = false;
        setHoldBusy(false);
      }
      // The state carries the deck and the partner's view of the same moment
      // — the response is about this call, the state is about the pair.
      await load();
    },
    [load, s, startScene],
  );

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
        <TerminalGlass />
        <ButterflyLoader label={s.loading} />
      </div>
    );
  }
  if (!dateState && failures > 0) {
    return (
      <div className="ticket-page ticket-center terminal-page">
        <TerminalGlass />
        <p className="terminal-notice">{troubleText(trouble ?? "offline", s)}</p>
      </div>
    );
  }

  const inRange = withinGeofence(distanceM);
  const alone = aloneAt !== null || Boolean(match?.bump?.mine);
  const geoLine = geoNotice(geo, s);
  // A failing poll outranks the GPS line: the distance may still be live, but
  // every other word on the ticket is now as old as the last good read.
  const pollNotice = failures > 0 && trouble ? troubleText(trouble, s) : null;
  const shownNotice = notice ?? pollNotice ?? (wantsLocation(shown) ? geoLine : null);
  const openMap = (): void => {
    haptic("light");
    location.href = `canvas.html?${new URLSearchParams({ lang, theme: "dark" }).toString()}`;
  };

  return (
    <>
    <div className="ticket-page has-bar terminal-page" data-phase={shown} data-settled={settled ? "1" : undefined}>
      <TerminalGlass />
      <div className="ticket-scroll">
        <header className="ticket-header terminal-header">
          <h1>{titleFor(shown, s, timeLabel)}</h1>
          <p>{subFor(shown, s, opensLabel, alone)}</p>
        </header>

        {/* Arrival above the ticket, not under it: in the minutes before the
            date the distance is the one thing on this screen that changes, and
            below a full ticket a phone-height screen pushed it under the action
            bar. */}
        {wantsLocation(shown) && (
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

        <div className="terminal-ticket">
          <Ticket3D
            caption={venueName}
            stub={timeLabel ? { label: s.stubLabel, value: timeLabel } : null}
            torn={torn}
            strings={ticketS}
          />
        </div>

        {shown === "synced" && (
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
        {(shown === "ready" || shown === "waiting") && (
          <>
            <div className="hold-hint">
              <PlacementHint />
              <p>{s.holdHint}</p>
            </div>
            <HoldCapsule
              label={s.holdLabel}
              busy={holdBusy}
              hidden={ceremony !== null}
              onPress={onHoldPress}
              onCommit={(centerY) => void sendHold(centerY)}
            />
          </>
        )}
        {(shown === "early" || shown === "approach") &&
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
        {(shown === "synced" || shown === "closed" || shown === "no-venue-point") && (
          <button type="button" className="btn-secondary" onClick={() => app?.close()}>
            {s.close}
          </button>
        )}
        {shown !== "closed" && shown !== "synced" && (
          <button type="button" className="btn-text" onClick={openMap}>
            {s.openMap}
          </button>
        )}
      </footer>
    </div>
    {ceremony && (
      <>
        <CeremonyOverlay
          plan={ceremony.plan}
          scene={ceremony.scene}
          labels={labels}
          serverNow={clockRef.current.now}
          onHaptic={ceremonyHaptic}
          onDone={finishCeremony}
        />
        <p className="terminal-sr" role="status">
          {ceremony.scene ? `${s.ceremonyTitle}. ${s.ceremonySub}` : s.ceremonyWaiting}
        </p>
      </>
    )}
    </>
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
    case "waiting":
      return s.titleWaiting;
    case "synced":
      return s.titleSynced;
    case "no-venue-point":
      return s.titleNoVenue;
    case "closed":
      return s.titleClosed;
  }
}

function subFor(phase: TerminalPhase, s: TerminalStrings, opens: string, alone: boolean): string {
  switch (phase) {
    case "early":
      return fill(s.subEarly, { time: opens, radius: GEOFENCE_RADIUS_M });
    case "approach":
      return fill(s.subApproach, { radius: GEOFENCE_RADIUS_M });
    case "ready":
      return alone ? s.subAlone : s.subReady;
    case "waiting":
      return s.subWaiting;
    case "synced":
      return s.subSynced;
    case "no-venue-point":
      return s.subNoVenue;
    case "closed":
      return s.subClosed;
  }
}

function troubleText(trouble: ConnectionTrouble, s: TerminalStrings): string {
  return trouble === "reopen" ? s.reopenFromChat : s.offline;
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
