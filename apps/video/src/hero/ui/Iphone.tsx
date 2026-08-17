import React from "react";
import {OffthreadVideo} from "remotion";
import {asset, MUTED, SOFT, WINE} from "../theme";

/**
 * An iPhone, drawn to the real proportions of a current Pro model.
 *
 * The film is a screen recording, and a screen recording shown as a bare
 * rectangle reads as a screenshot. Inside a handset it reads as somebody using
 * the product — which is the whole claim the film is making.
 *
 * It is drawn rather than composited from a PNG mockup because no mockup asset
 * exists in this repo, and a drawn one stays sharp at any size and matches the
 * design system's own palette instead of importing a stock render's.
 *
 * **The numbers below are measurements, not taste.** The first version of this
 * component was proportioned by eye and read as a generic handset, which is
 * exactly the complaint it earned. Everything is expressed as a fraction of the
 * screen's WIDTH, taken from an iPhone 16 Pro (402 pt wide):
 *
 *  - screen corner radius 62/402 ≈ **0.145** — the single biggest tell. The
 *    first pass used 0.098, which is a rounded rectangle rather than a
 *    squircle, and no amount of bezel work compensates for it.
 *  - Dynamic Island 125 × 36.7 pt ≈ **0.315 × 0.092**, sitting 11 pt ≈ 0.028
 *    below the top of the screen. The first pass derived its height from the
 *    status bar instead, which made it a flat slot.
 *  - the black border around the display is ~0.017, and outside it a ~0.008
 *    sliver of titanium rail. Two layers, because from the front that rail IS
 *    a bright hairline and a single grey band reads as plastic.
 *
 * Three things are load-bearing rather than decorative:
 *
 *  - **The status bar is ours, not the capture's.** The recordings carry an iOS
 *    status bar with a red screen-recording pill in it, which is the one thing
 *    on screen that says "this is a demo". It is cropped away at extraction
 *    (`crop=576:1196:0:84`) and replaced here. Nothing product related is
 *    redrawn — this is OS chrome, not Gennety UI.
 *  - **Its backdrop is the clip's own top edge, mirrored and blurred.** A flat
 *    black strip is right on the Mini App screens and wrong on the Telegram
 *    ones, whose header is a light translucent blur that runs under the status
 *    bar on a real phone: against black it produced a hard horizontal seam. It
 *    is also what makes the Dynamic Island visible at all — a black pill on a
 *    black strip is invisible, and an iPhone with no island is not an iPhone.
 *  - **The screen aperture is sized from the clip's real ratio**, so footage is
 *    never stretched to fit a handset that does not match it.
 */

/** Source clip geometry, after the extraction crop. */
export const CLIP_W = 576;
export const CLIP_H = 1196;
/** Height of the iOS status bar removed at extraction, in source pixels. */
const STATUS_H = 84;

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
  const statusHeight = STATUS_H * k;
  const videoHeight = CLIP_H * k;
  const screenHeight = statusHeight + videoHeight;

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
              display: "flex",
              flexDirection: "column",
            }}
          >
            <StatusBar
              src={src}
              trimBefore={trimBefore}
              height={statusHeight}
              videoHeight={videoHeight}
              width={w}
            />
            <OffthreadVideo
              src={asset(`footage/${src}.mp4`)}
              trimBefore={trimBefore}
              style={{width: "100%", height: videoHeight, objectFit: "cover", display: "block"}}
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

/**
 * A clean iOS status bar, replacing the recorded one.
 *
 * Deliberately generic — 9:41 is Apple's own placeholder time and carries no
 * claim about when this was captured. The backdrop is the clip's own first rows
 * mirrored upward and blurred, so the strip continues whatever is beneath it
 * instead of butting a black band against it.
 */
