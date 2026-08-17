import React from "react";
import {AbsoluteFill, useCurrentFrame} from "remotion";
import {fade, push} from "../motion";
import {INK} from "../theme";
import {TIMELINE, TRIM} from "../timeline";
import {Phone} from "../ui/Phone";

/**
 * Scene 3 — the friction.
 *
 * The competitor carousel, rotating a new face roughly every second under a
 * caption that keeps changing.
 *
 * Framed large rather than cropped into. The first cut of this shot overscanned
 * the screen to 132% to get the intimacy of scrolling, and clipped the caption
 * off both edges — "It feels more like scrolling a TikTok feed" rendered as
 * "…crolling a TikTok fee". A caption that reads as a rendering fault is worse
 * than a slightly wider shot, and the phone at 880px still fills 87% of the
 * frame height, so the intimacy survives.
 *
 * It also halves the upscale on the 592px-wide capture (1.49× here against
 * 1.82× when the screen filled the frame) — this is the only shot in the film
 * where a low-res source is enlarged this far.
 */
export const Friction: React.FC = () => {
  const frame = useCurrentFrame();
  const {duration} = TIMELINE.friction;

  const opacity = fade(frame, duration, 0, 0);
  const scale = push(frame, duration, 1, 1.05);

  return (
    <AbsoluteFill style={{backgroundColor: INK, opacity, overflow: "hidden"}}>
      <Phone
        src="footage/intro-cards.mp4"
        trimBefore={TRIM.friction}
        width={880}
        scale={scale}
        glow={0.5}
      />
    </AbsoluteFill>
  );
};
