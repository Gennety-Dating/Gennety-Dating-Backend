import React from "react";
import {WINE} from "../theme";

/**
 * An iPhone, drawn to the real proportions of a current Pro model.
 *
 * **There is exactly ONE of these in the WORLD**, mounted outside every
 * `<Sequence>` and never unmounted. It is a physical object, not a decoration a
 * scene draws: it sits at world (0, 0) at a constant size, and everything the
 * viewer reads as movement is the camera moving relative to it
 * (`../camera.ts`).
 *
 * That sentence used to say "in the film", and it was narrowed on 2026-08-21
 * rather than waived. The title act's Telegram card mounts a second one
 * (`../scenes/TelegramCard.tsx`) — outside the world, after the camera has
 * ended, at a fixed size. The defect the rule exists to prevent is fifteen
 * handsets disagreeing about `scale` at every cut (`../../motion-audit.md` §3),
 * and the guard against it is the signature below, not the instance count: a
 * card cannot give a handset a transform without editing this file.
 *
 * That is why this component takes no `scale`, no `y` and no `src`. It used to
 * take all three, one instance per shot, and the fifteen instances disagreeing
 * about `scale` at every cut is the reset `../../motion-audit.md` is about. The
 * signature is the guard: a scene cannot reintroduce a per-scene phone
 * transform without changing this file.
 *
 * What DOES change is what is on the screen. The clips are passed as children
 * and land inside the aperture, under the recording-pill cover and the glass —
 * so a cut is a screen changing inside a handset that never moved.
 *
 * The film is a screen recording, and a screen recording shown as a bare
 * rectangle reads as a screenshot. Inside a handset it reads as somebody using
 * the product — which is the whole claim the film is making.
 *
 * The BODY is drawn rather than composited from a PNG mockup because no mockup
 * asset exists in this repo, a drawn one stays sharp at any size, and it can
 * use the design system's own palette.
 *
 * **The SCREEN is the recording, and its status bar is too — with exactly one
 * exception, the Dynamic Island.** That is the part worth stating, because
 * three earlier versions got it wrong in three different ways. The recordings
 * carry an iOS status bar with a screen-recording indicator in it — the one
 * element that says "this is a demo" — so the first two builds cropped the
 * whole strip away and drew a replacement. Neither looked native: a drawn strip
 * keeps its own colour while the app behind it changes, so it read as something
 * pasted on at the end, which is what it was.
 *
 * The third build stopped cropping and laid an opaque black rounded rect over
 * the indicator at its own measured bounds. That removed the red and left an
 * island — but **iOS EXPANDS the Dynamic Island while it is recording**, and
 * the cover was drawn to those expanded bounds, so it reproduced a shape 38%
 * wider than a real island and then added a few pixels of its own. The founder
 * read the result as an island that was simply too big, which is exactly what
 * it was.
 *
 * So the island is now the one thing that is NOT the recording. The footage has
 * it erased (`scripts/extract-hero-footage.sh` → `island_erase`, where the
 * measurements are), and `ISLAND` below draws a correct one. Everything else in
 * that strip — the clock, the signal bars, the wifi arc, the battery — is still
 * the device's own, in the device's own colours, over the real app.
 *
 * **Redrawing it does not reopen the failure the first two builds hit**, and
 * the difference is worth being precise about: a status BAR carries glyphs and
 * colour that have to agree with the app behind them, which is why a drawn one
 * always looked pasted on. A Dynamic Island at rest is a featureless black
 * pill. There is nothing about it to get wrong, and nothing behind it to
 * disagree with.
 *
 * The body's proportions are measurements, not taste. Everything is a fraction
 * of the screen's WIDTH, taken from an iPhone 16 Pro (402 pt wide):
 *
 *  - screen corner radius 62/402 ≈ **0.145** — the single biggest tell. An
 *    early pass used 0.098, which is a rounded rectangle rather than a
 *    squircle, and no amount of bezel work compensates for it.
 *  - the black border around the display is ~0.017, and outside it a ~0.008
 *    sliver of titanium rail. Two layers, because from the front that rail IS
 *    a bright hairline and a single grey band reads as plastic.
 *
 * The screen aperture is sized from the clip's real geometry, so footage is
 * never stretched to fit a handset that does not match it.
 */

/** Source clip geometry — the full phone screen, uncropped. */
export const CLIP_W = 576;
export const CLIP_H = 1280;

/**
 * The Dynamic Island, drawn at rest, in source pixels.
 *
 * **Not a cover.** The footage has no island in it at all — it is erased during
 * extraction and the background painted through, so this is the only island in
 * the film and it can be any size we like. What it should be is the size a real
 * one is, which is the whole point of the change.
 *
 * The width is a fraction of the SCREEN width rather than an absolute, because
 * that is how Apple specifies it and because these recordings are scaled
 * (576x1280 is 20:9; no shipping iPhone has that aspect, so the capture was
 * resized and no device's pixel dimensions can be assumed). A current Pro model
 * puts the island at 125 x 36.4 pt on a 393-402 pt screen — 0.311-0.318 of the
 * width — which lands at 179-183 px here. 181 is the middle of that, and its
 * aspect (3.48) matches the real 3.43.
 *
 * `y` is measured rather than derived: iOS grows the island DOWNWARD and
 * outward when it expands for a recording, so the expanded shape's top edge is
 * the resting one. It sat at y 17 in every clip.
 *
 * For contrast, the expanded recording island this replaces measured
 * **253 x 56 at x 160, y 17**, with a red outline reaching x 156-417 — and the
 * red dot inside it at x 176-195, near the LEFT end. That last number is why a
 * smaller cover was never an option and the footage had to be repainted: any
 * centred pill narrow enough to look right leaves the dot showing.
 */
