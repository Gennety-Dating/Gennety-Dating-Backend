import React from "react";
import {AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig} from "remotion";
import {enter, fade} from "../motion";
import {INK} from "../theme";
import {DATE_CUTS, TIMELINE} from "../timeline";
import {Phone} from "../ui/Phone";

/**
 * Scene 8 — the date.
 *
 * The outcome chain — "Skip straight to the date" → "You both said yes" →
 * "You pick when" → "Time and place are set" — cut as four hard cuts inside
 * 5.6s. This is the film's one burst, and it is placed here for the same reason
 * the reference puts its six-cut burst at 37.6s: right before the payoff, so
 * the acceleration hands off into the lifestyle rather than dying on a screen.
 *
 * The phone holds one position across all four cuts. Only the screen changes —
 * moving the camera as well would turn a burst into chaos.
 */
export const DatePlan: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {duration} = TIMELINE.datePlan;

  const opacity = fade(frame, duration, 0, 12);
  const arrive = enter(frame, fps);
  const x = 96 + (1 - arrive) * 60;

  let offset = 0;

  return (
    <AbsoluteFill style={{backgroundColor: INK, opacity}}>
      {DATE_CUTS.map((cut) => {
        const from = offset;
        offset += cut.duration;
        return (
          <Sequence
            key={cut.trim}
            from={from}
            durationInFrames={cut.duration}
            layout="none"
          >
            <AbsoluteFill>
              <Phone
                src="footage/intro-date.mp4"
                trimBefore={cut.trim}
                width={596}
                x={x}
                rotate={1.1}
                glow={0.85}
              />
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
