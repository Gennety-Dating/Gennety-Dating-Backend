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
 * The transform order is load-bearing. CSS applies a transform list
 * right-to-left, so `translate(...) scale(s)` scales first and then shifts by a
 * distance measured in the parent's (unscaled) pixels — which is why the offset
 * is `-x * scale` rather than `-x`. Writing it the other way round makes the
 * camera's pan speed silently depend on its zoom.
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

  const dx = -camera.x * camera.scale;
  const dy = -camera.y * camera.scale;

  return (
    <AbsoluteFill
      style={{
        opacity,
        transformOrigin: "50% 50%",
        transform: `translate(${dx.toFixed(3)}px, ${dy.toFixed(3)}px) scale(${camera.scale.toFixed(
          5,
        )})${camera.rotate === 0 ? "" : ` rotate(${camera.rotate}deg)`}`,
        // The camera is animating a transform every frame; keeping the layer
        // promoted stops the browser re-rasterising the drawn handset chrome.
        willChange: "transform",
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
