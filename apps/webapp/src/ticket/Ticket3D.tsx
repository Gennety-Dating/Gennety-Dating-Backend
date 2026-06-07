import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import type { TicketStrings } from "./i18n.js";

/**
 * The hero Date Ticket card. Pure CSS 3D — a perspective wrapper plus a tilt
 * driven by `deviceorientation` (phone) with a pointer-move fallback (desktop
 * / Telegram Web). No WebGL, no new deps; the lavender sheen and perforated
 * stub are all CSS.
 */
export function Ticket3D(props: {
  myName: string;
  partnerName: string | null;
  strings: TicketStrings;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Clamp helper — keep the tilt subtle and premium, not seasick.
    const clamp = (v: number, max = 12): number => Math.max(-max, Math.min(max, v));

    const setTilt = (rx: number, ry: number): void => {
      el.style.setProperty("--rx", `${clamp(rx)}deg`);
      el.style.setProperty("--ry", `${clamp(ry)}deg`);
    };

    const onOrient = (e: DeviceOrientationEvent): void => {
      // beta = front/back tilt, gamma = left/right tilt.
      const beta = e.beta ?? 0; // -180..180
      const gamma = e.gamma ?? 0; // -90..90
      setTilt((beta - 35) * 0.25, gamma * 0.3);
    };

    const onPointer = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5; // -0.5..0.5
      const py = (e.clientY - r.top) / r.height - 0.5;
      setTilt(-py * 20, px * 24);
    };

    window.addEventListener("deviceorientation", onOrient, true);
    window.addEventListener("pointermove", onPointer);
    return () => {
      window.removeEventListener("deviceorientation", onOrient, true);
      window.removeEventListener("pointermove", onPointer);
    };
  }, []);

  const s = props.strings;
  const holders = props.partnerName ? `${props.myName} & ${props.partnerName}` : props.myName;

  return (
    <div className="ticket-stage">
      <div className="ticket-card" ref={ref}>
        <div className="ticket-sheen" aria-hidden="true" />
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
        </div>
        <div className="ticket-perf" aria-hidden="true" />
        <div className="ticket-stub">
          <span className="ticket-stub-emoji">🎟️</span>
          <span className="ticket-stub-text">{s.ticketStub}</span>
        </div>
      </div>
      <div className="ticket-shadow" aria-hidden="true" />
    </div>
  );
}
