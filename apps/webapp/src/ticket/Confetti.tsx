import { useEffect, useRef } from "react";
import type { ReactElement } from "react";

/**
 * Lightweight one-shot confetti burst on an inline <canvas>. No dependency —
 * a few hundred gravity-driven rects in brand colors, then it fades. Mounted
 * only on the success screen.
 */
const COLORS = ["#B69AE5", "#8E6FD6", "#F4ECFF", "#D9C7FF", "#ffffff"];

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  color: string;
}

export function Confetti(): ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = (canvas.width = canvas.offsetWidth * dpr);
    const h = (canvas.height = canvas.offsetHeight * dpr);

    const pieces: Piece[] = Array.from({ length: 140 }, () => ({
      x: w / 2 + (Math.random() - 0.5) * w * 0.3,
      y: h * 0.3 + (Math.random() - 0.5) * h * 0.1,
      vx: (Math.random() - 0.5) * 10 * dpr,
      vy: (Math.random() - 1.1) * 9 * dpr,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      size: (4 + Math.random() * 5) * dpr,
      color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    }));

    let raf = 0;
    const start = performance.now();
    const gravity = 0.18 * dpr;

    const tick = (now: number): void => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, w, h);
      for (const p of pieces) {
        p.vy += gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, 1 - elapsed / 2600);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
      if (elapsed < 2600) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas className="confetti-canvas" ref={ref} aria-hidden="true" />;
}
