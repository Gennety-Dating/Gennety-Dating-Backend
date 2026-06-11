import { useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import type { TicketStrings } from "./i18n.js";

/**
 * The hero Date Ticket card. Pure CSS 3D — no WebGL, no new deps.
 *
 * Interaction model:
 * - Drag (pointer) to grab and rotate the ticket freely, with inertia on
 *   release and a spring back to the ambient pose.
 * - `deviceorientation` drives a subtle ambient tilt on phones when idle.
 * - The glare highlight, holographic film, and floor shadow all track the
 *   current rotation through CSS custom properties.
 */

/** FNV-1a — stable serial + barcode pattern from the holder names. */
function fnv1a(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const DRAG_MAX = 38;
const AMBIENT_MAX = 9;

export function Ticket3D(props: {
  myName: string;
  partnerName: string | null;
  strings: TicketStrings;
}): ReactElement {
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const holders = props.partnerName ? `${props.myName} & ${props.partnerName}` : props.myName;

  // Deterministic "printed" details so the ticket looks issued, not templated.
  const { serial, bars } = useMemo(() => {
    const seed = fnv1a(holders);
    const hex = (seed % 0xffffff).toString(16).toUpperCase().padStart(6, "0");
    // Seeded LCG → pseudo-random barcode stripe widths (2..5 px).
    let x = seed || 1;
    const widths = Array.from({ length: 26 }, () => {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      return 2 + (x % 4);
    });
    return { serial: `GD-${hex}`, bars: widths };
  }, [holders]);

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
      // Glare highlight slides opposite the tilt, like light on gloss.
      card.style.setProperty("--gx", `${(50 + ry * 1.9).toFixed(1)}%`);
      card.style.setProperty("--gy", `${(46 - rx * 1.9).toFixed(1)}%`);
      // Holographic film shifts its hue band as the card turns.
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

  return (
    <div className="ticket-stage" ref={stageRef}>
      <div className="ticket-float">
        <div className="ticket-card" ref={cardRef}>
          <div className="ticket-glare" aria-hidden="true" />
          <div className="ticket-holo" aria-hidden="true" />
          <div className="ticket-main">
            <div className="ticket-brand">
              <span className="ticket-brand-mark">GENNETY</span>
              <span className="ticket-brand-sub">{s.ticketHolders}</span>
            </div>
            <div className="ticket-names" title={holders}>
              {holders}
            </div>
            <div className="ticket-label">{s.ticketLabel}</div>
            <div className="ticket-tagline">{s.ticketTagline}</div>
            <div className="ticket-meta">
              <span className="ticket-serial">№ {serial}</span>
              <span className="ticket-heart" aria-hidden="true">
                ♥
              </span>
            </div>
          </div>
          <div className="ticket-perf" aria-hidden="true" />
          <div className="ticket-stub">
            <div className="ticket-barcode" aria-hidden="true">
              {bars.map((w, i) => (
                <span key={i} style={{ width: `${w}px` }} />
              ))}
            </div>
            <span className="ticket-stub-text">{s.ticketStub}</span>
          </div>
        </div>
      </div>
      <div className="ticket-shadow" aria-hidden="true" />
    </div>
  );
}
