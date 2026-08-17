import React from "react";
import {OffthreadVideo} from "remotion";
import {asset, OUTLINE, WINE} from "../theme";

/**
 * The panel a captured screen sits in.
 *
 * It exists to crop, not to decorate: the recordings carry an iOS status bar
 * with a red recording dot, Telegram's nav row, a pinned-message bar and a
 * "Translate to English" strip. Cropping those away leaves a rectangle that has
 * to read as a screen, and this is the least frame that does — a radius, a 1px
 * `#1a1a1a` border and a diffused burgundy glow, which is the design system's
 * "borders over shadows, glow over drop-shadow" rule verbatim.
 *
 * Height comes from the clip's own `ratio`, so the panel can never disagree
 * with the footage inside it. The two ratios in play are the Mini App crop
 * (tall, phone-like) and the chat crop (shorter, a window onto a conversation).
 */
export const Screen: React.FC<{
  src: string;
  /** Panel width in composition px. This sets the upscale — sources are 576 wide. */
  width: number;
  ratio: number;
  trimBefore: number;
  x?: number;
  y?: number;
  scale?: number;
  rotate?: number;
  glow?: number;
}> = ({src, width, ratio, trimBefore, x = 0, y = 0, scale = 1, rotate = 0, glow = 1}) => {
  const height = width / ratio;
  const radius = width * 0.062;

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
            inset: -width * 0.32,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${WINE}${Math.round(glow * 62)
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
          src={asset(`footage/${src}.mp4`)}
          trimBefore={trimBefore}
          style={{width: "100%", height: "100%", objectFit: "cover"}}
        />
      </div>
    </div>
  );
};
