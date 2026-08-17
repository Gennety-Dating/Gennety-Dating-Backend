import React from "react";
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from "remotion";
import {enter, fade, push} from "../motion";
import {INK} from "../theme";
import {TIMELINE, TRIM} from "../timeline";
import {Phone} from "../ui/Phone";

/**
 * Scene 2 — what it costs.
 *
 * 75 hours → 9,500 swipes → $200, each number counting up. This is the film's
 * longest hold and the camera does almost nothing, because the product is
 * already animating: the reference's two opening holds (6.2s and 10.9s) are
 * long for exactly this reason — the screen performs, the camera watches.
 *
 * The phone rises once on a spring and then stays put.
 */
export const Cost: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {duration} = TIMELINE.cost;

  const opacity = fade(frame, duration, 14, 0);
  const rise = enter(frame, fps);
  const y = (1 - rise) * 90;
  const scale = push(frame, duration, 1, 1.045) * (0.965 + rise * 0.035);

  return (
    <AbsoluteFill style={{backgroundColor: INK, opacity}}>
      <Phone
        src="footage/intro-stats.mp4"
        trimBefore={TRIM.cost}
        width={700}
        y={y}
        scale={scale}
        glow={0.85}
      />
    </AbsoluteFill>
  );
};
