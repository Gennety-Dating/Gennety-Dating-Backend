import React from "react";
import {AbsoluteFill, Audio, interpolate, Sequence} from "remotion";
import {z} from "zod";
import {Alone} from "./scenes/Alone";
import {Cost} from "./scenes/Cost";
import {DatePlan} from "./scenes/DatePlan";
import {Friction} from "./scenes/Friction";
import {Handoff} from "./scenes/Handoff";
import {Mark} from "./scenes/Mark";
import {Promise as PromiseScene} from "./scenes/Promise";
import {RealLife} from "./scenes/RealLife";
import {Turn} from "./scenes/Turn";
import {Understanding} from "./scenes/Understanding";
import {asset, INK} from "./theme";
import {HERO_DURATION_IN_FRAMES, TIMELINE} from "./timeline";
import {Grain, Vignette} from "./ui/Texture";

export const gennetyHeroSchema = z.object({
  /**
   * Master gain for the music bed. **Defaults to 0 — the film renders silent.**
   *
   * Not an oversight, and not laziness: there is no licensed track in this
   * workspace, and the only first-party audio available is the sound design
   * from `Gennety Ad video.mp4`, which was measured before being ruled out. It
   * is sparse rather than continuous — mean level between −35 and −50 dB across
   * most of its length, one loud sting at 50s, and a 30 LU loudness range. Cut
   * to this picture it is inaudible for roughly thirty of the forty-six seconds,
   * and normalising a −50 dB bed up to broadcast level is +34 dB of gain onto
   * whatever noise floor it has.
   *
   * So this follows the workspace's existing convention (apps/video/README.md):
   * sound direction is chosen after the visual cut is approved. The path is
   * wired and the bed is extracted — dropping in a licensed track is one file
   * swap at `public/audio/score.m4a` plus `musicVolume: 0.8`.
   */
  musicVolume: z.number().min(0).max(1),
  /** Grain and vignette. Off is useful when checking UI fidelity frame by frame. */
  finishing: z.boolean(),
});

export type GennetyHeroProps = z.infer<typeof gennetyHeroSchema>;

export {HERO_DURATION_IN_FRAMES};

/**
 * `GennetyHero` — the product film.
 *
 * Ten scenes, ~45.5s, assembled from real captures of the running product plus
 * lifestyle footage. Full reasoning, the recording map and the quality audit
 * are in `apps/video/video-production-plan.md`; this file is only the assembly.
 *
 * Two rules hold the whole thing together and should survive any edit:
 *
 *  1. **No product UI is redrawn.** Every screen on camera is footage. The
 *     camera is a CSS transform on a wrapper, so no product pixel is ever
 *     repainted by us.
 *  2. **Scene boundaries live in `timeline.ts`**, not here. Overlapping `from`
 *     values are what make a dissolve; everything else is a hard cut.
 */
export const GennetyHero: React.FC<GennetyHeroProps> = ({musicVolume, finishing}) => {
  return (
    <AbsoluteFill style={{backgroundColor: INK}}>
      {musicVolume > 0 ? (
        <Audio
          src={asset("audio/score.m4a")}
          volume={(f) =>
            // Up over the first second, and away under the end card so the mark
            // lands in near-silence rather than being cut off mid-phrase.
            musicVolume *
            interpolate(
              f,
              [0, 30, TIMELINE.mark.from, HERO_DURATION_IN_FRAMES - 6],
              [0, 1, 1, 0],
              {extrapolateLeft: "clamp", extrapolateRight: "clamp"},
            )
          }
        />
      ) : null}

      <Sequence
        from={TIMELINE.alone.from}
        durationInFrames={TIMELINE.alone.duration}
        premountFor={30}
      >
        <Alone />
      </Sequence>
      <Sequence
        from={TIMELINE.cost.from}
        durationInFrames={TIMELINE.cost.duration}
        premountFor={30}
      >
        <Cost />
      </Sequence>
      <Sequence
        from={TIMELINE.friction.from}
        durationInFrames={TIMELINE.friction.duration}
        premountFor={30}
      >
        <Friction />
      </Sequence>
      <Sequence
        from={TIMELINE.turn.from}
        durationInFrames={TIMELINE.turn.duration}
        premountFor={30}
      >
        <Turn />
      </Sequence>
      <Sequence
        from={TIMELINE.promise.from}
        durationInFrames={TIMELINE.promise.duration}
        premountFor={30}
      >
        <PromiseScene />
      </Sequence>
      <Sequence
        from={TIMELINE.understanding.from}
        durationInFrames={TIMELINE.understanding.duration}
        premountFor={30}
      >
        <Understanding />
      </Sequence>
      <Sequence
        from={TIMELINE.handoff.from}
        durationInFrames={TIMELINE.handoff.duration}
        premountFor={30}
      >
        <Handoff />
      </Sequence>
      <Sequence
        from={TIMELINE.datePlan.from}
        durationInFrames={TIMELINE.datePlan.duration}
        premountFor={30}
      >
        <DatePlan />
      </Sequence>
      <Sequence
        from={TIMELINE.realLife.from}
        durationInFrames={TIMELINE.realLife.duration}
        premountFor={30}
      >
        <RealLife />
      </Sequence>
      <Sequence
        from={TIMELINE.mark.from}
        durationInFrames={TIMELINE.mark.duration}
        premountFor={30}
      >
        <Mark />
      </Sequence>

      {finishing ? (
        <>
          <Vignette />
          <Grain />
        </>
      ) : null}
    </AbsoluteFill>
  );
};
