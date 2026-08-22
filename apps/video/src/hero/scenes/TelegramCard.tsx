import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
} from "remotion";
import {titleTransform} from "../camera";
import {crossfade, ease} from "../motion";
import {asset, INK, SOFT} from "../theme";
import {RISE, TELEGRAM, TYPE_SIZE, TYPE_TRACKING} from "../titles";
import {Iphone} from "../ui/Iphone";

/**
 * «Вже в Telegram» — the wordmark, the line, and the product being opened.
 *
 * **This is the film's second `<Iphone>`, and the invariant it appears to break
 * is worth restating rather than waiving.** `ui/Iphone.tsx` says there is
 * exactly one handset in the film, and the reason is specific: the film used to
 * mount a fresh one per shot, each with its own `push()` starting at scale 1.0,
 * so fifteen copies disagreed about scale at every cut (`motion-audit.md` §3).
 * The rule that actually protects against that is *one handset in the **world**,
 * never re-instantiated per shot* — and this one is not in the world. It sits in
 * a title card, after the world has gone, under no camera, at a fixed size, and
 * it takes no `scale` or `y` because the component still refuses to accept them.
 * The guard is intact; only the sentence needed narrowing.
 *
 * It is a handset rather than a bare rounded rectangle for the reason that file
 * already gives: a screen recording in a bare rectangle reads as a screenshot,
 * and this shot's whole job is to say *this is a real thing you can open right
 * now*.
 *
 * The clip is 2.4× — sped in extraction, not here (`titles.ts` → TELEGRAM).
 */
export const TelegramCard: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = TELEGRAM.durationInFrames;

  // In: linear, over the promise card still lit underneath — same reasoning as
  // every other handover in the film (`GennetyHero`).
  const opacity = crossfade(frame, 14);

  const rise = (start: number) =>
    interpolate(frame, [start, start + RISE], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: ease,
    });

  const word = rise(8);
  const line = rise(16);
  const phone = rise(TELEGRAM.phoneAt);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: INK,
        opacity,
        justifyContent: "center",
        alignItems: "center",
        gap: 44,
        transformOrigin: "50% 50%",
        transform: titleTransform(frame, duration),
      }}
    >
      <Img
        src={asset("brand/logo-wordmark.png")}
        style={{
          width: 300,
          opacity: word,
          transform: `translateY(${(1 - word) * 16}px)`,
        }}
      />

      <div
        style={{
          fontFamily: "Unbounded, Roboto, Arial, sans-serif",
          fontWeight: 700,
          fontSize: TYPE_SIZE,
          letterSpacing: TYPE_TRACKING,
          color: SOFT,
          whiteSpace: "nowrap",
          opacity: line,
          transform: `translateY(${(1 - line) * 18}px)`,
        }}
      >
        {TELEGRAM.line}
      </div>

      {/*
        The handset needs a positioned box of its own size: `Iphone` centres
        itself with `translate(-50%, -50%)` against its nearest positioned
        ancestor, which in the world is the full frame. Here it has to sit in a
        column under two other things, so the box is what gives it a place to be
        centred IN.
      */}
      <div
        style={{
          position: "relative",
          width: bodyWidth(TELEGRAM.screenWidth),
          height: bodyHeight(TELEGRAM.screenWidth),
          opacity: phone,
          transform: `translateY(${(1 - phone) * 30}px)`,
        }}
      >
        <Iphone screenWidth={TELEGRAM.screenWidth} glow={0.55}>
          <Sequence from={TELEGRAM.phoneAt} name="tg-open">
            <OffthreadVideo
              src={asset(`footage/${TELEGRAM.src}.mp4`)}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }}
            />
          </Sequence>
        </Iphone>
      </div>
    </AbsoluteFill>
  );
};

// Same arithmetic as `ui/Iphone.tsx`'s own layout — bezel 0.017w, rail 0.008w.
// Duplicated rather than exported because the handset owns its proportions and
// this card only needs to reserve room for them.
const CHROME = 0.017 + 0.008;
const bodyWidth = (w: number) => w + w * CHROME * 2;
const bodyHeight = (w: number) => (1280 / 576) * w + w * CHROME * 2;
