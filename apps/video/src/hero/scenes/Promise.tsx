import React from "react";
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from "remotion";
import {enter, fade, push} from "../motion";
import {INK} from "../theme";
import {TIMELINE, TRIM} from "../timeline";
import {Phone} from "../ui/Phone";

/**
 * Scene 5 — the promise.
 *
 * "You get a personal AI matchmaker that works around the clock to find the
 * person who perfectly fits you", typing itself out. The phone sits offset to
 * the left with the right third of the frame empty — the first genuinely
 * asymmetric composition in the film, and the point in the story where it can
 * afford to breathe again after the burst of scene 3.
 */
export const Promise: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {duration} = TIMELINE.promise;

  const opacity = fade(frame, duration, 0, 0);
  const arrive = enter(frame, fps);
  const x = -108 + (1 - arrive) * -60;
  const scale = push(frame, duration, 1, 1.04);

  return (
    <AbsoluteFill style={{backgroundColor: INK, opacity}}>
      <Phone
        src="footage/intro-promise.mp4"
        trimBefore={TRIM.promise}
        width={604}
        x={x}
        scale={scale}
        rotate={-1.2}
        glow={0.9}
      />
    </AbsoluteFill>
  );
};
