import {AbsoluteFill, interpolate, useCurrentFrame} from "remotion";

export const GennetyVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 24, 126, 149], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill className="placeholder" style={{opacity}}>
      <p className="eyebrow">Gennety Dating</p>
      <h1>Video workspace ready</h1>
      <p className="subtitle">Creative direction comes next.</p>
    </AbsoluteFill>
  );
};
