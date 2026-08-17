import React from "react";
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from "remotion";
import {enter, fade, push} from "../motion";
import {INK} from "../theme";
import type {Shot} from "../timeline";
import {Screen} from "../ui/Screen";

/**
 * One shot of real product footage.
 *
 * There is a single scene component rather than one file per beat because
 * every beat in this film IS the same thing — a captured screen, framed. What
 * differs between them is composition (offset, rotation, size), camera and
 * timing, and all of that is data in `timeline.ts`. Twelve near-identical files
 * would hide the cut rather than express it: the edit is legible when the whole
 * timeline can be read on one page.
 *
 * The camera is a transform on the wrapper. No product pixel is ever repainted.
 */
export const ProductShot: React.FC<{shot: Shot}> = ({shot}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const {durationInFrames: duration} = shot;
  const [pushFrom, pushTo] = shot.push ?? [1, 1.04];

  const opacity = fade(frame, duration, shot.fadeIn ?? 0, shot.fadeOut ?? 0);

  // The first shot and each shot after a dissolve arrive on a spring; a
  // hard-cut shot is simply already there, because a screen that springs in on
  // every cut turns an edit into a slideshow.
  const arrives = (shot.fadeIn ?? 0) > 0;
  const rise = arrives ? enter(frame, fps) : 1;

  const scale = push(frame, duration, pushFrom, pushTo) * (arrives ? 0.972 + rise * 0.028 : 1);
  const y = (shot.y ?? 0) + (1 - rise) * 54;

  return (
    <AbsoluteFill style={{backgroundColor: INK, opacity}}>
      <Screen
        src={shot.src}
        width={shot.width}
        ratio={shot.ratio}
        trimBefore={shot.trim}
        x={shot.x ?? 0}
        y={y}
        scale={scale}
        rotate={shot.rotate ?? 0}
        glow={shot.glow ?? 0.8}
      />
    </AbsoluteFill>
  );
};
