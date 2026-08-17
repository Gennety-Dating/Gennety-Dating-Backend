import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {relativeCameraTransform} from "../camera";
import {crossfade, enter, fade} from "../motion";
import {asset, INK, MUTED} from "../theme";
import {MARK} from "../timeline";
import {Butterfly} from "../ui/Butterfly";

/**
 * Scene 10 — the mark.
 *
 * Butterfly, wordmark, one line. This and the logo beat inside scene 4 are the
 * only typography in the film that is not the product's own — the brief's rule
 * is that the interface carries the story, and it does: "no swiping" and "one
 * real date" are both already said on screen, in the app's words, better than a
 * caption would.
 *
 * So the only line here is the one the product cannot say about itself.
 *
 * **The camera does not stop for the end card.** The mark is not part of the
 * world — it is not the phone, so it cannot sit inside `<World>` — but parking
 * it dead centre while the world it replaced was still travelling would put the
 * one hard stop of the whole film on its last three seconds. It therefore
 * inherits the camera's motion RELATIVE to `MARK.from`: the same ~5% push and
 * the same upward tilt the world is under across those frames, and nothing
 * else. The film ends with the camera still moving.
 */
export const Mark: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const duration = MARK.durationInFrames;

  // Sequence-local frame in, absolute frame out: the camera only ever speaks
  // composition time.
  const camera = relativeCameraTransform(MARK.from + frame, MARK.from);

  // In: linear — it crossfades over the still-lit world (see GennetyHero).
  // Out: eased — that edge really is a fade to black, and ends the film.
  const opacity = crossfade(frame, 14) * fade(frame, duration, 0, 22);
  const mark = enter(frame, fps, 2);
  const word = enter(frame, fps, 14);
  const line = enter(frame, fps, 26);

  // The glow settles rather than pulsing — a looping breath on an end card
  // reads as a screensaver.
  const settle = interpolate(frame, [0, 34, duration], [0, 1, 0.72], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: INK,
        opacity,
        justifyContent: "center",
        alignItems: "center",
        gap: 52,
        transformOrigin: "50% 50%",
        transform: camera,
      }}
    >
      <div style={{transform: `scale(${0.86 + mark * 0.14})`, opacity: mark}}>
        <Butterfly size={216} glow={settle} idSuffix="mark" />
      </div>

      <Img
        src={asset("brand/logo-wordmark.png")}
        style={{
          width: 424,
          opacity: word,
          transform: `translateY(${(1 - word) * 14}px)`,
        }}
      />

      <div
        style={{
          fontFamily: "Roboto, Arial, sans-serif",
          fontSize: 34,
          fontWeight: 400,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: MUTED,
          opacity: line * 0.92,
          transform: `translateY(${(1 - line) * 10}px)`,
        }}
      >
        Твій AI-метчмейкер
      </div>
    </AbsoluteFill>
  );
};
