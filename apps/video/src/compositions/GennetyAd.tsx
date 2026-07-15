import type {CSSProperties, ReactNode} from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {z} from "zod";

const WINE = "#8B253B";
const WINE_LIGHT = "#D16B80";
const INK = "#030303";
const SOFT = "#F5F5F5";
const MUTED = "#A7A2A6";
const SURFACE = "#161616";

const PROFILE_ASSETS = Array.from(
  {length: 10},
  (_, index) => `portraits/profile-${String(index + 1).padStart(2, "0")}.jpg`,
);

export const gennetyAdSchema = z.object({
  format: z.enum(["vertical", "horizontal"]),
  /** Optional public/ path. Add the final couple photo without changing scene code. */
  couplePhoto: z.string().optional(),
});

export type GennetyAdProps = z.infer<typeof gennetyAdSchema>;

type FormatProps = Pick<GennetyAdProps, "format">;

const asset = (path: string) => staticFile(path);

const ease = Easing.bezier(0.22, 1, 0.36, 1);

const fade = (frame: number, duration: number, edge = 14) =>
  interpolate(frame, [0, edge, duration - edge, duration], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

const enter = (frame: number, fps: number, delay = 0) =>
  spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: {damping: 18, mass: 0.8, stiffness: 130},
    durationInFrames: 34,
  });

const Noise: React.FC<{opacity?: number}> = ({opacity = 0.12}) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        opacity,
        mixBlendMode: "soft-light",
        pointerEvents: "none",
        backgroundImage:
          "radial-gradient(circle at 20% 30%, rgba(255,255,255,.28) 0 1px, transparent 1.5px), radial-gradient(circle at 70% 65%, rgba(255,255,255,.18) 0 1px, transparent 1.5px)",
        backgroundSize: "17px 19px, 23px 29px",
        transform: `translate(${frame % 3}px, ${(frame * 2) % 3}px)`,
      }}
    />
  );
};

const Ambient: React.FC<{format: GennetyAdProps["format"]; tint?: "wine" | "blue"}> = ({
  format,
  tint = "wine",
}) => {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 38) * 32;
  const accent = tint === "wine" ? "139,37,59" : "75,120,255";
  return (
    <AbsoluteFill
      style={{
        overflow: "hidden",
        background: INK,
      }}
    >
      <div
        style={{
          position: "absolute",
          width: format === "vertical" ? 1000 : 1250,
          height: format === "vertical" ? 1000 : 1250,
          borderRadius: "50%",
          top: format === "vertical" ? -420 + drift : -720 + drift,
          left: format === "vertical" ? -360 : 150,
          background: `radial-gradient(circle, rgba(${accent},.54), rgba(${accent},.12) 38%, transparent 68%)`,
          filter: "blur(16px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: format === "vertical" ? 840 : 980,
          height: format === "vertical" ? 840 : 980,
          borderRadius: "50%",
          bottom: format === "vertical" ? -350 - drift : -650 - drift,
          right: format === "vertical" ? -310 : -120,
          background:
            "radial-gradient(circle, rgba(211,107,128,.34), rgba(67,28,42,.12) 42%, transparent 70%)",
          filter: "blur(28px)",
        }}
      />
      <Noise />
    </AbsoluteFill>
  );
};

const Brand: React.FC<{
  size?: number;
  markOnly?: boolean;
  style?: CSSProperties;
}> = ({size = 38, markOnly = false, style}) => (
  <div style={{display: "flex", alignItems: "center", gap: size * 0.34, ...style}}>
    <Img
      src={asset("brand/butterfly-logo.svg")}
      style={{width: size * 1.55, height: size, objectFit: "contain"}}
    />
    {markOnly ? null : (
      <Img
        src={asset("brand/logo-wordmark.png")}
        style={{
          width: size * 3.63,
          height: size * 0.9,
          objectFit: "contain",
        }}
      />
    )}
  </div>
);

const GlassPill: React.FC<{children: ReactNode; style?: CSSProperties}> = ({children, style}) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 14,
      padding: "13px 19px",
      borderRadius: 999,
      color: SOFT,
      fontSize: 20,
      fontWeight: 700,
      letterSpacing: 0.2,
      background: "rgba(255,255,255,.09)",
      border: "1px solid rgba(255,255,255,.16)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,.12), 0 18px 60px rgba(0,0,0,.24)",
      backdropFilter: "blur(24px)",
      ...style,
    }}
  >
    {children}
  </div>
);

const Headline: React.FC<{
  children: ReactNode;
  format: GennetyAdProps["format"];
  align?: "left" | "center";
  size?: number;
  style?: CSSProperties;
}> = ({children, format, align = "left", size, style}) => (
  <div
    style={{
      color: SOFT,
      fontFamily: "Unbounded",
      fontWeight: 700,
      fontSize: size ?? (format === "vertical" ? 106 : 104),
      lineHeight: 0.94,
      letterSpacing: format === "vertical" ? -4.4 : -4,
      textAlign: align,
      textWrap: "balance",
      ...style,
    }}
  >
    {children}
  </div>
);

const ProfileCard: React.FC<{
  path: string;
  width: number;
  height: number;
  rotate?: number;
  style?: CSSProperties;
  dim?: number;
}> = ({path, width, height, rotate = 0, style, dim = 0}) => {
  const {transform: styleTransform, ...restStyle} = style ?? {};
  return (
    <div
      style={{
      position: "absolute",
      width,
      height,
      borderRadius: Math.min(width, height) * 0.085,
      overflow: "hidden",
      ...restStyle,
      transform: styleTransform ?? `rotate(${rotate}deg)`,
      background: SURFACE,
      border: "1px solid rgba(255,255,255,.16)",
      boxShadow: "0 40px 100px rgba(0,0,0,.46), inset 0 1px 0 rgba(255,255,255,.14)",
      }}
    >
    <Img src={asset(path)} style={{width: "100%", height: "100%", objectFit: "cover"}} />
    <AbsoluteFill
      style={{
        background: `linear-gradient(180deg, rgba(0,0,0,${dim * 0.3}), rgba(0,0,0,${dim}))`,
      }}
    />
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: "inherit",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,.07)",
      }}
    />
    </div>
  );
};

