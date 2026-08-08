import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { ButterflyMark, TicketMark } from "./marks.js";
import type { TicketStrings } from "./i18n.js";

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
 *   $13.98 "for us both" buys TWO of them (PRODUCT_SPEC §3.5b) — so that line
 *   was telling a user who pays for their own slot that their partner is
 *   already covered. It is gone from the header and from the stub.
 * - NOT the "curated date ticket" label or the marketing tagline. The
 *   perforation, the real notch cutouts and the stub say what the object is;
 *   the screen's own headline says the rest.
 * - NOT a printed serial. It was the last piece of small grey type left on the
 *   card, and it bought nothing: it identifies no real record, and a user who
 *   reads it learns a hex string. Its space goes to the mark.
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
  strings: TicketStrings;
}): ReactElement {
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const perfRef = useRef<HTMLDivElement>(null);

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

  const holders = props.myName
    ? props.partnerName
      ? `${props.myName} & ${props.partnerName}`
      : props.myName
    : null;

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
      card.style.setProperty("--rx", `${rx.toFixed(2)}deg`);
      card.style.setProperty("--ry", `${ry.toFixed(2)}deg`);
      // Holographic film shifts its hue band as the card turns. This is the
      // only surface effect left: the foil is a real property of the stock, so
      // it can shift honestly with the angle, unlike a specular highlight,
      // which needs a light source we would have to invent.
      card.style.setProperty("--holo", `${(ry * 4).toFixed(1)}px`);
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

  return (
    <div className="ticket-stage" ref={stageRef}>
      <div className="ticket-float">
        <div className="ticket-card" ref={cardRef}>
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
          <div className="ticket-perf" aria-hidden="true" ref={perfRef} />
          <div className="ticket-stub">
            {balance !== null && (
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
            )}
          </div>
        </div>
      </div>
      <div className="ticket-shadow" aria-hidden="true" />
    </div>
  );
}
