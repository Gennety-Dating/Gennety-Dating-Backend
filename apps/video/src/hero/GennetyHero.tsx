import React from "react";
import {AbsoluteFill, Audio, interpolate, Sequence, useCurrentFrame} from "remotion";
import {z} from "zod";
import {glowAt} from "./camera";
import {ease} from "./motion";
import {Mark} from "./scenes/Mark";
import {ScreenClip} from "./scenes/ScreenClip";
import {asset, INK} from "./theme";
import {HERO_DURATION_IN_FRAMES, MARK, SCREEN_WIDTH, SHOTS} from "./timeline";
import {Iphone} from "./ui/Iphone";
import {Grain, Vignette} from "./ui/Texture";
import {World} from "./ui/World";

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

/** The film opens from black. 18 frames, on the world rather than on a shot. */
const OPEN = 18;
/** The world hands over to the end card across the last dissolve. */
const OUTRO = 14;

/**
 * How many frames shot `i` keeps playing UNDER its successor.
 *
 * A `fadeIn` is only honest if there is something behind it. Where two shots
 * already overlap (the two dissolves) there is; where they butt up against
 * each other there is not, and fading in over black would replace a bright
 * flash with a dark one. So the outgoing shot is extended by exactly the
 * incoming shot's fade, and no further.
 *
 * Derived rather than declared: the extension IS the next shot's `fadeIn`, so
 * the two cannot drift apart, and `timeline.ts` keeps one knob instead of two.
 * The footage has the slack, and it is checked after every re-extraction — the
 * tightest case is `cal-dates` at 66 of its 68 frames.
 */
const tail = (i: number): number => {
  const shot = SHOTS[i];
  const next = SHOTS[i + 1];
  if (!next) return 0;
  const gap = next.from - (shot.from + shot.durationInFrames);
  return Math.max(0, (next.fadeIn ?? 0) - Math.max(0, -gap));
};

/**
 * `GennetyHero` — the product film.
 *
 * ~46.8s cut entirely from six screen recordings of the running product
 * (IMG_2588 / IMG_2590 / IMG_2604, IMG_2730 / IMG_2731 for the venue act, and
 * IMG_2771 / IMG_2772 for the question and the calendar). Seventeen shots: the
 * profile the user fills in, the question the bot asks and the answer landing,
 * the Type Radar reading their taste, the match decision, the calendar landing
 * on a shared 17:00, the venue — searched, pinned, described in the user's own
 * words and read back as structure — and the date card that closes with the
 * product's own line, *Error 404: Chat not found. Try real life.*
 *
 * Reasoning, recording map and quality audit: `video-production-plan.md`.
 * Camera architecture and why it was rebuilt: `motion-audit.md`.
 *
 * Three rules hold it together:
 *
 *  1. **No product UI is redrawn.** Every screen on camera is footage.
 *  2. **The cut lives in `timeline.ts`**, the camera in `camera.ts`. This file
 *     is assembly and owns neither.
 *  3. **One phone, one world, one camera.** The tree below is deliberately
 *     shallow: `World` carries the single camera transform, `Iphone` is the
 *     single physical object inside it, and the `<Sequence>`s reach no further
 *     than the pixels on its screen. A sequence cannot move the phone, because
 *     nothing inside a sequence can see it.
 *
 * The `<Sequence>`s survive the refactor and are still worth having — they give
 * each clip its own local frame for `trim`/`fade`, keep every other video
 * unmounted, and premount the next one so a cut never lands on a cold decoder.
 * What they no longer do is own any geometry.
 */
export const GennetyHero: React.FC<GennetyHeroProps> = ({musicVolume, finishing}) => {
  const frame = useCurrentFrame();

  // The world opens from black and hands over to the mark. Both are envelopes on
  // the WORLD, never on a shot: the first shot used to carry a 20-frame fade-in
  // of its own, which after the refactor would have been a black phone screen
  // fading up inside an already-lit handset — a fault, not an opening.
  const worldOpacity =
    interpolate(frame, [0, OPEN], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: ease,
    }) *
    // Linear, for the same reason ScreenClip's crossfades are: this is a
    // handover between two lit pictures, not an arrival out of black. Eased, it
    // moved 30% of the way in a single frame and read as a blink.
    interpolate(frame, [MARK.from, MARK.from + OUTRO], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

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

      <World opacity={worldOpacity}>
        <Iphone screenWidth={SCREEN_WIDTH} glow={glowAt(frame)}>
          {SHOTS.map((shot, i) => (
            <Sequence
              key={`${shot.src}-${shot.from}`}
              from={shot.from}
              durationInFrames={shot.durationInFrames + tail(i)}
              premountFor={30}
              name={shot.src}
            >
              <ScreenClip shot={shot} />
            </Sequence>
          ))}
        </Iphone>
      </World>

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
