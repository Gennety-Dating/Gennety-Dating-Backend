import "./index.css";
import {Composition} from "remotion";
import {
  GENNETY_AD_DURATION_IN_FRAMES,
  GennetyAd,
  gennetyAdSchema,
  type GennetyAdProps,
} from "./compositions/GennetyAd";
import {
  GennetyHero,
  gennetyHeroSchema,
  HERO_DURATION_IN_FRAMES,
  type GennetyHeroProps,
} from "./hero/GennetyHero";

const FPS = 30;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/*
        The product film. Built from real captures of the running product —
        see apps/video/video-production-plan.md. Deliberately vertical-only:
        it is cut for a phone-held feed, and a horizontal variant would need a
        different edit rather than a crop of this one.
      */}
      <Composition<typeof gennetyHeroSchema, GennetyHeroProps>
        id="GennetyHero"
        component={GennetyHero}
        schema={gennetyHeroSchema}
        durationInFrames={HERO_DURATION_IN_FRAMES}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{musicVolume: 0, finishing: true}}
      />

      <Composition<typeof gennetyAdSchema, GennetyAdProps>
        id="GennetyAdVertical"
        component={GennetyAd}
        schema={gennetyAdSchema}
        durationInFrames={GENNETY_AD_DURATION_IN_FRAMES.uk}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{format: "vertical", language: "uk", couplePhoto: "couple/final-couple.jpg"}}
      />
      <Composition<typeof gennetyAdSchema, GennetyAdProps>
        id="GennetyAdHorizontal"
        component={GennetyAd}
        schema={gennetyAdSchema}
        durationInFrames={GENNETY_AD_DURATION_IN_FRAMES.uk}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{format: "horizontal", language: "uk", couplePhoto: "couple/final-couple.jpg"}}
      />
      <Composition<typeof gennetyAdSchema, GennetyAdProps>
        id="GennetyAdVerticalEnglish"
        component={GennetyAd}
        schema={gennetyAdSchema}
        durationInFrames={GENNETY_AD_DURATION_IN_FRAMES.en}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{format: "vertical", language: "en", couplePhoto: "couple/final-couple.jpg"}}
      />
      <Composition<typeof gennetyAdSchema, GennetyAdProps>
        id="GennetyAdHorizontalEnglish"
        component={GennetyAd}
        schema={gennetyAdSchema}
        durationInFrames={GENNETY_AD_DURATION_IN_FRAMES.en}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{format: "horizontal", language: "en", couplePhoto: "couple/final-couple.jpg"}}
      />
    </>
  );
};
