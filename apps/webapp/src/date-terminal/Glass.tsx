import { useEffect, useRef } from "react";
import type { ReactElement } from "react";

/**
 * The terminal's dark glass — a canvas UNDER the page painting its own texture:
 * two burgundy glows and faint caustic lines, the grain of the glass.
 *
 * Until 2026-09-29 this was the Liquid Glass Shockwave: every swing of a
 * shaking hand, and the sync itself, sent a refracting wave through the glass
 * and a masked backdrop ring across the page. The hold replaced the shake and
 * the meeting ceremony replaced the climax, so nothing fires a wave any more;
 * only the glass is left, painted once per size.
 */

/** Above 2× the texture costs memory and fill-rate the eye cannot see on glass. */
const DPR_CAP = 2;
const GLASS_BASE = "#030303";

export function TerminalGlass(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d") ?? null;
    if (!canvas || !ctx) return;

    const paintTexture = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      const width = window.innerWidth;
      const height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const t = ctx;
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.scale(dpr, dpr);
      t.fillStyle = GLASS_BASE;
      t.fillRect(0, 0, width, height);

      const glow = (x: number, y: number, radius: number, color: string): void => {
        const gradient = t.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, "rgba(3, 3, 3, 0)");
        t.fillStyle = gradient;
        t.fillRect(0, 0, width, height);
      };
      const reach = Math.max(width, height);
      glow(width * 0.18, height * 0.08, reach * 0.7, "rgba(182, 48, 79, 0.2)");
      glow(width * 0.9, height * 0.95, reach * 0.6, "rgba(139, 37, 59, 0.16)");

      // Caustic lines: faint enough to read as the glass's own grain.
      t.lineWidth = 1;
      const rows = 22;
      for (let i = 0; i < rows; i += 1) {
        const baseY = (height / rows) * i;
        t.strokeStyle = `rgba(255, 255, 255, ${0.022 + (i % 3) * 0.008})`;
        t.beginPath();
        for (let x = 0; x <= width; x += 12) {
          const y = baseY + Math.sin(x / 57 + i * 1.7) * 9 + Math.sin(x / 23 + i) * 3;
          if (x === 0) t.moveTo(x, y);
          else t.lineTo(x, y);
        }
        t.stroke();
      }
    };

    paintTexture();
    window.addEventListener("resize", paintTexture);
    return () => window.removeEventListener("resize", paintTexture);
  }, []);

  return <canvas className="terminal-glass" ref={canvasRef} aria-hidden="true" />;
}
