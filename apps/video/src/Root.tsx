import "./index.css";
import {Composition} from "remotion";
import {GennetyAd, gennetyAdSchema, type GennetyAdProps} from "./compositions/GennetyAd";

const FPS = 30;
const DURATION_IN_FRAMES = 22 * FPS;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition<typeof gennetyAdSchema, GennetyAdProps>
        id="GennetyAdVertical"
        component={GennetyAd}
        schema={gennetyAdSchema}
        durationInFrames={DURATION_IN_FRAMES}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{format: "vertical"}}
      />
      <Composition<typeof gennetyAdSchema, GennetyAdProps>
        id="GennetyAdHorizontal"
        component={GennetyAd}
        schema={gennetyAdSchema}
        durationInFrames={DURATION_IN_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{format: "horizontal"}}
      />
    </>
  );
};
