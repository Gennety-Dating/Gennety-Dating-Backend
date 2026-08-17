import React from "react";
import {INK} from "../theme";

/**
 * Vignette + grain, applied once at the composition level rather than per
 * scene, so the film reads as one piece of stock instead of eleven clips that
 * happen to be adjacent. Both are deliberately weak: the product's own screens
 * are already near-black, and anything heavier starts eating the UI.
 */
export const Vignette: React.FC<{strength?: number}> = ({strength = 0.55}) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      pointerEvents: "none",
      background: `radial-gradient(ellipse at 50% 48%, rgba(0,0,0,0) 42%, rgba(0,0,0,${strength}) 100%)`,
    }}
  />
);

/**
 * Static SVG feTurbulence grain. Static on purpose — an animated seed would
 * shimmer at 30fps and read as encoder noise.
 */
export const Grain: React.FC<{opacity?: number}> = ({opacity = 0.055}) => (
  <svg
    style={{position: "absolute", inset: 0, pointerEvents: "none", opacity}}
    width="100%"
    height="100%"
  >
    <filter id="hero-grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={3} stitchTiles="stitch" />
      <feColorMatrix type="saturate" values="0" />
    </filter>
    <rect width="100%" height="100%" filter="url(#hero-grain)" />
  </svg>
);

/** Full-frame black, used for the hard cut into the brand turn. */
export const Blackout: React.FC<{opacity: number}> = ({opacity}) => (
  <div style={{position: "absolute", inset: 0, background: INK, opacity}} />
);
