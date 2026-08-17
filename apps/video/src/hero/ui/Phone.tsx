import React from "react";
import {OffthreadVideo} from "remotion";
import {asset, OUTLINE, SCREEN_RATIO, WINE} from "../theme";

/**
 * The device frame.
 *
 * It exists to crop, not to decorate: the capture carries Telegram's Russian
 * nav row and a red "Beta Dev" badge, and this is what keeps them off screen.
 * So it is the least frame that still reads as a phone — a radius, a 1px
 * `#1a1a1a` border and a diffused burgundy glow, which is the design system's
 * "borders over shadows, glow over drop-shadow" rule verbatim.
 *
 * The screen box is derived from `SCREEN_RATIO`, so the frame can never
 * disagree with the footage inside it.
 */
export const Phone: React.FC<{
  src: string;
  /** Screen width in composition px. Height follows the capture's ratio. */
  width: number;
  trimBefore: number;
  x?: number;
  y?: number;
  scale?: number;
  rotate?: number;
  /** Glow strength. 0 turns it off for shots that sit on their own light. */
  glow?: number;
}> = ({src, width, trimBefore, x = 0, y = 0, scale = 1, rotate = 0, glow = 1}) => {
  const height = width / SCREEN_RATIO;
  const radius = width * 0.075;

  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width,
        height,
        transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale}) rotate(${rotate}deg)`,
      }}
    >
      {glow > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: -width * 0.34,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${WINE}${Math.round(
              glow * 62,
            )
              .toString(16)
              .padStart(2, "0")} 0%, rgba(3,3,3,0) 72%)`,
            filter: `blur(${width * 0.1}px)`,
          }}
        />
      ) : null}

      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: radius,
          border: `1px solid ${OUTLINE}`,
          overflow: "hidden",
          background: "#000",
          boxShadow: "0 40px 120px rgba(0,0,0,0.75)",
        }}
      >
        <OffthreadVideo
          src={asset(src)}
          trimBefore={trimBefore}
          style={{width: "100%", height: "100%", objectFit: "cover"}}
        />
      </div>
    </div>
  );
};
