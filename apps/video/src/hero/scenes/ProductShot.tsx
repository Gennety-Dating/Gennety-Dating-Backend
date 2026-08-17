import React from "react";
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from "remotion";
import {enter, fade, push} from "../motion";
import {INK} from "../theme";
import type {Shot} from "../timeline";
import {SCREEN_WIDTH} from "../timeline";
import {Iphone} from "../ui/Iphone";

/**
 * One shot of real product footage, played inside the handset.
 *
 * There is a single scene component rather than one file per beat because every
 * beat IS the same thing — a captured screen in a phone. What differs is which
 * clip, where in it, how long, and how far the camera pushes, and all of that is
 * data in `timeline.ts`. Fifteen near-identical files would hide the cut; one
 * page that can be read top to bottom expresses it.
 *
 * The phone is centred and the same size in every shot. The camera is a
 * transform on the wrapper — no product pixel is ever repainted.
 */
export const ProductShot: React.FC<{shot: Shot}> = ({shot}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const {durationInFrames: duration} = shot;
  const [pushFrom, pushTo] = shot.push ?? [1, 1.04];

  const opacity = fade(frame, duration, shot.fadeIn ?? 0, shot.fadeOut ?? 0);

  // The first shot and each shot after a dissolve arrive on a spring; a
  // hard-cut shot is simply already there, because a handset that springs in on
  // every cut turns an edit into a slideshow.
  const arrives = (shot.fadeIn ?? 0) > 0;
  const rise = arrives ? enter(frame, fps) : 1;

  const scale = push(frame, duration, pushFrom, pushTo) * (arrives ? 0.978 + rise * 0.022 : 1);
  const y = (shot.y ?? 0) + (1 - rise) * 40;

  return (
    <AbsoluteFill style={{backgroundColor: INK, opacity}}>
      <Iphone
        src={shot.src}
        trimBefore={shot.trim}
        screenWidth={SCREEN_WIDTH}
        scale={scale}
        y={y}
        glow={shot.glow ?? 0.8}
      />
    </AbsoluteFill>
  );
};
