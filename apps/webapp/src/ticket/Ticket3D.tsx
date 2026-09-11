import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import { ButterflyMark, TicketMark } from "./marks.js";
import type { TicketStrings } from "./i18n.js";
import { tearPolygons, type TearPolygons } from "./tear.js";

/**
 * The hero Date Ticket card. Pure CSS 3D — no WebGL, no new deps.
 *
 * What it prints, and what it deliberately does not:
 * - the wordmark, the brand butterfly, and — on the stub — the wallet count
 *   under its own printed field name;
 * - NOT a barcode. It was the one element on the card that encoded nothing:
 *   seeded stripes that scan to no record and mean nothing to the person
 *   holding the ticket. The stub now prints BALANCE ▸ N instead, which is the
 *   same ticket idiom (a field name on the left, its value on the right) doing
 *   an actual job: it says what the number in the corner IS. The object still
 *   reads as a ticket from the perforation, the real notch cutouts and the
 *   stub itself.
 * - NOT "Admit two" / "На двоих". One ticket admits ONE person — a man paying
 *   $16.98 "for us both" buys TWO of them (PRODUCT_SPEC §3.5b) — so that line
 *   was telling a user who pays for their own slot that their partner is
 *   already covered. It is gone from the header and from the stub.
 * - NOT the "curated date ticket" label or the marketing tagline. The
 *   perforation, the real notch cutouts and the stub say what the object is;
 *   the screen's own headline says the rest.
 * - NOT a printed serial. It was the last piece of small grey type left on the
 *   card, and it bought nothing: it identifies no real record, and a user who
 *   reads it learns a hex string. Its space goes to the mark.
 *
 * The Date Terminal (2026-09-11) uses the same card with three optional
 * props, all inert by default so the gate and the store render exactly as
 * before: `caption` prints the venue where the names go, `stub` prints the
 * admission time where the wallet count goes, and `torn` tears the card along
 * its perforation on a server-confirmed Contact Sync — the stub falls away,
 * the main part lifts. The tear is a second copy of the card clipped below one
 * shared jagged edge (`tear.ts`), so both pieces keep the real stock, the foil
 * and the notch cutouts, and rotate together.
 *
 * Interaction model:
 * - Drag (pointer) to grab and rotate the ticket freely, with inertia on
 *   release and a spring back to the ambient pose.
 * - `deviceorientation` drives a subtle ambient tilt on phones when idle.
 * - The holographic film and the floor shadow track the current rotation
 *   through CSS custom properties. There is no specular streak: a highlight
 *   drawn by us is a guess about a light source the page does not have, and
 *   every version of it read as painted-on rather than as a reflection.
 */

const DRAG_MAX = 38;
const AMBIENT_MAX = 9;

