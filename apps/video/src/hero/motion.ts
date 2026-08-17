import {Easing, interpolate, spring} from "remotion";

/**
 * Envelopes — opacity, and the one entrance the film still has.
 *
 * This used to be "the film's whole motion system". It is not any more: the
 * camera moved out to `camera.ts`, where it is one global timeline rather than
 * something a scene calls with its own local frame.
 *
 * What left with it was `push()`. It was a correct function asked the wrong
 * question — its `frame` argument was always scene-local and its `from`
 * argument was always 1, so it re-seated the camera at exactly 1.0 on the first
 * frame of all fifteen shots. That is the reset (`../../motion-audit.md` §3),
 * and it is deleted rather than deprecated: any function here that takes a
 * duration and returns a scale is a way back to it.
 *
 * `ease`, `fade` and `enter` are identical to the helpers inside
 * `GennetyAd.tsx`, so the two films share a motion signature.
 */
export const ease = Easing.bezier(0.22, 1, 0.36, 1);

/**
 * Scene-level opacity envelope, with independent in and out edges.
 *
 * **Pass 0 for a hard cut.** The first version of this was symmetric and always
 * ramped from 0, which meant every scene opened on a black frame — and since
 * only three of the nine transitions in this film overlap, the other six were
 * dipping to black for ~a frame each. On a 30fps timeline that reads as a blink,
 * not as an edit. A hard cut is opacity 1 from frame 0; a dissolve is two
 * scenes whose `from` values overlap, each ramping across the shared frames.
 */
export const fade = (frame: number, duration: number, inEdge = 14, outEdge = inEdge) => {
  const fadeIn =
    inEdge > 0
      ? interpolate(frame, [0, inEdge], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: ease,
        })
      : 1;

  const fadeOut =
    outEdge > 0
      ? interpolate(frame, [duration - outEdge, duration], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: ease,
        })
      : 1;

  return fadeIn * fadeOut;
};

/**
 * Spring entrance for an element that genuinely arrives — a mark, a line.
 *
 * **Not the phone.** The handset used to spring in on any shot with a
 * `fadeIn`, which meant it physically re-entered the frame three times
 * mid-film. It is a permanent object now and arrives once, with the world.
 */
export const enter = (frame: number, fps: number, delay = 0) =>
  spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: {damping: 18, mass: 0.8, stiffness: 130},
    durationInFrames: 34,
  });
