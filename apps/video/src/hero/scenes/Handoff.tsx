import React from "react";
import {AbsoluteFill, OffthreadVideo, useCurrentFrame} from "remotion";
import {fade, push} from "../motion";
import {asset, INK} from "../theme";
import {TIMELINE, TRIM} from "../timeline";

/**
 * Scene 7 — the handoff.
 *
 * "Passing context to the bot", with the orb breathing. The camera does nothing
 * at all beyond an almost-imperceptible push, because the orb is already the
 * only moving thing on a black screen and anything else competes with it.
 *
 * No device frame and no glow of ours: the shot carries its own light source,
 * which is the whole reason it is the most beautiful frame in the capture.
 */
export const Handoff: React.FC = () => {
  const frame = useCurrentFrame();
  const {duration} = TIMELINE.handoff;

  const opacity = fade(frame, duration, 0, 0);
  const scale = push(frame, duration, 1.01, 1.05);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: INK,
        opacity,
        overflow: "hidden",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <OffthreadVideo
        src={asset("footage/intro-orb.mp4")}
        trimBefore={TRIM.handoff}
        style={{width: "126%", height: "126%", objectFit: "cover", transform: `scale(${scale})`}}
      />
    </AbsoluteFill>
  );
};
