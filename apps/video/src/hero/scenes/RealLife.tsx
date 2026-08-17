import React from "react";
import {AbsoluteFill, OffthreadVideo, Sequence, useCurrentFrame} from "remotion";
import {fade, push} from "../motion";
import {asset, INK} from "../theme";
import {LIFE_CUTS, TIMELINE} from "../timeline";

/**
 * Scene 9 — real life.
 *
 * The phone is gone and does not come back. Bench at sunset → golden field →
 * festival lights, each shot warmer and slightly shorter than the last.
 *
 * This is the film's thesis in one edit: the product's job is to stop being on
 * screen. It is also the only stretch graded UP rather than down — scene 1 sits
 * at 0.62 brightness, this sits above 1.0, and the two are meant to be read as
 * the same person at the two ends of the same week.
 */
export const RealLife: React.FC = () => {
  const frame = useCurrentFrame();
  const {duration} = TIMELINE.realLife;
  const opacity = fade(frame, duration, 12, 14);

  let offset = 0;

  return (
    <AbsoluteFill style={{backgroundColor: INK, opacity}}>
      {LIFE_CUTS.map((cut) => {
        const from = offset;
        offset += cut.duration;
        return (
          <Sequence key={cut.src} from={from} durationInFrames={cut.duration} layout="none">
            <LifeShot src={cut.src} trim={cut.trim} duration={cut.duration} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const LifeShot: React.FC<{src: string; trim: number; duration: number}> = ({
  src,
  trim,
  duration,
}) => {
  const frame = useCurrentFrame();
  const scale = push(frame, duration, 1.02, 1.07);

  return (
    <AbsoluteFill style={{overflow: "hidden"}}>
      <AbsoluteFill style={{transform: `scale(${scale})`}}>
        <OffthreadVideo
          src={asset(src)}
          trimBefore={trim}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            filter: "saturate(1.06) brightness(1.04) contrast(1.02)",
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
