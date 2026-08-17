import React from "react";
import {AbsoluteFill, Audio, interpolate, Sequence} from "remotion";
import {z} from "zod";
import {Mark} from "./scenes/Mark";
import {ProductShot} from "./scenes/ProductShot";
import {asset, INK} from "./theme";
import {HERO_DURATION_IN_FRAMES, MARK, SHOTS} from "./timeline";
import {Grain, Vignette} from "./ui/Texture";

export const gennetyHeroSchema = z.object({
  /**
   * Master gain for a music bed. **Defaults to 0 — the film renders silent.**
   *
   * No licensed track exists in this workspace, and the recordings carry only
   * incidental phone audio. This follows the workspace's stated convention
   * (apps/video/README.md): sound direction is chosen after the visual cut is
   * approved. The path is wired — drop a track at `public/audio/score.m4a` and
   * set this to ~0.8.
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
 * ~41.6s cut entirely from three screen recordings of the running product
 * (IMG_2588 / IMG_2590 / IMG_2604). Thirteen shots: the profile the user fills
 * in, the question the bot asks, the Type Radar reading their taste, the match
 * decision, the calendar landing on a shared 13:00, the venue, and the date
 * card that closes with the product's own line — *Error 404: Chat not found.
 * Try real life.*
 *
 * Reasoning, recording map and quality audit: `video-production-plan.md`.
 *
 * Two rules hold it together:
 *
 *  1. **No product UI is redrawn.** Every screen on camera is footage; the
 *     camera is a CSS transform on a wrapper.
 *  2. **The cut lives in `timeline.ts`**, not here. This file is assembly.
 */
export const GennetyHero: React.FC<GennetyHeroProps> = ({musicVolume, finishing}) => {
  return (
    <AbsoluteFill style={{backgroundColor: INK}}>
      {musicVolume > 0 ? (
        <Audio
          src={asset("audio/score.m4a")}
          volume={(f) =>
            musicVolume *
            interpolate(f, [0, 30, MARK.from, HERO_DURATION_IN_FRAMES - 6], [0, 1, 1, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
          }
        />
      ) : null}

      {SHOTS.map((shot) => (
        <Sequence
          key={`${shot.src}-${shot.from}`}
          from={shot.from}
          durationInFrames={shot.durationInFrames}
          premountFor={30}
          name={shot.src}
        >
          <ProductShot shot={shot} />
        </Sequence>
      ))}

      <Sequence
        from={MARK.from}
        durationInFrames={MARK.durationInFrames}
        premountFor={30}
        name="mark"
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