const SwipeCard: React.FC<{
  name: string;
  path: string;
  style: CSSProperties;
  frame: number;
  delay: number;
}> = ({name, path, style, frame, delay}) => {
  const {fps} = useVideoConfig();
  const progress = enter(frame, fps, delay);
  const {transform: styleTransform, ...restStyle} = style;
  return (
    <div
      style={{
        position: "absolute",
        width: 330,
        height: 500,
        borderRadius: 36,
        overflow: "hidden",
        background: SURFACE,
        border: "1px solid rgba(255,255,255,.14)",
        boxShadow: "0 38px 100px rgba(0,0,0,.55)",
        opacity: progress,
        ...restStyle,
        transform: `translateY(${(1 - progress) * 100}px) scale(${0.88 + progress * 0.12}) ${styleTransform ?? ""}`,
      }}
    >
      <Img src={asset(path)} style={{width: "100%", height: "100%", objectFit: "cover"}} />
      <div
        style={{
          position: "absolute",
          inset: "55% 0 0",
          background: "linear-gradient(transparent, rgba(0,0,0,.9))",
        }}
      />
      <div style={{position: "absolute", left: 24, right: 24, bottom: 24}}>
        <div style={{color: SOFT, fontSize: 30, fontWeight: 700}}>{name}</div>
        <div style={{color: "rgba(255,255,255,.66)", fontSize: 18, marginTop: 4}}>2 км від вас</div>
      </div>
      <div
        style={{
          position: "absolute",
          right: 20,
          top: 20,
          width: 47,
          height: 47,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: SOFT,
          fontSize: 26,
          background: "rgba(0,0,0,.38)",
          border: "1px solid rgba(255,255,255,.2)",
          backdropFilter: "blur(14px)",
        }}
      >
        ×
      </div>
    </div>
  );
};

const ChatBubble: React.FC<{text: string; left?: boolean; style?: CSSProperties}> = ({
  text,
  left = false,
  style,
}) => (
  <div
    style={{
      position: "absolute",
      maxWidth: 340,
      padding: "17px 22px",
      borderRadius: left ? "24px 24px 24px 7px" : "24px 24px 7px 24px",
      color: left ? SOFT : "#1a1718",
      fontSize: 20,
      fontWeight: 500,
      lineHeight: 1.25,
      background: left ? "rgba(255,255,255,.11)" : "#eee9ea",
      border: "1px solid rgba(255,255,255,.12)",
      boxShadow: "0 22px 50px rgba(0,0,0,.28)",
      backdropFilter: "blur(18px)",
      ...style,
    }}
  >
    {text}
  </div>
);

