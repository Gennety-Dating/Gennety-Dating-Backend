/** Types for the vendored renderer subset (`render-stand.js`). */

import type { CeremonyCapsule, CeremonyMascot, CeremonyPlaque } from "./ceremony-stand.js";

export interface CeremonyPalette {
  base: string;
  ink: string;
  muted: string;
  faint: string;
  accent: string;
  accentInk: string;
  glass: string;
  glassEdge: string;
  glassHi: string;
  panel: string;
  /** Prefix of an rgba() — append `<alpha>)`. */
  wash: string;
}

export declare const Render: {
  palette(dark: boolean): CeremonyPalette;
  mascot(ctx: CanvasRenderingContext2D, m: CeremonyMascot | null): void;
  mark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color?: string): void;
  capsule(ctx: CanvasRenderingContext2D, c: CeremonyCapsule | null, pal: CeremonyPalette, t: number): void;
  plaque(ctx: CanvasRenderingContext2D, q: CeremonyPlaque | null, pal: CeremonyPalette): void;
  plaqueMarkDX(title: string, sub: string): number;
  placementHint(ctx: CanvasRenderingContext2D, cx: number, cy: number, pal: CeremonyPalette): void;
  setFonts(display: string, sys: string): void;
  setPixelRatio(px: number): void;
};
