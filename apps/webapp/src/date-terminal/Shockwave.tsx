import { useEffect, useRef } from "react";
import type { MutableRefObject, ReactElement } from "react";

/**
 * The Liquid Glass Shockwave — the terminal's answer to a hand shaking the
 * phone.
 *
 * Two layers, because neither can do the whole job:
 *
 *   1. A canvas UNDER the page — the dark glass itself. It paints its own
 *      texture (burgundy glows and faint caustic lines) so it can bend it for
 *      real: each wave clips a moving annulus and redraws the texture magnified
 *      about the wave's origin, which is what refraction through a travelling
 *      lens looks like — the caustic lines visibly kink as the ring passes.
 *   2. A canvas cannot read the DOM above it, so a masked ring of
 *      `backdrop-filter` OVER the page carries the same wave across the ticket
 *      and the text: blur, brightness and saturation inside the annulus.
 *      `backdrop-filter: url(#svg)` would displace instead of blur, but WebKit
 *      — every iPhone — does not apply SVG filters there, and this screen is
 *      held in an iPhone.
 *
 * One rAF loop drives both and stops the moment the last wave dies, so an idle
 * terminal costs nothing. `prefers-reduced-motion` gets no waves at all; the
 * haptics carry the feedback alone.
 */

export interface ShockwaveHandle {
  /** A wave from (x, y) in CSS px; `strength` 0..1 scales its size and punch. */
  fire(x: number, y: number, strength: number): void;
}

interface Wave {
  x: number;
  y: number;
  strength: number;
  born: number;
  ring: HTMLDivElement;
}

const WAVE_MS = 1100;
const MAX_WAVES = 4;
/** Above 2× the texture costs memory and fill-rate the eye cannot see on glass. */
const DPR_CAP = 2;
const GLASS_BASE = "#030303";

export function Shockwave(props: {
  handleRef: MutableRefObject<ShockwaveHandle | null>;
}): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const { handleRef } = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    const layer = layerRef.current;
    const ctx = canvas?.getContext("2d") ?? null;
    if (!canvas || !layer || !ctx) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let texture: HTMLCanvasElement | null = null;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    const waves: Wave[] = [];

    const drawStatic = (): void => {
      if (!texture) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(texture, 0, 0);
    };

    const paintTexture = (): void => {
      dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const next = document.createElement("canvas");
      next.width = canvas.width;
      next.height = canvas.height;
      const t = next.getContext("2d");
      if (!t) return;
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

      // Caustic lines: faint enough to read as the glass's own grain, strong
      // enough that the refraction has something to bend.
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
      texture = next;
      drawStatic();
    };

    const frame = (now: number): void => {
      if (!texture) return;
      drawStatic();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const diagonal = Math.hypot(width, height);

      for (let i = waves.length - 1; i >= 0; i -= 1) {
        const wave = waves[i]!;
        const t = (now - wave.born) / WAVE_MS;
        if (t >= 1) {
          wave.ring.remove();
          waves.splice(i, 1);
          continue;
        }
        const travel = 1 - (1 - t) ** 3;
        const envelope = (1 - t) ** 1.6 * (0.45 + wave.strength * 0.55);
        const radius = travel * diagonal * (0.55 + wave.strength * 0.45);
        const band = 26 + wave.strength * 30;

        // 1) Refraction: the glass inside the moving annulus, magnified about
        //    the origin — a lens travelling outward.
        ctx.save();
        ctx.beginPath();
        ctx.arc(wave.x, wave.y, radius + band, 0, Math.PI * 2);
        ctx.arc(wave.x, wave.y, Math.max(0, radius - band), 0, Math.PI * 2, true);
        ctx.clip();
        const zoom = 1 + 0.12 * envelope;
        ctx.translate(wave.x, wave.y);
        ctx.scale(zoom, zoom);
        ctx.translate(-wave.x, -wave.y);
        ctx.drawImage(texture, 0, 0, width, height);
        ctx.restore();

        // 2) The leading edge catches light and a little burgundy; the
        //    trailing edge sits in the lens's own shadow.
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = `rgba(255, 255, 255, ${(0.5 * envelope).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(wave.x, wave.y, radius + band * 0.55, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 3;
        ctx.strokeStyle = `rgba(226, 118, 145, ${(0.34 * envelope).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(wave.x, wave.y, radius + band * 0.85, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = `rgba(0, 0, 0, ${(0.5 * envelope).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(wave.x, wave.y, Math.max(0, radius - band * 0.7), 0, Math.PI * 2);
        ctx.stroke();

        // 3) The same wave across the page, through the backdrop ring.
        const style = wave.ring.style;
        style.setProperty("--r", `${radius.toFixed(1)}px`);
        style.setProperty("--w", `${band.toFixed(1)}px`);
        style.setProperty("--blur", `${(0.8 + 4.5 * envelope).toFixed(2)}px`);
        style.opacity = String(Math.min(1, envelope * 1.6));
      }

      if (waves.length > 0) {
        raf = requestAnimationFrame(frame);
      } else {
        raf = 0;
        drawStatic();
      }
    };

    handleRef.current = {
      fire(x: number, y: number, strength: number): void {
        if (reduced || !texture) return;
        if (waves.length >= MAX_WAVES) waves.shift()?.ring.remove();
        const ring = document.createElement("div");
        ring.className = "shock-ring";
        ring.style.setProperty("--x", `${x}px`);
        ring.style.setProperty("--y", `${y}px`);
        layer.appendChild(ring);
        waves.push({ x, y, strength: Math.max(0, Math.min(1, strength)), born: performance.now(), ring });
        if (raf === 0) raf = requestAnimationFrame(frame);
      },
    };

    paintTexture();
    window.addEventListener("resize", paintTexture);
    return () => {
      window.removeEventListener("resize", paintTexture);
      cancelAnimationFrame(raf);
      for (const wave of waves) wave.ring.remove();
      handleRef.current = null;
    };
  }, [handleRef]);

  return (
    <>
      <canvas className="terminal-glass" ref={canvasRef} aria-hidden="true" />
      <div className="shock-layer" ref={layerRef} aria-hidden="true" />
    </>
  );
}
