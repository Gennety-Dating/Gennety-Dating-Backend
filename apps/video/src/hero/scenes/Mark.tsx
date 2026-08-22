import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {titleTransform} from "../camera";
import {crossfade, enter, fade} from "../motion";
import {asset, INK, MUTED} from "../theme";
import {MARK} from "../titles";
import {Butterfly} from "../ui/Butterfly";

/**
 * Scene 10 — the mark.
 *
 * Butterfly, wordmark, one line.
 *
 * It used to be the only typography in the film that was not the product's own,
 * on the rule that the interface carries the story. The slogan act added four
 * more cards (`titles.ts`) — and on the same rule, not against it: the slogan is
 * an argument against the product's own category, which is precisely the thing
 * no screen in the app can say. This line is the other one.
 *
 * **The camera does not stop for the end card**, and that rule now covers the
 * four title cards before it too: the mark is simply the last of them, and they
 * all creep 3.2% across their own life (`camera.ts` → `titleTransform`). Parking
 * dead centre would put the one hard stop of the whole film on its final
 * seconds. The film ends with something still moving.
 */
export const Mark: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const duration = MARK.durationInFrames;

  // The act's own creep, relative to this card's start — see `camera.ts`. This
  // used to read the WORLD camera relative to `MARK.from`, which was right while
  // the mark crossfaded straight out of the last shot. It no longer does: four
  // title cards sit between them now, so there is no world motion to inherit.
  const camera = titleTransform(frame, duration);

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
