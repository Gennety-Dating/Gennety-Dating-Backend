import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {enter, fade} from "../motion";
import {asset, INK, MUTED} from "../theme";
import {TIMELINE} from "../timeline";
import {Butterfly} from "../ui/Butterfly";

/**
 * Scene 10 — the mark.
 *
 * Butterfly, wordmark, one line. This and the logo beat inside scene 4 are the
 * only typography in the film that is not the product's own — the brief's rule
 * is that the interface carries the story, and it does: "no swiping" and "one
 * real date" are both already said on screen, in the app's words, better than a
 * caption would.
 *
 * So the only line here is the one the product cannot say about itself.
 */
export const Mark: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {duration} = TIMELINE.mark;

  const opacity = fade(frame, duration, 14, 20);
  const mark = enter(frame, fps, 2);
  const word = enter(frame, fps, 14);
  const line = enter(frame, fps, 26);

  // The glow settles rather than pulsing — a looping breath on an end card
  // reads as a screensaver.
  const settle = interpolate(frame, [0, 34, duration], [0, 1, 0.72], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: INK,
        opacity,
        justifyContent: "center",
        alignItems: "center",
        gap: 52,
      }}
    >
      <div style={{transform: `scale(${0.86 + mark * 0.14})`, opacity: mark}}>
        <Butterfly size={216} glow={settle} idSuffix="mark" />
      </div>

      <Img
        src={asset("brand/logo-wordmark.png")}
        style={{
          width: 424,
          opacity: word,
          transform: `translateY(${(1 - word) * 14}px)`,
        }}
      />

      <div
        style={{
          fontFamily: "Roboto, Arial, sans-serif",
          fontSize: 34,
          fontWeight: 400,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: MUTED,
          opacity: line * 0.92,
          transform: `translateY(${(1 - line) * 10}px)`,
        }}
      >
        Your AI matchmaker
      </div>
    </AbsoluteFill>
  );
};
