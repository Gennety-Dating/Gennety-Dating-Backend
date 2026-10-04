import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import { Ceremony, type CeremonyHapticId, type CeremonyPlan, type CeremonyRole } from "./ceremony-stand.js";
import { dueHaptics, hapticsFor, localizeFrame, type CeremonyLabels } from "./adapter.js";
import {
  CEREMONY_FADE_MS,
  CEREMONY_LINGER_MS,
  backdropBlurPx,
  paintCeremony,
  paintWaiting,
} from "./overlay.js";
import { Render } from "./render-stand.js";

/** Above 3× the canvas costs fill-rate the eye cannot see. */
const DPR_CAP = 3;

export interface CeremonyOverlayProps {
  plan: CeremonyPlan;
  /** Null while the hold waits for the server: only the waiting capsule. */
  scene: { role: CeremonyRole; startAt: number } | null;
  labels: CeremonyLabels;
  /** The server's clock now (ms) — `ServerClock.now`. */
  serverNow: () => number;
  onHaptic: (id: CeremonyHapticId) => void;
  /** The scene has played and faded; the terminal takes the screen back. */
  onDone: () => void;
}

/**
 * The meeting ceremony, full screen, over the terminal. One canvas the size of
 * the viewport, device-pixel sharp, `pointer-events: none`; under it a
 * backdrop blur carries the stand's defocus of the screen below.
 *
 * Every frame is the stand's pure function of scene time — (server now −
 * `startAt`) — so a phone whose answer came late simply enters mid-scene, and
 * one that arrives after the end shows the final plaque.
 */
export function CeremonyOverlay(props: CeremonyOverlayProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const [fading, setFading] = useState(false);
  const live = useRef(props);
  live.current = props;

  const { plan, scene } = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d") ?? null;
    if (!canvas || !ctx) return;
    const d = plan.A.d;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    canvas.width = Math.round(d.w * dpr);
    canvas.height = Math.round(d.h * dpr);
    canvas.style.width = `${d.w}px`;
    canvas.style.height = `${d.h}px`;
    Render.setPixelRatio(dpr);

    const haptics = scene ? hapticsFor(plan, scene.role) : [];
    let prevT: number | null = null;
    let endAt: number | null = null;
    let lastBlur = -1;
    let raf = 0;
    let fadeTimer = 0;

    const draw = (): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, d.w, d.h);
      if (!scene) {
        paintWaiting(ctx, plan, live.current.labels.waiting, performance.now());
        raf = requestAnimationFrame(draw);
        return;
      }
      const t = live.current.serverNow() - scene.startAt;
      const frame = localizeFrame(Ceremony.frame(plan, scene.role, t), live.current.labels);
      paintCeremony(ctx, frame, d.w, d.h);

      const blur = backdropBlurPx(frame.blur);
      if (veilRef.current && Math.abs(blur - lastBlur) > 0.05) {
        lastBlur = blur;
        const value = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
        veilRef.current.style.backdropFilter = value;
        veilRef.current.style.setProperty("-webkit-backdrop-filter", value);
      }

      if (prevT !== null) for (const id of dueHaptics(haptics, prevT, t)) live.current.onHaptic(id);
      prevT = t;

      // Linger on the final plaque, counted from whichever is later: the end
      // of the scene, or the moment this phone joined it.
      if (endAt === null) endAt = Math.max(plan.tEnd, t) + CEREMONY_LINGER_MS;
      if (t >= endAt) {
        setFading(true);
        fadeTimer = window.setTimeout(() => live.current.onDone(), CEREMONY_FADE_MS);
        return;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(fadeTimer);
    };
  }, [plan, scene]);

  return (
    <div
      className={fading ? "ceremony-layer is-fading" : "ceremony-layer"}
      style={{ transitionDuration: `${CEREMONY_FADE_MS}ms` }}
      aria-hidden="true"
    >
      <div className="ceremony-veil" ref={veilRef} />
      <canvas className="ceremony-canvas" ref={canvasRef} />
    </div>
  );
}
