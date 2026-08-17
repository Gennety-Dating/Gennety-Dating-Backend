import React from "react";

/**
 * The brand mark, inlined verbatim from `public/brand/butterfly-logo.svg` —
 * the same path and the same radial gradient the bot stamps on its date and
 * match cards. It is inlined rather than `<Img>`-ed only so the glow behind it
 * can be animated; the geometry and the four gradient stops are untouched, and
 * must stay that way.
 */
export const Butterfly: React.FC<{
  size: number;
  opacity?: number;
  glow?: number;
  idSuffix?: string;
}> = ({size, opacity = 1, glow = 0, idSuffix = "hero"}) => {
  const gradientId = `butterfly-radial-glow-${idSuffix}`;

  return (
    <div style={{position: "relative", width: size, height: size, opacity}}>
      {glow > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: -size * 0.55,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(200,35,86,0.30) 0%, rgba(3,3,3,0) 66%)",
            opacity: glow,
            filter: `blur(${size * 0.16}px)`,
          }}
        />
      ) : null}
      <svg viewBox="0 0 100 100" width={size} height={size} style={{position: "relative"}}>
        <defs>
          <radialGradient id={gradientId} cx="30%" cy="100%" r="100%">
            <stop offset="0%" stopColor="#FF00FF" />
            <stop offset="30%" stopColor="#C82356" />
            <stop offset="70%" stopColor="#8B253B" />
            <stop offset="100%" stopColor="#3B0B1E" />
          </radialGradient>
        </defs>
        <path
          d="M 50 35 C 20 0, -10 30, 15 55 C -5 75, 25 100, 48 65 L 52 65 C 75 100, 105 75, 85 55 C 110 30, 80 0, 50 35 Z"
          fill={`url(#${gradientId})`}
        />
      </svg>
    </div>
  );
};
