import React from "react";
import {AbsoluteFill, interpolate, OffthreadVideo, useCurrentFrame} from "remotion";
import {fade, push} from "../motion";
import {asset, INK} from "../theme";
import {TIMELINE, TRIM} from "../timeline";

/**
 * Scene 1 — alone.
 *
 * Rain, night, one person walking. Full-bleed and nearly still: the reference
 * opens on a 6-second hold, and this is the only shot in the film with no UI in
 * it at all, so it has to earn its length by being calm rather than busy.
 *
 * Graded down hard. The problem should feel cold; everything after the brand
 * turn gets progressively warmer, and this is the bottom of that curve.
 */
export const Alone: React.FC = () => {
  const frame = useCurrentFrame();
  const {duration} = TIMELINE.alone;

  const opacity = fade(frame, duration, 18, 22);
  const scale = push(frame, duration, 1.04, 1.1);

  // Bleed to black across the last third, so scene 2's phone rises out of it.
  const sink = interpolate(frame, [duration * 0.62, duration], [0, 0.55], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{backgroundColor: INK, opacity}}>
      <AbsoluteFill style={{transform: `scale(${scale})`}}>
        <OffthreadVideo
          src={asset("footage/life-rain.mp4")}
          trimBefore={TRIM.alone}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            filter: "saturate(0.72) brightness(0.62) contrast(1.08)",
          }}
        />
      </AbsoluteFill>
      <AbsoluteFill style={{backgroundColor: INK, opacity: sink}} />
    </AbsoluteFill>
  );
};