const HookScene: React.FC<FormatProps & {duration: number}> = ({format, duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const vertical = format === "vertical";
  const opacity = fade(frame, duration, 18);
  const titleIn = enter(frame, fps, 8);
  const pivot = interpolate(frame, [42, 66], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const cardShift = interpolate(frame, [60, 106], [0, vertical ? -820 : -470], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  return (
    <AbsoluteFill style={{opacity, overflow: "hidden"}}>
      <Ambient format={format} />
      <Brand
        size={vertical ? 44 : 38}
        style={{position: "absolute", top: vertical ? 70 : 48, left: vertical ? 72 : 78}}
      />

      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: vertical ? `translateY(${cardShift}px)` : `translateX(${cardShift}px)`,
        }}
      >
        <SwipeCard
          name="Marta, 24"
          path={PROFILE_ASSETS[1]}
          frame={frame}
          delay={2}
          style={{
            left: vertical ? -80 : 830,
            top: vertical ? 265 : 100,
            transform: "rotate(-8deg)",
          }}
        />
        <SwipeCard
          name="Alex, 26"
          path={PROFILE_ASSETS[3]}
          frame={frame}
          delay={8}
          style={{
            left: vertical ? 360 : 1170,
            top: vertical ? 215 : 190,
            transform: "rotate(7deg)",
          }}
        />
        <SwipeCard
          name="Sofia, 23"
          path={PROFILE_ASSETS[4]}
          frame={frame}
          delay={14}
          style={{
            left: vertical ? 730 : 1460,
            top: vertical ? 350 : 55,
            transform: "rotate(11deg)",
          }}
        />
      </div>

      <ChatBubble
        left
        text="Привіт :) Як твій день?"
        style={{left: vertical ? 76 : 100, top: vertical ? 910 : 620, opacity: 1 - pivot * 0.7}}
      />
      <ChatBubble
        text="Може, якось побачимось?"
        style={{right: vertical ? 72 : 104, top: vertical ? 1040 : 730, opacity: 1 - pivot * 0.7}}
      />
      <ChatBubble
        left
        text="Так, треба щось придумати…"
        style={{left: vertical ? 130 : 230, top: vertical ? 1180 : 840, opacity: 1 - pivot * 0.7}}
      />

      <div
        style={{
          position: "absolute",
          left: vertical ? 72 : 92,
          right: vertical ? 72 : 980,
          bottom: vertical ? 245 : 175,
          opacity: titleIn,
          transform: `translateY(${(1 - titleIn) * 58}px)`,
        }}
      >
        <Headline format={format} size={vertical ? 98 : 108}>
          <span style={{opacity: 1 - pivot}}>Поки ти свайпаєш…</span>
          <span
            style={{
              display: "block",
              marginTop: vertical ? -105 : -110,
              opacity: pivot,
              color: SOFT,
            }}
          >
            Хтось уже йде на <span style={{color: WINE_LIGHT}}>побачення.</span>
          </span>
        </Headline>
      </div>
    </AbsoluteFill>
  );
};

const OrbitPortrait: React.FC<{
  path: string;
  size: number;
  x: number;
  y: number;
  delay: number;
  frame: number;
}> = ({path, size, x, y, delay, frame}) => {
  const {fps} = useVideoConfig();
  const p = enter(frame, fps, delay);
  const float = Math.sin((frame + delay * 7) / 20) * 12;
  return (
    <div
      style={{
        position: "absolute",
        width: size,
        height: size,
        borderRadius: size * 0.27,
        overflow: "hidden",
        left: x,
        top: y + float,
        opacity: p,
        transform: `scale(${0.6 + p * 0.4}) rotate(${(1 - p) * 12}deg)`,
        border: "1px solid rgba(255,255,255,.18)",
        boxShadow: `0 0 0 8px rgba(255,255,255,.035), 0 0 ${50 + p * 30}px rgba(139,37,59,.34)`,
      }}
    >
      <Img src={asset(path)} style={{width: "100%", height: "100%", objectFit: "cover"}} />
    </div>
  );
};

const MatchingLines: React.FC<{format: GennetyAdProps["format"]; progress: number}> = ({format, progress}) => {
  const vertical = format === "vertical";
  const paths = vertical
    ? ["M160 350 C340 590 300 780 540 930", "M920 430 C710 570 760 810 540 930", "M120 1260 C340 1120 340 980 540 930", "M960 1310 C730 1160 760 1010 540 930"]
    : ["M1050 140 C920 280 1080 430 1240 540", "M1730 220 C1510 300 1510 470 1240 540", "M1020 850 C1050 700 1110 610 1240 540", "M1770 860 C1540 760 1510 610 1240 540"];
  return (
    <svg style={{position: "absolute", inset: 0, width: "100%", height: "100%"}} viewBox={vertical ? "0 0 1080 1920" : "0 0 1920 1080"}>
      <defs>
        <linearGradient id="line" x1="0" x2="1">
          <stop stopColor={WINE_LIGHT} stopOpacity=".1" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".7" />
          <stop offset="1" stopColor={WINE_LIGHT} stopOpacity=".18" />
        </linearGradient>
      </defs>
      {paths.map((d, index) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke="url(#line)"
          strokeWidth="2"
          pathLength="1"
          strokeDashoffset={1 - progress + index * 0.03}
          strokeDasharray={`${progress} ${1 - progress}`}
          opacity={progress}
        />
      ))}
    </svg>
  );
};

