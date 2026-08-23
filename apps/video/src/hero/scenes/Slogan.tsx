import React from "react";
import {AbsoluteFill, interpolate, useCurrentFrame} from "remotion";
import {titleTransform} from "../camera";
import {crossfade, ease} from "../motion";
import {INK, SOFT, WINE_LIGHT} from "../theme";
import type {Lang} from "../timeline";
import {
  CARD_OUT,
  LINE_HEIGHT,
  LINE_STAGGER,
  RISE,
  sloganTop,
  TYPE_MARGIN,
  TYPE_SIZE,
  TYPE_TRACKING,
  type SloganCard,
} from "../titles";

/**
 * A slogan card — the film's own voice, in Unbounded 700.
 *
 * **Every line rises out of a mask; nothing fades in.** That is the whole visual
 * idea and it is a deliberate departure from the rest of the film, which is
 * built out of crossfades. A crossfade is how you hide a cut between two
 * pictures; a mask-rise is how type arrives when it is the subject rather than a
 * caption over something else. It also reads as one motion — the line is already
 * whole, it is the frame that uncovers it — where a fade reads as the line being
 * assembled out of nothing.
 *
 * The mask is the `overflow: hidden` wrapper around each line and nothing more.
 * It has to be per LINE rather than per part: one mask around a stack would slide
 * the whole block up past its own top edge, which is a very different (and much
 * cheaper-looking) effect.
 *
 * **The font is Unbounded 700, and it renders whole only because of
 * `unicode-range`.** `src/index.css` declares the family twice — a Cyrillic
 * subset and a Latin one — so the browser picks the face per character. That
 * matters here more than anywhere else in the film: «Щоб бути щасливим,» is
 * Cyrillic letters plus an ASCII comma, and the Cyrillic file has no comma in it
 * at all. Without the ranges the comma would silently come from the fallback
 * stack, at a different weight and width, in the middle of the film's punchline.
 * `Вже в Telegram` mixes the two inside one word-space for the same reason.
 * Verified against both files' own cmaps: every character the act uses is served.
 */
export const Slogan: React.FC<{card: SloganCard; language: Lang}> = ({card, language}) => {
  const frame = useCurrentFrame();
  const {durationInFrames: duration} = card;

  // In: linear, over whatever is still lit underneath — the world, for the
  // first card, and nothing at all for the two that follow a black gap. Same
  // reasoning as every other handover in the film (`GennetyHero`): eased, it
  // moves most of the way in the first two frames and reads as a blink.
  const inn = crossfade(frame, card.fadeIn ?? 0);

  // The card leaves as a whole: opacity plus a short lift, so it reads as the
  // statement being taken away rather than as the lights going down on it.
  const out = interpolate(frame, [duration - CARD_OUT, duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: INK,
        justifyContent: card.anchorTop ? "flex-start" : "center",
        alignItems: "center",
        paddingLeft: TYPE_MARGIN,
        paddingRight: TYPE_MARGIN,
        paddingTop: card.anchorTop ? sloganTop(language) : 0,
        opacity: inn * (1 - out),
        transformOrigin: "50% 50%",
        transform: `${titleTransform(frame, duration)} translateY(${-out * 26}px)`,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          lineHeight: LINE_HEIGHT,
        }}
      >
        {card.parts.map((part, p) =>
          part.lines.map((line, i) => {
            const start = part.at + i * LINE_STAGGER;
            const rise = interpolate(frame, [start, start + RISE], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: ease,
            });

            return (
              <div
                key={`${p}-${i}`}
                style={{
                  overflow: "hidden",
                  // The mask has to be at least the line box, or a descender
                  // (щ, у, д — and this copy is full of them) is clipped at rest.
                  paddingBottom: TYPE_SIZE * 0.1,
                  marginBottom: -TYPE_SIZE * 0.1,
                }}
              >
                <div
                  style={{
                    fontFamily: "Unbounded, Roboto, Arial, sans-serif",
                    fontWeight: 700,
                    fontSize: TYPE_SIZE,
                    letterSpacing: TYPE_TRACKING,
                    color: part.accent ? WINE_LIGHT : SOFT,
                    whiteSpace: "nowrap",
                    transform: `translateY(${(1 - rise) * 118}%)`,
                    // A whisper of opacity on top of the mask. Without it the
                    // line's top edge cuts hard against the black at the moment
                    // it crosses the mask, which reads as an artefact.
                    opacity: 0.25 + rise * 0.75,
                  }}
                >
                  {line}
                </div>
              </div>
            );
          }),
        )}
      </div>
    </AbsoluteFill>
  );
};