const ISLAND = {w: 181, h: 52, y: 17};

export const Iphone: React.FC<{
  /** Screen width in world px. Everything else is laid out from it. */
  screenWidth: number;
  /** Halo strength. Driven by the world's continuous lighting curve, not per shot. */
  glow?: number;
  /** The screen. One or more clips, crossfading; see `scenes/ScreenClip.tsx`. */
  children?: React.ReactNode;
}> = ({screenWidth, glow = 0.8, children}) => {
  const w = screenWidth;
  const k = w / CLIP_W;
  const screenHeight = CLIP_H * k;

  const bezel = w * 0.017;
  const rail = w * 0.008;
  const screenRadius = w * 0.145;
  const bezelRadius = screenRadius + bezel;
  const bodyRadius = bezelRadius + rail;

  const bodyWidth = w + (bezel + rail) * 2;
  const bodyHeight = screenHeight + (bezel + rail) * 2;

  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: bodyWidth,
        height: bodyHeight,
        // Centring only. No camera here — the camera is one transform, one
        // level up, on the world (`ui/World.tsx`).
        transform: "translate(-50%, -50%)",
      }}
    >
      {glow > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: -bodyWidth * 0.3,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${WINE}${Math.round(glow * 58)
              .toString(16)
              .padStart(2, "0")} 0%, rgba(3,3,3,0) 70%)`,
            filter: `blur(${bodyWidth * 0.1}px)`,
          }}
        />
      ) : null}

      {/* Side buttons sit UNDER the body, so the rail overlaps their inner
          edge — which is what makes them read as protruding from it rather
          than as tabs stuck on the side. */}
      <Button side="left" top={0.163} len={0.033} h={bodyHeight} w={w} />
      <Button side="left" top={0.223} len={0.056} h={bodyHeight} w={w} />
      <Button side="left" top={0.294} len={0.056} h={bodyHeight} w={w} />
      <Button side="right" top={0.232} len={0.088} h={bodyHeight} w={w} />
      <Button side="right" top={0.352} len={0.045} h={bodyHeight} w={w} />

      {/* Titanium rail. From the front this is a bright hairline, not a band —
          hence the thin ring plus the inset highlight rather than a wide
          gradient body. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: bodyRadius,
          padding: rail,
          background:
            "linear-gradient(155deg, #b9b9be 0%, #6c6c72 14%, #3a3a3e 34%, #4e4e54 52%, #8f8f96 76%, #45454a 100%)",
          boxShadow: `0 ${bodyHeight * 0.05}px ${bodyHeight * 0.11}px rgba(0,0,0,0.82),
                      inset 0 0 0 ${Math.max(1, w * 0.0016)}px rgba(255,255,255,0.28)`,
        }}
      >
        {/* The black border around the display. */}
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: bezelRadius,
            padding: bezel,
            background: "#050505",
          }}
        >
          <div
            style={{
              position: "relative",
              width: "100%",
              height: "100%",
              borderRadius: screenRadius,
              overflow: "hidden",
              background: "#000",
            }}
          >
            {/* The screen. Clips stack here and crossfade; the handset around
                them does not know a cut happened. */}
            {children}

            {/* The Dynamic Island. Centred rather than positioned, because the
                footage it sits on has been repainted and there is nothing left
                underneath to line up with. See ISLAND. */}
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: ISLAND.y * k,
                width: ISLAND.w * k,
                height: ISLAND.h * k,
                marginLeft: (-ISLAND.w * k) / 2,
                borderRadius: (ISLAND.h * k) / 2,
                background: "#000",
              }}
            />

            {/* Glass. A single faint raking sheen across the top-left corner —
                enough to say "this is behind glass", far too weak to compete
                with the product UI underneath. */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
                background:
                  "linear-gradient(118deg, rgba(255,255,255,0.055) 0%, rgba(255,255,255,0.018) 22%, rgba(255,255,255,0) 42%)",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

const Button: React.FC<{
  side: "left" | "right";
  top: number;
  len: number;
  h: number;
  w: number;
}> = ({side, top, len, h, w}) => (
  <div
    style={{
      position: "absolute",
      [side]: -w * 0.006,
      top: h * top,
      width: w * 0.014,
      height: h * len,
      borderRadius: w * 0.005,
      background:
        side === "left"
          ? "linear-gradient(90deg, #9a9aa0, #4a4a4f 60%, #2b2b2f)"
          : "linear-gradient(90deg, #2b2b2f, #4a4a4f 40%, #9a9aa0)",
    }}
  />
);
