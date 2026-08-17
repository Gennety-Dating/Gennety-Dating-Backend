import {Easing, interpolate, spring} from "remotion";

/**
 * The film's whole motion system. Deliberately four functions — the brief's
 * rule is a small, reused set rather than per-scene easing invented ad hoc.
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

/** Spring entrance for an element that arrives (a phone, a mark, a line). */
export const enter = (frame: number, fps: number, delay = 0) =>
  spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: {damping: 18, mass: 0.8, stiffness: 130},
    durationInFrames: 34,
  });

/**
 * The camera. One slow push per shot, never more — capped well under the
 * "constant zooming" the brief rules out. `to` is the scale reached at the end
 * of the shot; nothing in this film exceeds 1.08.
 */
export const push = (frame: number, duration: number, from = 1, to = 1.06) =>
  interpolate(frame, [0, duration], [from, to], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.linear,
  });
