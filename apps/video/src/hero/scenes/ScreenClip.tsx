import React from "react";
import {OffthreadVideo, useCurrentFrame} from "remotion";
import {fade} from "../motion";
import {asset} from "../theme";
import type {Shot} from "../timeline";

/**
 * One shot, as SCREEN CONTENT and nothing else.
 *
 * This is what is left of the old `ProductShot` after the camera was made
 * global. That component mounted a whole handset per shot and gave it its own
 * `scale`, `y` and entrance spring — fifteen objects taking turns pretending to
 * be one. This one renders a video into an aperture the phone already owns, and
 * has no transform of its own at all. There is nothing here that can move the
 * phone, because there is nothing here that knows the phone exists.
 *
 * There is still a single scene component rather than one file per beat, for
 * the reason there always was: every beat IS the same thing — a captured screen
 * — and what differs is which clip, where in it and how long, which is data in
 * `timeline.ts`.
 *
 * `fadeIn`/`fadeOut` are screen-level only. Twelve of the fourteen boundaries
 * are hard cuts and stay that way: inside one continuous handset, a screen
 * simply changing is what a screen does, while a crossfade between two app
 * screens reads as a video effect rather than a product one. The three
 * dissolves that remain (at 694, 1130, 1260) keep the rule DECISIONS.md
 * records — only the INCOMING clip fades, because fading both at once dips the
 * picture to ~60% through the middle of the transition.
 */
export const ScreenClip: React.FC<{shot: Shot}> = ({shot}) => {
  const frame = useCurrentFrame();
  const opacity = fade(frame, shot.durationInFrames, shot.fadeIn ?? 0, shot.fadeOut ?? 0);

  return (
    <OffthreadVideo
      src={asset(`footage/${shot.src}.mp4`)}
      trimBefore={shot.trim}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
        opacity,
      }}
    />
  );
};
