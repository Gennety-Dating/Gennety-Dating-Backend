import React from "react";
import {OffthreadVideo} from "remotion";
import {asset, WINE} from "../theme";

/**
 * An iPhone, drawn to the real proportions of a current Pro model.
 *
 * The film is a screen recording, and a screen recording shown as a bare
 * rectangle reads as a screenshot. Inside a handset it reads as somebody using
 * the product — which is the whole claim the film is making.
 *
 * The BODY is drawn rather than composited from a PNG mockup because no mockup
 * asset exists in this repo, a drawn one stays sharp at any size, and it can
 * use the design system's own palette.
 *
 * **The SCREEN, including its status bar, is entirely the recording.** That is
 * the part worth stating, because two earlier versions got it wrong in the same
 * way. The recordings carry an iOS status bar with a red screen-recording pill
 * in it — the one element on screen that says "this is a demo" — so the first
 * two builds cropped the whole strip away and drew a replacement. It never
 * looked native: a drawn strip keeps its own colour while the app behind it
 * changes, so it read as something pasted on at the end, which is exactly what
 * it was. The second build painted the clip's own top rows behind it, mirrored
 * and blurred, which fixed the colour and not the fact that the glyphs were
 * ours. The founder's read on both was correct.
 *
 * So nothing is cropped and nothing is redrawn. The clock, the signal bars, the
 * wifi arc, the battery and the Dynamic Island are the device's own, in the
 * device's own colours, sitting over whatever the app is showing — because they
 * ARE that frame. The single intervention is `PILL`: an opaque black rounded
 * rect laid over the recording indicator, at the pill's own measured bounds.
 * That shape is the Dynamic Island in its expanded recording state, so covering
 * it with black leaves an island rather than a patch.
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
 * The screen-recording indicator, in source pixels.
 *
 * Measured, not estimated, and measured TWICE — the first pass used a
 * confident red threshold, got x 158–415 / y 15–74, and left a visible dark-red
 * ring on the black Mini App screens, where the stroke's antialiased edge has
 * nothing to hide against. Re-scanned at a threshold low enough to catch that
 * edge, the outline runs to **x 156–417, y 14–75** in all three recordings.
 * Plus ~1px of margin. The stroke also pulses, so some frames show only the dot
 * at 176–195 / 36–53 — the cover has to fit the larger state.
 *
 * Do not enlarge it further to be safe: on the Telegram screens the island sits
 * against a light blurred header, where its edge is genuinely visible and any
 * excess reads as a black fringe.
 */
const PILL = {x: 155, y: 12, w: 264, h: 66};

export const Iphone: React.FC<{
  src: string;
  trimBefore: number;
  /** Screen width in composition px. Everything else scales from it. */
  screenWidth: number;
  scale?: number;
  y?: number;
  glow?: number;
}> = ({src, trimBefore, screenWidth, scale = 1, y = 0, glow = 0.8}) => {
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
        transform: `translate(-50%, -50%) translateY(${y}px) scale(${scale})`,
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
            <OffthreadVideo
              src={asset(`footage/${src}.mp4`)}
              trimBefore={trimBefore}
              style={{width: "100%", height: "100%", objectFit: "cover", display: "block"}}
            />

            {/* The only pixel of the capture that is covered. See PILL. */}
            <div
              style={{
                position: "absolute",
                left: PILL.x * k,
                top: PILL.y * k,
                width: PILL.w * k,
                height: PILL.h * k,
                borderRadius: (PILL.h * k) / 2,
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