const StatusBar: React.FC<{
  src: string;
  trimBefore: number;
  height: number;
  videoHeight: number;
  width: number;
}> = ({src, trimBefore, height, videoHeight, width}) => {
  const fontSize = width * 0.043;
  const islandWidth = width * 0.315;
  const islandHeight = width * 0.092;
  const islandTop = width * 0.028;
  // The icons and the clock sit on the island's own centre line, as iOS puts
  // them — not on the centre of the strip.
  const centre = islandTop + islandHeight / 2;
  const iconH = height * 0.3;
  const pad = width * 0.075;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height,
        flex: "none",
        overflow: "hidden",
        background: "#000",
      }}
    >
      {/* The clip's top edge, flipped about the strip's bottom so row 0 of the
          video lands against row 0 of the strip and the seam disappears. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `translateY(${height}px) scaleY(-1)`,
          transformOrigin: "50% 0%",
        }}
      >
        <OffthreadVideo
          src={asset(`footage/${src}.mp4`)}
          trimBefore={trimBefore}
          style={{
            width: "100%",
            height: videoHeight,
            objectFit: "cover",
            display: "block",
            filter: `blur(${height * 0.28}px)`,
            transform: "scale(1.25)",
          }}
        />
      </div>
      {/* Enough scrim to keep white glyphs legible over a light Telegram
          header, not enough to turn the strip back into a black band. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(to bottom, rgba(0,0,0,0.42), rgba(0,0,0,0.16))",
        }}
      />

      <div
        style={{
          position: "absolute",
          left: pad,
          top: centre,
          transform: "translateY(-52%)",
          fontFamily: '"SF Pro Text", -apple-system, "Helvetica Neue", Roboto, Arial, sans-serif',
          fontSize,
          fontWeight: 600,
          color: SOFT,
          letterSpacing: "-0.01em",
          textShadow: "0 1px 2px rgba(0,0,0,0.35)",
        }}
      >
        9:41
      </div>

      <div
        style={{
          position: "absolute",
          left: "50%",
          top: islandTop,
          transform: "translateX(-50%)",
          width: islandWidth,
          height: islandHeight,
          borderRadius: islandHeight / 2,
          background: "#000",
        }}
      />

      <div
        style={{
          position: "absolute",
          right: pad,
          top: centre,
          transform: "translateY(-50%)",
          display: "flex",
          alignItems: "center",
          gap: height * 0.115,
          filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.35))",
        }}
      >
        {/* signal */}
        <div style={{display: "flex", alignItems: "flex-end", gap: height * 0.04}}>
          {[0.4, 0.58, 0.78, 1].map((f) => (
            <div
              key={f}
              style={{
                width: height * 0.062,
                height: iconH * f,
                borderRadius: height * 0.022,
                background: SOFT,
              }}
            />
          ))}
        </div>
        {/* wifi */}
        <svg width={iconH * 1.42} height={iconH} viewBox="0 0 20 14" fill="none">
          <path
            d="M10 12.4 7.5 9.6a3.6 3.6 0 0 1 5 0L10 12.4Z"
            fill={SOFT}
          />
          <path
            d="M4.6 6.5a8 8 0 0 1 10.8 0"
            stroke={SOFT}
            strokeWidth={1.9}
            strokeLinecap="round"
          />
          <path
            d="M1.8 3.5a12.2 12.2 0 0 1 16.4 0"
            stroke={SOFT}
            strokeWidth={1.9}
            strokeLinecap="round"
          />
        </svg>
        {/* battery */}
        <div style={{display: "flex", alignItems: "center", gap: height * 0.018}}>
          <div
            style={{
              width: iconH * 1.95,
              height: iconH,
              borderRadius: iconH * 0.32,
              border: `${Math.max(1, height * 0.024)}px solid ${MUTED}`,
              padding: height * 0.026,
              display: "flex",
              alignItems: "stretch",
            }}
          >
            <div style={{width: "78%", borderRadius: iconH * 0.16, background: SOFT}} />
          </div>
          <div
            style={{
              width: height * 0.05,
              height: iconH * 0.34,
              borderRadius: height * 0.02,
              background: MUTED,
            }}
          />
        </div>
      </div>
    </div>
  );
};
