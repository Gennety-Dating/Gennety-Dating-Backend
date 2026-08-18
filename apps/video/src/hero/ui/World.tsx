import React from "react";
import {AbsoluteFill, useCurrentFrame} from "remotion";
import {cameraAt} from "../camera";

/**
 * The world, seen through the camera.
 *
 * One instance, wrapping the entire film. Its children live in a stable
 * coordinate space whose origin is the centre of the frame; the transform here
 * is the ONLY thing that decides what part of that space the viewer is looking
 * at, and it is read from `cameraAt(frame)` on absolute composition frames.
 *
 * The transform is a **pure scale** — a dolly straight down the lens axis, with
 * no pan and no roll. That is the founder's rule of 2026-08-18 ("the phone is
 * static; only the camera approaches or retreats"), and it is expressed here as
 * the absence of a translate rather than as `translate(0, 0)`: there is nothing
 * to accidentally set.
 *
 * There is no `overflow: hidden` and no per-child transform anywhere below
 * this: a child that positions itself is a child that can disagree with the
 * camera, and fifteen children disagreeing with the camera is precisely what
 * this replaced.
 */
export const World: React.FC<{children: React.ReactNode; opacity?: number}> = ({
  children,
  opacity = 1,
}) => {
  const frame = useCurrentFrame();
  const camera = cameraAt(frame);

  return (
    <AbsoluteFill
      style={{
        opacity,
        transformOrigin: "50% 50%",
        transform: `scale(${camera.scale.toFixed(5)})${
          camera.rotate === 0 ? "" : ` rotate(${camera.rotate}deg)`
        }`,
        // The camera is animating a transform every frame; keeping the layer
        // promoted stops the browser re-rasterising the drawn handset chrome.
        willChange: "transform",
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