export function Ticket3D(props: {
  /** Printed under the mark on the gate. The store's card carries no names. */
  myName?: string | null;
  partnerName?: string | null;
  /**
   * Wallet count printed on the stub. Null/0 leaves the stub blank — an
   * unprinted stub, which is a real thing a ticket can have, where "Balance 0"
   * would read as a rendering fault. The stub keeps its height either way, so
   * the tear line never moves between screens.
   */
  balance?: number | null;
  /** Printed under the mark INSTEAD of the names — the terminal prints the venue. */
  caption?: string | null;
  /** The stub's one field INSTEAD of the wallet count — the terminal's admission time. */
  stub?: { label: string; value: string } | null;
  /** Tear along the perforation. One-way: the terminal sets it on a confirmed sync. */
  torn?: boolean;
  strings: TicketStrings;
}): ReactElement {
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const perfRef = useRef<HTMLDivElement>(null);
  const stubPieceRef = useRef<HTMLDivElement>(null);
  const [tear, setTear] = useState<TearPolygons | null>(null);

  // Expose the tear-line Y to CSS so the card can punch *real* notch holes
  // there (a mask that lets the page show through), rather than faking them
  // with filled circles. Recomputed on any layout change (name length, whether
  // names are printed at all, etc.).
  useEffect(() => {
    const card = cardRef.current;
    const perf = perfRef.current;
    if (!card || !perf) return;
    const sync = (): void => {
      card.style.setProperty("--perf-y", `${perf.offsetTop}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(card);
    return () => ro.disconnect();
  }, []);

  // The tear is measured off the laid-out card, so it can only be cut once the
  // card exists: the edge follows the perforation wherever the content put it.
  const torn = props.torn === true;
  useEffect(() => {
    if (!torn) {
      setTear(null);
      return;
    }
    const card = cardRef.current;
    const perf = perfRef.current;
    if (!card || !perf) return;
    setTear(tearPolygons(card.offsetWidth, perf.offsetTop));
  }, [torn]);

  const holders =
    props.caption ??
    (props.myName
      ? props.partnerName
        ? `${props.myName} & ${props.partnerName}`
        : props.myName
      : null);

  useEffect(() => {
    const card = cardRef.current;
    const stage = stageRef.current;
    if (!card || !stage) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const clamp = (v: number, max: number): number => Math.max(-max, Math.min(max, v));

    // rx/ry = rendered angles, tx/ty = target, ax/ay = ambient (gyro) pose,
    // vx/vy = inertial velocity carried past pointer release.
    let rx = 0;
    let ry = 0;
    let tx = 0;
    let ty = 0;
    let ax = 0;
    let ay = 0;
    let vx = 0;
    let vy = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let raf = 0;

    const apply = (): void => {
      // The torn stub is a second card and has to turn with the first one, or
      // the two halves of one ticket would visibly disagree about its angle.
      for (const el of [card, stubPieceRef.current]) {
        if (!el) continue;
        el.style.setProperty("--rx", `${rx.toFixed(2)}deg`);
        el.style.setProperty("--ry", `${ry.toFixed(2)}deg`);
        // Holographic film shifts its hue band as the card turns. This is the
        // only surface effect left: the foil is a real property of the stock,
        // so it can shift honestly with the angle, unlike a specular highlight,
        // which needs a light source we would have to invent.
        el.style.setProperty("--holo", `${(ry * 4).toFixed(1)}px`);
      }
      // Floor shadow drifts against the rotation for a grounded feel.
      stage.style.setProperty("--sx", `${(ry * -1.4).toFixed(1)}px`);
    };

    const frame = (): void => {
      if (!dragging) {
        tx += vx;
        ty += vy;
        vx *= 0.92;
        vy *= 0.92;
        // Spring back toward the ambient pose once inertia fades.
        tx += (ax - tx) * 0.055;
        ty += (ay - ty) * 0.055;
        tx = clamp(tx, DRAG_MAX);
        ty = clamp(ty, DRAG_MAX);
      }
      rx += (tx - rx) * 0.16;
      ry += (ty - ry) * 0.16;
      apply();
      raf = requestAnimationFrame(frame);
    };

    const onOrient = (e: DeviceOrientationEvent): void => {
      // beta = front/back tilt, gamma = left/right tilt; ~35° is the natural
      // in-hand holding angle, treated as the neutral pose.
      ax = clamp(((e.beta ?? 0) - 35) * 0.18, AMBIENT_MAX);
      ay = clamp((e.gamma ?? 0) * 0.22, AMBIENT_MAX);
    };

    const onDown = (e: PointerEvent): void => {
      dragging = true;
      vx = 0;
      vy = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      card.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      ty = clamp(ty + dx * 0.45, DRAG_MAX);
      tx = clamp(tx - dy * 0.45, DRAG_MAX);
      vy = dx * 0.18;
      vx = -dy * 0.18;
    };
    const onUp = (): void => {
      dragging = false;
    };

    card.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("deviceorientation", onOrient, true);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      card.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("deviceorientation", onOrient, true);
    };
  }, []);

  const s = props.strings;
  const balance = props.balance && props.balance > 0 ? props.balance : null;

  // One face, drawn twice once the ticket is torn: the second copy is the stub
  // piece, clipped below the same edge, so it is the same paper by construction.
  const face = (primary: boolean): ReactElement => (
    <>
      <div className="ticket-holo" aria-hidden="true" />
      <div className="ticket-main">
        <div className="ticket-brand">
          <span className="ticket-brand-mark">GENNETY</span>
        </div>
        {/* The mark (and, on the gate, the pair) sit centred in whatever
            height is left over. That is what lets the card hold a fixed
            portrait proportion while one screen prints a name row and the
            other does not — the silhouette stops being a sum of its
            contents. */}
        <div className="ticket-body">
          <div className="ticket-mark" aria-hidden="true">
            <ButterflyMark />
          </div>
          {holders && (
            <div className="ticket-names" title={holders}>
              {holders}
            </div>
          )}
        </div>
      </div>
      <div className="ticket-perf" aria-hidden="true" ref={primary ? perfRef : undefined} />
      <div className="ticket-stub">
        {props.stub ? (
          <>
            <span className="ticket-stub-label" aria-hidden="true">
              {props.stub.label}
            </span>
            <span className="ticket-stub-count">{props.stub.value}</span>
          </>
        ) : (
          balance !== null && (
            <>
              {/* Field name, value. The label is what the barcode never was:
                  a reason for the number in the corner to be there. */}
              <span className="ticket-stub-label" aria-hidden="true">
                {s.balanceLabel}
              </span>
              {/* The count is the visible part; the localized sentence
                  survives as the accessible name for the pair, since
                  "Balance 🎟 × 2" read out as three fragments is not one. */}
              <span
                className="ticket-stub-count"
                aria-label={s.balanceNote.replace("{n}", String(balance))}
              >
                <TicketMark />
                <span aria-hidden="true">× {balance}</span>
              </span>
            </>
          )
        )}
      </div>
    </>
  );

  const topStyle: CSSProperties | undefined = tear
    ? { clipPath: tear.top, WebkitClipPath: tear.top }
    : undefined;
  const stubStyle = tear
    ? ({ clipPath: tear.stub, WebkitClipPath: tear.stub, "--perf-y": `${tear.perfY}px` } as CSSProperties)
    : undefined;

  return (
    <div className={tear ? "ticket-stage is-torn" : "ticket-stage"} ref={stageRef}>
      <div className="ticket-float">
        <div className={tear ? "ticket-card is-torn" : "ticket-card"} ref={cardRef} style={topStyle}>
          {face(true)}
        </div>
        {tear && (
          <div className="ticket-card ticket-stub-piece" ref={stubPieceRef} style={stubStyle} aria-hidden="true">
            {face(false)}
          </div>
        )}
      </div>
      <div className="ticket-shadow" aria-hidden="true" />
    </div>
  );
}