const AiScene: React.FC<FormatProps & {duration: number}> = ({format, duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const vertical = format === "vertical";
  const opacity = fade(frame, duration, 18);
  const copy = enter(frame, fps, 10);
  const lineProgress = interpolate(frame, [12, 72], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const matched = interpolate(frame, [82, 108], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const portraits = vertical
    ? [
        {path: PROFILE_ASSETS[4], size: 160, x: 30, y: 640},
        {path: PROFILE_ASSETS[6], size: 160, x: 890, y: 650},
        {path: PROFILE_ASSETS[7], size: 200, x: 20, y: 1180},
        {path: PROFILE_ASSETS[8], size: 220, x: 820, y: 1240},
      ]
    : [
        {path: PROFILE_ASSETS[4], size: 180, x: 980, y: 70},
        {path: PROFILE_ASSETS[6], size: 170, x: 1640, y: 110},
        {path: PROFILE_ASSETS[7], size: 190, x: 930, y: 750},
        {path: PROFILE_ASSETS[8], size: 200, x: 1640, y: 730},
      ];
  return (
    <AbsoluteFill style={{opacity, overflow: "hidden"}}>
      <Ambient format={format} tint="blue" />
      <MatchingLines format={format} progress={lineProgress} />
      {portraits.map((portrait, index) => (
        <OrbitPortrait key={portrait.path} {...portrait} delay={8 + index * 7} frame={frame} />
      ))}

      <div
        style={{
          position: "absolute",
          left: vertical ? 340 : 1110,
          top: vertical ? 735 : 410,
          width: vertical ? 400 : 270,
          height: vertical ? 400 : 270,
          borderRadius: vertical ? 130 : 90,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${0.86 + matched * 0.14})`,
          background:
            "radial-gradient(circle at 35% 25%, rgba(255,255,255,.22), rgba(255,255,255,.07) 35%, rgba(139,37,59,.2))",
          border: "1px solid rgba(255,255,255,.22)",
          boxShadow: `0 0 ${80 + matched * 90}px rgba(139,37,59,${0.25 + matched * 0.34}), inset 0 1px 0 rgba(255,255,255,.18)`,
          backdropFilter: "blur(34px)",
        }}
      >
        <Brand size={vertical ? 104 : 72} markOnly />
      </div>

      <div
        style={{
          position: "absolute",
          left: vertical ? 72 : 92,
          top: vertical ? 150 : 178,
          width: vertical ? 870 : 760,
          opacity: copy,
          transform: `translateY(${(1 - copy) * 50}px)`,
        }}
      >
        <GlassPill>
          <span style={{width: 9, height: 9, borderRadius: "50%", background: WINE_LIGHT, boxShadow: `0 0 20px ${WINE_LIGHT}`}} />
          AI-метчмейкер працює
        </GlassPill>
        <Headline format={format} size={vertical ? 100 : 105} style={{marginTop: 30}}>
          Шукає метч, поки ти <span style={{color: WINE_LIGHT}}>живеш.</span>
        </Headline>
        <div
          style={{
            color: "rgba(245,245,245,.7)",
            fontSize: vertical ? 31 : 29,
            lineHeight: 1.35,
            marginTop: 30,
            maxWidth: vertical ? 760 : 650,
          }}
        >
          Аналізує контекст, цінності та ваш вайб — без нескінченного перебору анкет.
        </div>
      </div>
    </AbsoluteFill>
  );
};

const MatchScene: React.FC<FormatProps & {duration: number}> = ({format, duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const vertical = format === "vertical";
  const opacity = fade(frame, duration, 14);
  const p = enter(frame, fps, 4);
  const meet = interpolate(frame, [10, 54], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const cardW = vertical ? 420 : 400;
  const cardH = vertical ? 650 : 620;
  return (
    <AbsoluteFill style={{opacity, overflow: "hidden"}}>
      <Ambient format={format} />
      <Brand
        size={vertical ? 42 : 36}
        style={{position: "absolute", top: vertical ? 70 : 45, left: vertical ? 72 : 82}}
      />

      <ProfileCard
        path={PROFILE_ASSETS[0]}
        width={cardW}
        height={cardH}
        rotate={vertical ? -6 : -5}
        style={{
          left: vertical ? interpolate(meet, [0, 1], [-120, 135]) : interpolate(meet, [0, 1], [820, 1050]),
          top: vertical ? 420 : 190,
          transform: `rotate(-6deg) scale(${0.9 + p * 0.1})`,
        }}
      />
      <ProfileCard
        path={PROFILE_ASSETS[2]}
        width={cardW}
        height={cardH}
        rotate={vertical ? 6 : 5}
        style={{
          right: vertical ? interpolate(meet, [0, 1], [-120, 135]) : interpolate(meet, [0, 1], [-80, 120]),
          top: vertical ? 510 : 250,
          transform: `rotate(6deg) scale(${0.9 + p * 0.1})`,
        }}
      />

      <div
        style={{
          position: "absolute",
          left: vertical ? 435 : 1350,
          top: vertical ? 780 : 445,
          width: vertical ? 210 : 170,
          height: vertical ? 210 : 170,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: meet,
          transform: `scale(${0.45 + meet * 0.55}) rotate(${(1 - meet) * -30}deg)`,
          background: WINE,
          border: "10px solid #050505",
          boxShadow: `0 0 90px rgba(139,37,59,.9)`,
        }}
      >
        <Brand size={vertical ? 66 : 52} markOnly />
      </div>

      <div
        style={{
          position: "absolute",
          left: vertical ? 72 : 90,
          right: vertical ? 72 : 1050,
          top: vertical ? 150 : 180,
          opacity: p,
          transform: `translateY(${(1 - p) * 50}px)`,
        }}
      >
        <GlassPill style={{color: "#f3ccd4"}}>Збіг знайдено</GlassPill>
        <Headline format={format} size={vertical ? 102 : 116} style={{marginTop: 28}}>
          Контекст.<br />Цінності.<br />
          <span style={{color: WINE_LIGHT}}>Вайб.</span>
        </Headline>
        <div style={{color: MUTED, fontSize: vertical ? 29 : 28, marginTop: 28, lineHeight: 1.4}}>
          Не просто “лайк”. Причина зустрітися.
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Phone: React.FC<{
  children: ReactNode;
  width: number;
  height: number;
  style?: CSSProperties;
}> = ({children, width, height, style}) => (
  <div
    style={{
      position: "absolute",
      width,
      height,
      padding: Math.max(10, width * 0.022),
      borderRadius: width * 0.105,
      background: "linear-gradient(145deg, #3a3839, #070707 45%, #2c292a)",
      boxShadow: "0 60px 150px rgba(0,0,0,.62), 0 0 0 1px rgba(255,255,255,.18)",
      ...style,
    }}
  >
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        borderRadius: width * 0.084,
        overflow: "hidden",
        background: "#030303",
        border: "1px solid rgba(255,255,255,.08)",
      }}
    >
      <div
        style={{
          position: "absolute",
          zIndex: 20,
          top: width * 0.027,
          left: "50%",
          width: width * 0.28,
          height: width * 0.07,
          borderRadius: 999,
          background: "#050505",
          transform: "translateX(-50%)",
        }}
      />
      {children}
    </div>
  </div>
);

const Cursor: React.FC<{x: number; y: number; pressed?: number}> = ({x, y, pressed = 0}) => (
  <div
    style={{
      position: "absolute",
      zIndex: 30,
      left: x,
      top: y,
      width: 58,
      height: 58,
      borderRadius: "50%",
      background: "rgba(255,255,255,.12)",
      border: "2px solid rgba(255,255,255,.8)",
      boxShadow: `0 0 0 ${pressed * 28}px rgba(255,255,255,${0.2 * (1 - pressed)}), 0 8px 24px rgba(0,0,0,.3)`,
      transform: `translate(-50%, -50%) scale(${1 - pressed * 0.28})`,
    }}
  >
    <div
      style={{
        position: "absolute",
        left: 18,
        top: 18,
        width: 18,
        height: 18,
        borderRadius: "50%",
        background: "#fff",
      }}
    />
  </div>
);

const CalendarUi: React.FC<{frame: number}> = ({frame}) => {
  const dates = [
    {day: "СР", date: "15"},
    {day: "ЧТ", date: "16"},
    {day: "ПТ", date: "17"},
    {day: "СБ", date: "18"},
    {day: "НД", date: "19"},
  ];
  const sheet = interpolate(frame, [24, 46], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const peer = interpolate(frame, [68, 90], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const pressOne = interpolate(frame, [18, 24, 30], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const pressTwo = interpolate(frame, [47, 54, 61], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cursorX = interpolate(frame, [0, 22, 48, 58], [520, 375, 375, 305], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const cursorY = interpolate(frame, [0, 22, 48, 58], [900, 350, 350, 812], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const confirmed = frame > 92;
  return (
    <AbsoluteFill style={{background: "#030303", color: SOFT, fontFamily: "Roboto"}}>
      <div style={{padding: "72px 44px 28px"}}>
        <div style={{display: "flex", justifyContent: "space-between", alignItems: "center"}}>
          <Brand size={29} />
          <GlassPill style={{padding: "8px 12px", fontSize: 14}}>Календар</GlassPill>
        </div>
        <div style={{fontFamily: "Unbounded", fontWeight: 700, fontSize: 40, letterSpacing: -1.7, marginTop: 52, lineHeight: 1.02}}>
          Коли вам зручно?
        </div>
        <div style={{color: MUTED, fontSize: 19, marginTop: 13, lineHeight: 1.35}}>
          Оберіть час. Перетин з’явиться автоматично.
        </div>
        <div style={{display: "flex", gap: 18, marginTop: 24, color: MUTED, fontSize: 15}}>
          <span><b style={{display: "inline-block", width: 10, height: 10, borderRadius: 3, background: SOFT, marginRight: 7}} />Ви</span>
          <span><b style={{display: "inline-block", width: 10, height: 10, borderRadius: 3, background: WINE, marginRight: 7}} />Метч</span>
          <span><b style={{display: "inline-block", width: 10, height: 10, borderRadius: 3, background: `linear-gradient(135deg, ${SOFT} 50%, ${WINE} 50%)`, marginRight: 7}} />Разом</span>
        </div>
      </div>
      <div style={{display: "flex", gap: 12, padding: "18px 30px"}}>
        {dates.map((item, index) => {
          const selected = index === 2;
          return (
            <div
              key={item.date}
              style={{
                flex: 1,
                height: 118,
                borderRadius: 20,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
                color: selected ? "#111" : SOFT,
                background: selected ? SOFT : SURFACE,
                border: `1px solid ${selected ? SOFT : "rgba(255,255,255,.08)"}`,
                boxShadow: selected ? "0 18px 46px rgba(255,255,255,.12)" : "none",
              }}
            >
              <span style={{fontSize: 14, fontWeight: 700, opacity: 0.58}}>{item.day}</span>
              <span style={{fontSize: 31, fontWeight: 700}}>{item.date}</span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: "absolute",
          left: 14,
          right: 14,
          bottom: 14,
          height: 650,
          padding: "28px 26px",
          borderRadius: "34px 34px 42px 42px",
          transform: `translateY(${(1 - sheet) * 690}px)`,
          background: "rgba(26,26,26,.94)",
          border: "1px solid rgba(255,255,255,.13)",
          boxShadow: "0 -28px 80px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.08)",
          backdropFilter: "blur(34px)",
        }}
      >
        <div style={{width: 54, height: 5, borderRadius: 9, background: "rgba(255,255,255,.22)", margin: "0 auto 24px"}} />
        <div style={{fontWeight: 700, fontSize: 25}}>П’ятниця, 17 липня</div>
        <div style={{color: MUTED, fontSize: 16, marginTop: 7}}>Оберіть один або кілька слотів</div>
        <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 25}}>
          {["17:00", "17:30", "18:00", "18:30", "19:00", "19:30"].map((time, index) => {
            const mine = index === 2 || index === 3;
            const overlap = index === 2 && peer > 0.65;
            return (
              <div
                key={time}
                style={{
                  height: 72,
                  borderRadius: 16,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 21,
                  fontWeight: 700,
                  color: mine ? "#111" : SOFT,
                  background: overlap
                    ? `linear-gradient(135deg, ${SOFT} 0 48%, ${WINE} 52% 100%)`
                    : mine
                      ? SOFT
                      : index === 1 && peer > 0.65
                        ? WINE
                        : "#242424",
                  border: "1px solid rgba(255,255,255,.09)",
                }}
              >
                {time}
              </div>
            );
          })}
        </div>
        <div
          style={{
            height: 76,
            borderRadius: 18,
            marginTop: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: SOFT,
            fontSize: 20,
            fontWeight: 700,
            background: `linear-gradient(135deg, ${WINE}, #A93F58)`,
            boxShadow: "0 20px 46px rgba(139,37,59,.34)",
          }}
        >
          {confirmed ? "Час збігається ✓" : "Зберегти час"}
        </div>
      </div>
      {frame < 104 ? <Cursor x={cursorX} y={cursorY} pressed={Math.max(pressOne, pressTwo)} /> : null}
    </AbsoluteFill>
  );
};

const ProductSceneLayout: React.FC<
  FormatProps & {
    duration: number;
    title: ReactNode;
    subtitle: string;
    pill: string;
    children: ReactNode;
  }
> = ({format, duration, title, subtitle, pill, children}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const vertical = format === "vertical";
  const opacity = fade(frame, duration, 14);
  const copy = enter(frame, fps, 4);
  const device = enter(frame, fps, 10);
  return (
    <AbsoluteFill style={{opacity, overflow: "hidden"}}>
      <Ambient format={format} />
      <div
        style={{
          position: "absolute",
          left: vertical ? 70 : 90,
          top: vertical ? 104 : 210,
          width: vertical ? 900 : 710,
          zIndex: 5,
          opacity: copy,
          transform: `translateY(${(1 - copy) * 46}px)`,
        }}
      >
        <GlassPill>{pill}</GlassPill>
        <Headline format={format} size={vertical ? 93 : 105} style={{marginTop: 27}}>
          {title}
        </Headline>
        <div
          style={{
            color: "rgba(245,245,245,.66)",
            fontSize: vertical ? 28 : 28,
            lineHeight: 1.42,
            marginTop: 27,
            maxWidth: vertical ? 780 : 620,
          }}
        >
          {subtitle}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: device,
          transform: `translateY(${(1 - device) * 90}px) scale(${0.94 + device * 0.06})`,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};

const CalendarScene: React.FC<FormatProps & {duration: number}> = ({format, duration}) => {
  const frame = useCurrentFrame();
  const vertical = format === "vertical";
  return (
    <ProductSceneLayout
      format={format}
      duration={duration}
      pill="Жодної координації в чаті"
      title={<>Обираєте час — <span style={{color: WINE_LIGHT}}>разом.</span></>}
      subtitle="Справжній календар Gennety показує перетин ваших вільних слотів у реальному часі."
    >
      <Phone
        width={vertical ? 660 : 520}
        height={vertical ? 1220 : 940}
        style={{
          left: vertical ? 210 : 1120,
          top: vertical ? 610 : 65,
          transform: vertical ? "rotate(1.8deg)" : "rotate(2.5deg)",
        }}
      >
        <CalendarUi frame={frame} />
      </Phone>
    </ProductSceneLayout>
  );
};

const MapBackdrop: React.FC = () => (
  <AbsoluteFill style={{background: "#17191b"}}>
    <svg width="100%" height="100%" viewBox="0 0 720 1280" preserveAspectRatio="xMidYMid slice">
      <rect width="720" height="1280" fill="#17191b" />
      <path d="M-40 940 C150 820 180 620 360 540 S590 360 760 190" stroke="#2f3437" strokeWidth="58" fill="none" />
      <path d="M-20 930 C170 810 190 625 370 550 S600 370 750 205" stroke="#6a6264" strokeOpacity=".38" strokeWidth="4" fill="none" />
      <path d="M-20 280 C180 420 310 360 440 510 S610 760 760 750" stroke="#303538" strokeWidth="36" fill="none" />
      <path d="M-20 280 C180 420 310 360 440 510 S610 760 760 750" stroke="#807678" strokeOpacity=".3" strokeWidth="3" fill="none" />
      <path d="M120 -20 C150 230 270 350 210 580 S120 920 260 1300" stroke="#272c2f" strokeWidth="24" fill="none" />
      <path d="M560 -20 C520 260 580 410 500 620 S440 960 570 1300" stroke="#292e31" strokeWidth="28" fill="none" />
      <g fill="#262a2c" stroke="#353a3d" strokeWidth="2">
        <path d="M40 90h180v120H40z" /><path d="M260 70h180v180H260z" /><path d="M500 80h180v100H500z" />
        <path d="M20 470h160v180H20z" /><path d="M260 660h190v150H260z" /><path d="M500 840h180v190H500z" />
        <path d="M30 1080h210v130H30z" /><path d="M300 1040h150v180H300z" />
      </g>
      <g fill="#9c9798" opacity=".58" fontFamily="Roboto" fontSize="18">
        <text x="60" y="245">Золоті ворота</text>
        <text x="475" y="815">Театральна</text>
        <text x="270" y="960">вул. Володимирська</text>
      </g>
    </svg>
    <AbsoluteFill style={{background: "radial-gradient(circle at 50% 50%, transparent 35%, rgba(0,0,0,.45) 100%)"}} />
  </AbsoluteFill>
);

const Pin: React.FC = () => (
  <div
    style={{
      position: "absolute",
      left: "50%",
      top: "43%",
      width: 76,
      height: 76,
      borderRadius: "50% 50% 50% 10%",
      transform: "translate(-50%, -50%) rotate(-45deg)",
      background: `linear-gradient(135deg, ${WINE_LIGHT}, ${WINE})`,
      boxShadow: "0 20px 50px rgba(139,37,59,.58), 0 0 0 10px rgba(139,37,59,.16)",
      border: "3px solid rgba(255,255,255,.75)",
    }}
  >
    <div
      style={{
        position: "absolute",
        left: 23,
        top: 23,
        width: 24,
        height: 24,
        borderRadius: "50%",
        background: SOFT,
      }}
    />
  </div>
);

const LocationUi: React.FC<{frame: number}> = ({frame}) => {
  const press = interpolate(frame, [54, 61, 69], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const selected = interpolate(frame, [68, 88], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const cursorY = interpolate(frame, [0, 52], [590, 1080], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  return (
    <AbsoluteFill style={{color: SOFT}}>
      <MapBackdrop />
      <Pin />
      <div
        style={{
          position: "absolute",
          left: 24,
          right: 24,
          top: 76,
          height: 76,
          borderRadius: 24,
          display: "flex",
          alignItems: "center",
          padding: "0 24px",
          gap: 16,
          color: "rgba(255,255,255,.62)",
          fontSize: 18,
          background: "rgba(20,20,20,.72)",
          border: "1px solid rgba(255,255,255,.16)",
          boxShadow: "0 20px 50px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.1)",
          backdropFilter: "blur(26px)",
        }}
      >
        <span style={{fontSize: 30}}>⌕</span> Пошук адреси
      </div>
      <div
        style={{
          position: "absolute",
          left: 18,
          right: 18,
          bottom: 18,
          padding: "24px",
          borderRadius: 34,
          background: "rgba(18,18,18,.85)",
          border: "1px solid rgba(255,255,255,.16)",
          boxShadow: "0 -24px 70px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.1)",
          backdropFilter: "blur(30px)",
        }}
      >
        <div style={{display: "flex", gap: 15, alignItems: "center"}}>
          <div style={{width: 50, height: 50, borderRadius: 17, background: WINE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24}}>⌖</div>
          <div>
            <div style={{fontSize: 20, fontWeight: 700}}>вул. Нижній Вал, 19</div>
            <div style={{fontSize: 15, color: MUTED, marginTop: 4}}>Київ, Україна</div>
          </div>
        </div>
        <div
          style={{
            height: 78,
            marginTop: 22,
            borderRadius: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: SOFT,
            fontSize: 20,
            fontWeight: 700,
            background: selected > 0.8 ? "#245f45" : `linear-gradient(135deg, ${WINE}, #ad405a)`,
            boxShadow: `0 22px 54px rgba(139,37,59,${0.36 * (1 - selected)})`,
          }}
        >
          {selected > 0.8 ? "Місце підтверджено ✓" : "Підтвердити місце"}
        </div>
      </div>
      {frame < 82 ? <Cursor x={470} y={cursorY} pressed={press} /> : null}
    </AbsoluteFill>
  );
};

const VenueScene: React.FC<FormatProps & {duration: number}> = ({format, duration}) => {
  const frame = useCurrentFrame();
  const vertical = format === "vertical";
  return (
    <ProductSceneLayout
      format={format}
      duration={duration}
      pill="Місце теж планує Gennety"
      title={<>Зустріч — у <span style={{color: WINE_LIGHT}}>перевіреному місці.</span></>}
      subtitle="Сервіс підбирає якісний публічний заклад і веде вас до підтвердження."
    >
      <Phone
        width={vertical ? 660 : 520}
        height={vertical ? 1220 : 940}
        style={{
          left: vertical ? 210 : 1120,
          top: vertical ? 610 : 65,
          transform: vertical ? "rotate(-1.5deg)" : "rotate(-2.3deg)",
        }}
      >
        <LocationUi frame={frame} />
      </Phone>
    </ProductSceneLayout>
  );
};

const DateCard: React.FC<{format: GennetyAdProps["format"]; progress: number}> = ({format, progress}) => {
  const vertical = format === "vertical";
  const width = vertical ? 820 : 720;
  const height = width * 1.25;
  return (
    <div
      style={{
        position: "absolute",
        width,
        height,
        right: vertical ? 130 : 120,
        top: vertical ? 610 : 40,
        borderRadius: 40,
        overflow: "hidden",
        background: "#050505",
        boxShadow: "0 60px 150px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.14)",
        transform: `rotate(${vertical ? -1.5 : 2.2}deg) scale(${0.91 + progress * 0.09})`,
      }}
    >
      <div style={{position: "absolute", left: 46, right: 46, top: 42, display: "flex", justifyContent: "space-between", zIndex: 5}}>
        <Brand size={vertical ? 31 : 28} />
        <Brand size={vertical ? 42 : 38} markOnly />
      </div>
      <div
        style={{
          position: "absolute",
          left: 46,
          right: 46,
          top: vertical ? 125 : 112,
          color: SOFT,
          fontFamily: "Unbounded",
          fontWeight: 700,
          fontSize: vertical ? 42 : 37,
          lineHeight: 0.99,
          letterSpacing: -2.7,
          zIndex: 4,
        }}
      >
        Error 404: чат не знайдено.<br />
        <span style={{color: WINE_LIGHT}}>Спробуй реальне життя.</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 32,
          right: 32,
          top: vertical ? 310 : 275,
          height: vertical ? 535 : 470,
          borderRadius: 30,
          overflow: "hidden",
          boxShadow: "0 30px 80px rgba(0,0,0,.5)",
        }}
      >
        <Img src={asset("places/kyiv-honey.jpg")} style={{width: "100%", height: "100%", objectFit: "cover", filter: "saturate(.72) contrast(1.1)"}} />
        <AbsoluteFill style={{background: "linear-gradient(180deg, rgba(139,37,59,.1), rgba(0,0,0,.48))"}} />
      </div>
      <div
        style={{
          position: "absolute",
          width: vertical ? 230 : 205,
          height: vertical ? 300 : 268,
          right: 50,
          top: vertical ? 560 : 500,
          padding: 10,
          paddingBottom: 38,
          background: SOFT,
          transform: "rotate(7deg)",
          boxShadow: "0 28px 65px rgba(0,0,0,.55)",
          zIndex: 4,
        }}
      >
        <Img src={asset(PROFILE_ASSETS[2])} style={{width: "100%", height: "100%", objectFit: "cover"}} />
      </div>
      <div style={{position: "absolute", left: 48, right: 48, bottom: 46}}>
        <div style={{color: SOFT, fontSize: vertical ? 30 : 27, fontWeight: 700}}>Honey Café</div>
        <div style={{color: MUTED, fontSize: vertical ? 20 : 18, marginTop: 8}}>вул. Нижній Вал, 19 · П’ятниця, 18:00</div>
      </div>
      <Noise opacity={0.09} />
    </div>
  );
};

const ConfirmationScene: React.FC<FormatProps & {duration: number}> = ({format, duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const vertical = format === "vertical";
  const opacity = fade(frame, duration, 12);
  const p = enter(frame, fps, 3);
  return (
    <AbsoluteFill style={{opacity, overflow: "hidden"}}>
      <Ambient format={format} />
      <DateCard format={format} progress={p} />
      <div
        style={{
          position: "absolute",
          left: vertical ? 72 : 90,
          top: vertical ? 120 : 230,
          width: vertical ? 850 : 820,
          opacity: p,
          transform: `translateY(${(1 - p) * 50}px)`,
        }}
      >
        <GlassPill>Побачення заплановано</GlassPill>
        <Headline format={format} size={vertical ? 101 : 114} style={{marginTop: 27}}>
          Менше чатів.<br />
          <span style={{color: WINE_LIGHT}}>Більше життя.</span>
        </Headline>
        <div style={{color: MUTED, fontSize: vertical ? 28 : 28, marginTop: 27, lineHeight: 1.4}}>
          Час, місце і деталі вже у твоїй картці.
        </div>
      </div>
    </AbsoluteFill>
  );
};

const CoupleVisual: React.FC<{
  format: GennetyAdProps["format"];
  couplePhoto?: string;
  progress: number;
}> = ({format, couplePhoto, progress}) => {
  const vertical = format === "vertical";
  const frameStyle: CSSProperties = {
    position: "absolute",
    overflow: "hidden",
    borderRadius: vertical ? 54 : 46,
    border: "1px solid rgba(255,255,255,.17)",
    boxShadow: "0 55px 140px rgba(0,0,0,.58), inset 0 1px 0 rgba(255,255,255,.12)",
    opacity: progress,
  };
  if (couplePhoto) {
    return (
      <div
        style={{
          ...frameStyle,
          left: vertical ? 80 : 970,
          right: vertical ? 80 : 90,
          top: vertical ? 160 : 70,
          bottom: vertical ? 700 : 70,
        }}
      >
        <Img src={asset(couplePhoto)} style={{width: "100%", height: "100%", objectFit: "cover"}} />
        <AbsoluteFill style={{background: "linear-gradient(180deg, rgba(0,0,0,.04), rgba(0,0,0,.5))"}} />
      </div>
    );
  }
  return (
    <div
      style={{
        ...frameStyle,
        left: vertical ? 80 : 970,
        right: vertical ? 80 : 90,
        top: vertical ? 160 : 70,
        bottom: vertical ? 700 : 70,
        background: "#111",
      }}
    >
      <div style={{position: "absolute", inset: 0, display: "flex"}}>
        <div style={{width: "50%", height: "100%", overflow: "hidden"}}>
          <Img src={asset(PROFILE_ASSETS[0])} style={{width: "100%", height: "100%", objectFit: "cover", objectPosition: "48% center"}} />
        </div>
        <div style={{width: "50%", height: "100%", overflow: "hidden"}}>
          <Img src={asset(PROFILE_ASSETS[2])} style={{width: "100%", height: "100%", objectFit: "cover", objectPosition: "48% center"}} />
        </div>
      </div>
      <AbsoluteFill style={{background: "linear-gradient(180deg, transparent 35%, rgba(0,0,0,.64))"}} />
      <div
        style={{
          position: "absolute",
          left: 30,
          right: 30,
          bottom: 28,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <GlassPill style={{fontSize: vertical ? 22 : 19}}>Фінальне фото пари — наступна заміна</GlassPill>
      </div>
    </div>
  );
};

const CtaScene: React.FC<FormatProps & {duration: number; couplePhoto?: string}> = ({
  format,
  duration,
  couplePhoto,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const vertical = format === "vertical";
  const opacity = fade(frame, duration, 8);
  const p = enter(frame, fps, 2);
  const pulse = 1 + Math.sin(frame / 8) * 0.018;
  return (
    <AbsoluteFill style={{opacity, overflow: "hidden"}}>
      <Ambient format={format} />
      <CoupleVisual format={format} couplePhoto={couplePhoto} progress={p} />
      <div
        style={{
          position: "absolute",
          left: vertical ? 72 : 90,
          right: vertical ? 72 : 1030,
          bottom: vertical ? 110 : 105,
          opacity: p,
          transform: `translateY(${(1 - p) * 50}px)`,
        }}
      >
        <Brand size={vertical ? 52 : 46} />
        <Headline format={format} size={vertical ? 97 : 82} style={{marginTop: 32}}>
          Твій персональний<br />
          <span style={{color: WINE_LIGHT}}>AI-метчмейкер.</span>
        </Headline>
        <div style={{color: "rgba(245,245,245,.72)", fontSize: vertical ? 29 : 28, marginTop: 25}}>
          Справжні люди. Справжні побачення.
        </div>
        <div
          style={{
            width: vertical ? "100%" : 430,
            height: vertical ? 92 : 82,
            marginTop: 36,
            borderRadius: 26,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: SOFT,
            fontSize: vertical ? 30 : 27,
            fontWeight: 700,
            transform: `scale(${pulse})`,
            background: `linear-gradient(135deg, ${WINE}, #B54460)`,
            boxShadow: "0 28px 72px rgba(139,37,59,.48), inset 0 1px 0 rgba(255,255,255,.16)",
          }}
        >
          Приєднатися до Gennety →
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const GennetyAd: React.FC<GennetyAdProps> = ({format, couplePhoto}) => {
  return (
    <AbsoluteFill style={{background: INK}}>
      <Sequence durationInFrames={120} premountFor={30}>
        <HookScene format={format} duration={120} />
      </Sequence>
      <Sequence from={105} durationInFrames={150} premountFor={30}>
        <AiScene format={format} duration={150} />
      </Sequence>
      <Sequence from={240} durationInFrames={90} premountFor={30}>
        <MatchScene format={format} duration={90} />
      </Sequence>
      <Sequence from={315} durationInFrames={135} premountFor={30}>
        <CalendarScene format={format} duration={135} />
      </Sequence>
      <Sequence from={435} durationInFrames={105} premountFor={30}>
        <VenueScene format={format} duration={105} />
      </Sequence>
      <Sequence from={525} durationInFrames={75} premountFor={30}>
        <ConfirmationScene format={format} duration={75} />
      </Sequence>
      <Sequence from={585} durationInFrames={75} premountFor={30}>
        <CtaScene format={format} duration={75} couplePhoto={couplePhoto} />
      </Sequence>
    </AbsoluteFill>
  );
};
