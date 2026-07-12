import "./index.css";
import {Composition} from "remotion";
import {GennetyVideo} from "./compositions/GennetyVideo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="GennetyVideo"
      component={GennetyVideo}
      durationInFrames={150}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
