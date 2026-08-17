import React from "react";
import {
  AbsoluteFill,
  interpolate,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {enter, fade} from "../motion";
import {asset, INK} from "../theme";
import {TIMELINE, TRIM} from "../timeline";
import {Butterfly} from "../ui/Butterfly";

/** The one hybrid shot: the real screen, then a brand beat the product never renders. */
const VIDEO_FRAMES = 74;

/**
 * Scene 4 — the turn.
 *
 * "So we built Gennety" types itself out on the real screen, then the film cuts
 * to black and the mark arrives. This is the only place a new animation is
 * used over a product state, and the split is deliberate: the sentence is the
 * product's, the mark is the brand's, and putting them in one shot would blur
 * which is which.
 *
 * The cut to black is hard on both sides — no dissolve — because this is the
 * pivot the whole film turns on and it should land like a full stop.
 */
export const Turn: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {duration} = TIMELINE.turn;

  const opacity = fade(frame, duration, 0, 0);

  return (
    <AbsoluteFill style={{backgroundColor: INK, opacity}}>
      <Sequence durationInFrames={VIDEO_FRAMES} layout="none">
        <TurnScreen />
      </Sequence>
      <Sequence from={VIDEO_FRAMES} layout="none">
        <TurnMark fps={fps} />
      </Sequence>
    </AbsoluteFill>
  );
};

const TurnScreen: React.FC = () => {
  const frame = useCurrentFrame();
  // Sinks to black over the last 10 frames so the mark arrives out of nothing.
  const out = interpolate(frame, [VIDEO_FRAMES - 10, VIDEO_FRAMES], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{backgroundColor: INK, opacity: out, overflow: "hidden"}}>
      <AbsoluteFill style={{justifyContent: "center", alignItems: "center"}}>
        <OffthreadVideo
          src={asset("footage/intro-turn.mp4")}
          trimBefore={TRIM.turn}
          style={{width: "124%", height: "124%", objectFit: "cover"}}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const TurnMark: React.FC<{fps: number}> = ({fps}) => {
  const frame = useCurrentFrame();
  const arrive = enter(frame, fps, 2);
  const scale = 0.82 + arrive * 0.18;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: INK,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div style={{transform: `scale(${scale})`, opacity: arrive}}>
        <Butterfly size={300} glow={arrive} idSuffix="turn" />
      </div>
    </AbsoluteFill>
  );
};
