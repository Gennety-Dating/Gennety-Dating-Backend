import React from "react";
import {OffthreadVideo} from "remotion";
import {asset, MUTED, SOFT, WINE} from "../theme";

/**
 * An iPhone, drawn.
 *
 * The film is a screen recording, and a screen recording shown as a bare
 * rectangle reads as a screenshot. Inside a handset it reads as somebody using
 * the product — which is the whole claim the film is making.
 *
 * It is drawn rather than composited from a PNG mockup because no mockup asset
 * exists in this repo, and a drawn one stays sharp at any size and matches the
 * design system's own palette instead of importing a stock render's.
 *
 * Two details are load-bearing rather than decorative:
 *
 *  - **The status bar is ours, not the capture's.** The recordings carry an iOS
 *    status bar with a red screen-recording pill in it, which is the one thing
 *    on screen that says "this is a demo". It is cropped away at extraction
 *    (`crop=576:1196:0:84`) and replaced here with a clean one. Nothing product
 *    related is redrawn — this is OS chrome, not Gennety UI.
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
  const k = screenWidth / CLIP_W;
  const statusHeight = STATUS_H * k;
  const videoHeight = CLIP_H * k;
  const screenHeight = statusHeight + videoHeight;

  // Proportions taken from a modern iPhone: a thin uniform bezel, a body radius
  // slightly larger than the screen's, and a Dynamic Island a little under a
  // fifth of the screen wide.
  const bezel = screenWidth * 0.021;
  const screenRadius = screenWidth * 0.098;
  const bodyRadius = screenRadius + bezel;
  const bodyWidth = screenWidth + bezel * 2;
  const bodyHeight = screenHeight + bezel * 2;
  const islandWidth = screenWidth * 0.31;
  const islandHeight = statusHeight * 0.42;

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

      {/* Titanium body. The gradient is the rim catching light from above-left,
          which is what stops a black phone on a black ground reading as a hole. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: bodyRadius,
          background:
            "linear-gradient(150deg, #4a4a4e 0%, #232326 18%, #141416 46%, #232326 82%, #55555a 100%)",
          boxShadow: "0 50px 130px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.05)",
          padding: bezel,
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
          <StatusBar height={statusHeight} width={screenWidth} islandWidth={islandWidth} islandHeight={islandHeight} />
          <OffthreadVideo
            src={asset(`footage/${src}.mp4`)}
            trimBefore={trimBefore}
            style={{width: "100%", height: videoHeight, objectFit: "cover", display: "block"}}
          />
        </div>
      </div>

      {/* Side buttons — small, but their absence is what makes a drawn phone
          look like a rounded rectangle rather than a device. */}
      <Button side="left" top={0.19} len={0.032} h={bodyHeight} r={bezel} />
      <Button side="left" top={0.255} len={0.055} h={bodyHeight} r={bezel} />
      <Button side="left" top={0.325} len={0.055} h={bodyHeight} r={bezel} />
      <Button side="right" top={0.235} len={0.085} h={bodyHeight} r={bezel} />
    </div>
  );
};

const Button: React.FC<{
  side: "left" | "right";
  top: number;
  len: number;
  h: number;
  r: number;
}> = ({side, top, len, h, r}) => (
  <div
    style={{
      position: "absolute",
      [side]: -r * 0.28,
      top: h * top,
      width: r * 0.34,
      height: h * len,
      borderRadius: r * 0.2,
      background:
        side === "left"
          ? "linear-gradient(90deg, #55555a, #2a2a2d)"
          : "linear-gradient(90deg, #2a2a2d, #55555a)",
    }}
  />
);

/**
 * A clean iOS status bar, replacing the recorded one. Deliberately generic —
 * 9:41 is Apple's own placeholder time and carries no claim about when this
 * was captured.
 */
const StatusBar: React.FC<{
  height: number;
  width: number;
  islandWidth: number;
  islandHeight: number;
}> = ({height, width, islandWidth, islandHeight}) => {
  const fontSize = height * 0.34;
  const pad = width * 0.075;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height,
        flex: "none",
        background: "#000",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: pad,
          top: "50%",
          transform: "translateY(-46%)",
          fontFamily: "Roboto, Arial, sans-serif",
          fontSize,
          fontWeight: 700,
          color: SOFT,
          letterSpacing: "0.01em",
        }}
      >
        9:41
      </div>

      <div
        style={{
          position: "absolute",
          left: "50%",
          top: height * 0.26,
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
          top: "50%",
          transform: "translateY(-50%)",
          display: "flex",
          alignItems: "center",
          gap: height * 0.13,
        }}
      >
        {/* signal */}
        <div style={{display: "flex", alignItems: "flex-end", gap: height * 0.045}}>
          {[0.22, 0.33, 0.44, 0.55].map((f) => (
            <div
              key={f}
              style={{
                width: height * 0.07,
                height: height * f,
                borderRadius: height * 0.03,
                background: SOFT,
              }}
            />
          ))}
        </div>
        {/* wifi */}
        <svg width={height * 0.5} height={height * 0.38} viewBox="0 0 16 12">
          <path
            d="M8 11.2 5.4 8.3a3.9 3.9 0 0 1 5.2 0L8 11.2Zm-4.3-4.8a6.6 6.6 0 0 1 8.6 0l1.4-1.6a8.7 8.7 0 0 0-11.4 0l1.4 1.6Z"
            fill={SOFT}
          />
        </svg>
        {/* battery */}
        <div
          style={{
            width: height * 0.56,
            height: height * 0.28,
            borderRadius: height * 0.08,
            border: `${Math.max(1, height * 0.026)}px solid ${MUTED}`,
            padding: height * 0.035,
            display: "flex",
            alignItems: "stretch",
          }}
        >
          <div style={{width: "72%", borderRadius: height * 0.03, background: SOFT}} />
        </div>
      </div>
    </div>
  );
};
