import React from "react";
import {AbsoluteFill, OffthreadVideo, useCurrentFrame} from "remotion";
import {fade, push} from "../motion";
import {asset, INK} from "../theme";
import {TIMELINE, TRIM} from "../timeline";

/**
 * Scene 6 — understanding.
 *
 * The one shot in the film taken from the 1080-wide capture, and the only one
 * that shows the bot actually talking: the user says "I prefer simple, happy
 * dialogs" and the bot answers "Are you an early bird or a night owl?"
 *
 * A full-width band, not a device — the crop is exactly the exchange, with the
 * chat's own starfield underneath it, and nothing else on screen. It is
 * deliberately the shortest beat in the film (2.5s): the question has to be
 * readable and then gone, because reading it twice is what would turn the film
 * into a feature tour.
 *
 * Sourced from the 30.4–34.0s window rather than the earlier one the plan
 * proposed. That earlier exchange spends almost its whole length typing and
 * settles for only ~0.4s before the soft keyboard opens and drags Telegram's
 * Russian input bar into shot; this one is settled and holds for three full
 * seconds, and carries no typo.
 */
export const Understanding: React.FC = () => {
  const frame = useCurrentFrame();
  const {duration} = TIMELINE.understanding;

  const opacity = fade(frame, duration, 0, 0);
  const scale = push(frame, duration, 1.02, 1.06);

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
        src={asset("footage/chat-question.mp4")}
        trimBefore={TRIM.understanding}
        style={{
          width: "100%",
          transform: `scale(${scale})`,
        }}
      />
    </AbsoluteFill>
  );
};
