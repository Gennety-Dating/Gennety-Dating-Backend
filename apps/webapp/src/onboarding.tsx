import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  acceptTelegramOnboardingConsent,
  completeTelegramOnboardingGate,
  fetchTelegramOnboardingState,
  requestTelegramOnboardingOtp,
  setTelegramOnboardingLanguage,
  verifyTelegramOnboardingOtp,
  CalendarApiError,
  type OnboardingLanguage,
  type TelegramOnboardingState,
} from "./api.js";
import "./onboarding.css";

const app = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const source = params.get("source") ?? app?.initDataUnsafe?.start_param ?? null;

const PROFILE_IMAGE =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuD3Em0JzID6Z04xJ5a_QgvVbiTzxx59H2rlwGXP_VgUkQuez8eozoM5bD2JZv_NRrpWKoAeWnFr6R3U7EljfXy4tqY2O2lRL0GL12uSBwF6aPEtFsCLDMcXqdnrEX8emReLN4LhoWKpOZNxYsOpOaiSwbm6nwi6lYlqaMdgoSZ7XuEEWkSZqb7GfDkjPzdYSTZEugO7zIXCb3HrGQX8McYpp05_emtAHX-_zqXRdCeCMVMxVAL_nJBpbxihO2fWaVWWmT7iK3XfH-t1";
const TRAP_BACKGROUND =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuDT22v5JOFjqN2g1VkI86PnzZJ_vTS3whfVoE4pTqZMVY_zqEjFKQf0fGlab3jjVTIxx1gKK5zx4u10XcEtFiFDqeEsGaLjoNTdZMWbR46RULeC47iOvuiqYHU8PJrKZ9kQVqufAHWY-pv_0RSTu1V7cSz_tLD89uoBf8RE9OxG9ZhXIGcEKvxkjcwB3oa3Kf9KjRlxyoUZcBMol4eX5hJ6Oh2_fhyciV6tYxlSEoexfNp4Pr7iGISmsLdSC0fp35_bW0OO_cj0xmGN";
const VISUAL_LAST_INDEX = 2;
const HOOK_AUTO_ADVANCE_MS = 2000;
const DRUM_CYCLE_INTERVAL_MS = 1500;

type RemoteUser = TelegramOnboardingState["user"];
type Phase =
  | { kind: "visual"; index: number }
  | { kind: "syncing" }
  | { kind: "consent" }
  | { kind: "language" }
  | { kind: "email" }
  | { kind: "otp"; email: string }
  | { kind: "loading" }
  | { kind: "done" };

interface StatCopy {
  value: string;
  label: string;
  valueSmall?: boolean;
  labelSentence?: boolean;
}

const EXHAUSTION_LINES = [
  "Он ухудшает вашу психику, настоящий рынок мяса",
  "Бесконечный перебор людей, как в супермаркете, убивает эмпатию",
  "Вы тратите недели на переписки, которые ни к чему не приводят",
];

const STAT_COPY: StatCopy[] = [
  { value: "75", label: "часов" },
  { value: "9500", label: "свайпов" },
  {
    value: "$200",
    valueSmall: true,
    label: "в виде внутриплатформенных покупок",
    labelSentence: true,
  },
];

const LANGUAGE_OPTIONS: Array<{ value: OnboardingLanguage; label: string; sub: string }> = [
  { value: "en", label: "English", sub: "Continue in English" },
  { value: "ru", label: "Русский", sub: "Продолжить на русском" },
  { value: "uk", label: "Українська", sub: "Продовжити українською" },
  { value: "de", label: "Deutsch", sub: "Auf Deutsch fortfahren" },
  { value: "pl", label: "Polski", sub: "Kontynuuj po polsku" },
];

function preVisualPhaseFromRemote(user: RemoteUser | null): Phase {
  if (!user) return { kind: "syncing" };
  if (!user.termsAccepted) return { kind: "consent" };
  if (!user.language) return { kind: "language" };
  if (!user.isEmailVerified) return { kind: "email" };
  return { kind: "visual", index: 0 };
}

function postVisualPhaseFromRemote(user: RemoteUser | null): Phase {
  if (!user) return { kind: "syncing" };
  if (!user.termsAccepted) return { kind: "consent" };
  if (!user.language) return { kind: "language" };
  if (!user.isEmailVerified) return { kind: "email" };
  return { kind: "loading" };
}

function configureTelegramChrome(): void {
  app?.ready();
  app?.expand();
  try {
    app?.setHeaderColor?.("#000000");
    app?.setBackgroundColor?.("#000000");
    app?.setBottomBarColor?.("#000000");
    if (app?.isVersionAtLeast?.("8.0")) {
      app.requestFullscreen?.();
      app.lockOrientation?.();
    }
  } catch {
    // Older Telegram clients ignore these methods; the CSS still renders black.
  }
}

function App(): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: "syncing" });
  const [remoteUser, setRemoteUser] = useState<RemoteUser | null>(null);
  const [flowToken, setFlowToken] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    configureTelegramChrome();
    if (!app?.initData) {
      setBootError("Открой мини-приложение из чата с ботом, чтобы продолжить.");
      return;
    }
    void fetchTelegramOnboardingState(app.initData, source)
      .then((state) => {
        setRemoteUser(state.user);
        setFlowToken(state.flowToken);
        setPhase(preVisualPhaseFromRemote(state.user));
      })
      .catch((err: unknown) => {
        setBootError(errorCopy(err));
        app?.HapticFeedback?.notificationOccurred("error");
      });
  }, []);

  const goBack = useCallback(() => {
    setPhase((current) => {
      if (current.kind === "visual" && current.index > 0) {
        return { kind: "visual", index: current.index - 1 };
      }
      if (current.kind === "visual" && current.index === 0) {
        if (remoteUser && !remoteUser.isEmailVerified) return { kind: "email" };
        return { kind: "language" };
      }
      if (current.kind === "language") return { kind: "consent" };
      if (current.kind === "email") return { kind: "language" };
      if (current.kind === "otp") return { kind: "email" };
      return current;
    });
  }, [remoteUser]);

  const canGoBack =
    phase.kind === "visual"
      ? phase.index > 0
      : phase.kind === "language" || phase.kind === "email" || phase.kind === "otp";

  useEffect(() => {
    if (!app?.BackButton) return;
    const handler = () => goBack();
    app.BackButton.onClick(handler);
    if (canGoBack) app.BackButton.show();
    else app.BackButton.hide();
    return () => app.BackButton?.offClick(handler);
  }, [canGoBack, goBack]);

  const routeFromRemote = useCallback((user: RemoteUser | null): void => {
    setPhase(preVisualPhaseFromRemote(user));
  }, []);

  const nextVisual = useCallback((withHaptic = true) => {
    if (withHaptic) app?.HapticFeedback?.selectionChanged();
    setPhase((current) => {
      if (current.kind !== "visual") return current;
      if (current.index < VISUAL_LAST_INDEX) return { kind: "visual", index: current.index + 1 };
      return postVisualPhaseFromRemote(remoteUser);
    });
  }, [remoteUser]);
  const nextVisualSilently = useCallback(() => nextVisual(false), [nextVisual]);
  const nextVisualWithHaptic = useCallback(() => nextVisual(), [nextVisual]);

  const onState = useCallback(
    (state: TelegramOnboardingState) => {
      setRemoteUser(state.user);
      setFlowToken(state.flowToken);
      routeFromRemote(state.user);
    },
    [routeFromRemote],
  );

  useEffect(() => {
    if (phase.kind === "syncing" && remoteUser) {
      routeFromRemote(remoteUser);
    }
  }, [phase.kind, remoteUser, routeFromRemote]);

  const chrome = canGoBack ? <TopChrome onBack={goBack} /> : null;

  return (
    <div className="onboarding-shell bg-surface text-on-surface min-h-screen antialiased">
      {chrome}
      {bootError ? <div className="gate-meta" style={{ position: "fixed", top: 12, left: 20, right: 20, zIndex: 60 }}>{bootError}</div> : null}
      <Scene active={phase.kind === "visual" && phase.index === 0}>
        <HookScene active={phase.kind === "visual" && phase.index === 0} onNext={nextVisualSilently} />
      </Scene>
      <Scene active={phase.kind === "visual" && phase.index === 1}>
        <StatsCycleScene active={phase.kind === "visual" && phase.index === 1} onNext={nextVisualWithHaptic} />
      </Scene>
      <Scene active={phase.kind === "visual" && phase.index === 2}>
        <ProfileCycleScene active={phase.kind === "visual" && phase.index === 2} onNext={nextVisualWithHaptic} />
      </Scene>
      <Scene active={phase.kind === "syncing"}>
        <SyncingScene />
      </Scene>
      <Scene active={phase.kind === "consent"}>
        <ConsentGate onState={onState} />
      </Scene>
      <Scene active={phase.kind === "language"}>
        <LanguageGate onState={onState} selected={remoteUser?.language ?? null} />
      </Scene>
      <Scene active={phase.kind === "email"}>
        <EmailGate
          defaultEmail={remoteUser?.email ?? ""}
          onOtp={(email) => setPhase({ kind: "otp", email })}
          onState={onState}
        />
      </Scene>
      <Scene active={phase.kind === "otp"}>
        {phase.kind === "otp" ? <OtpGate email={phase.email} onState={onState} /> : null}
      </Scene>
      <Scene active={phase.kind === "loading"}>
        <HandoffLoading
          active={phase.kind === "loading"}
          flowToken={flowToken}
          onDone={() => setPhase({ kind: "done" })}
        />
      </Scene>
      <Scene active={phase.kind === "done"}>
        <DoneScene />
      </Scene>
    </div>
  );
}

function Scene(props: { active: boolean; children: ReactNode }): ReactElement {
  return <section className={`scene-stage ${props.active ? "is-active" : ""}`}>{props.children}</section>;
}

function TopChrome(props: { onBack: () => void }): ReactElement {
  return (
    <header className="top-app-bar bg-transparent text-zinc-100 font-inter text-sm tracking-widest uppercase docked full-width top-0 border-none flat no shadows">
      <button aria-label="Go back" className="chrome-button flex items-center justify-center w-10 h-10 rounded-full hover:bg-surface-variant transition-colors group" onClick={props.onBack}>
        <span className="material-symbols-outlined text-zinc-100 group-hover:text-purple-400 transition-colors duration-300">arrow_back</span>
      </button>
      <div className="text-xl font-bold text-white tracking-tighter" />
      <span className="chrome-spacer" aria-hidden="true" />
    </header>
  );
}

function HookScene(props: { active: boolean; onNext: () => void }): ReactElement {
  useEffect(() => {
    if (!props.active) return;
    const timer = window.setTimeout(props.onNext, HOOK_AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [props.active, props.onNext]);

  return (
    <main className="hook-main w-full max-w-md mx-auto h-[884px] flex flex-col items-center justify-center px-8 relative overflow-hidden">
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-20">
        <div className="hook-glow w-64 h-64 bg-primary rounded-full blur-[100px]" />
      </div>
      <h1 className="hook-title font-headline-lg text-headline-lg text-primary text-center tracking-tight drop-shadow-[0_0_15px_rgba(255,255,255,0.2)] relative z-10">
        Сколько стоит найти отношения в 2026 году?
      </h1>
    </main>
  );
}

function useTimedCycle(active: boolean, length: number): { index: number; canContinue: boolean } {
  const [index, setIndex] = useState(0);
  const [canContinue, setCanContinue] = useState(false);

  useEffect(() => {
    if (!active) {
      setIndex(0);
      setCanContinue(false);
      return;
    }

    setIndex(0);
    setCanContinue(false);
    const timer = window.setInterval(() => {
      setIndex((current) => {
        const next = (current + 1) % length;
        if (next === 0) setCanContinue(true);
        return next;
      });
    }, DRUM_CYCLE_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [active, length]);

  return { index, canContinue };
}

function ProfileCycleScene(props: {
  active: boolean;
  onNext: () => void;
}): ReactElement {
  const cycle = useTimedCycle(props.active, EXHAUSTION_LINES.length);
  const copy = EXHAUSTION_LINES[cycle.index] ?? EXHAUSTION_LINES[0]!;

  return (
    <>
      <main className="exhaustion-main">
        <div className="lavender-glow" />
        <ProfileMockup />
        <div className="exhaustion-copy exhaustion-drum">
          <div key={copy} className="drum-window profile-drum-window">
            <p key={copy} className="copy-headline drum-copy-item">
              {copy}
            </p>
          </div>
          <CycleDots total={EXHAUSTION_LINES.length} active={cycle.index} complete={cycle.canContinue} />
        </div>
      </main>
      {cycle.canContinue ? <BottomCta onClick={props.onNext} label="Дальше" /> : null}
    </>
  );
}

function StatsCycleScene(props: {
  active: boolean;
  onNext: () => void;
}): ReactElement {
  const cycle = useTimedCycle(props.active, STAT_COPY.length);
  const copy = STAT_COPY[cycle.index] ?? STAT_COPY[0]!;

  return (
    <div className="trap-body">
      <div className="trap-bg" aria-hidden="true">
        <img alt="" className="trap-bg-image" src={TRAP_BACKGROUND} />
      </div>
      <main className="trap-main">
        <div className="stats-native-panel">
          <div className="stat-wrap stat-drum-wrap">
            <div key={`${copy.value}-${copy.label}`} className="drum-window stat-drum-window">
              <h1 className={`stat-value ${copy.valueSmall ? "small" : ""}`}>
                <CountUpText value={copy.value} />
              </h1>
              <h2 className={`stat-label ${copy.labelSentence ? "sentence" : ""}`}>
                {copy.label}
              </h2>
            </div>
          </div>
        </div>
      </main>
      <div className={`stats-dots-dock ${cycle.canContinue ? "with-cta" : ""}`}>
        <CycleDots total={STAT_COPY.length} active={cycle.index} complete={cycle.canContinue} />
      </div>
      {cycle.canContinue ? <BottomCta onClick={props.onNext} label="Дальше" /> : null}
    </div>
  );
}

function CycleDots(props: { total: number; active: number; complete: boolean }): ReactElement {
  return (
    <div className={`cycle-dots ${props.complete ? "is-complete" : ""}`} aria-hidden="true">
      {Array.from({ length: props.total }, (_, index) => (
        <span key={index} className={index === props.active ? "is-active" : ""} />
      ))}
    </div>
  );
}

function ProfileMockup(): ReactElement {
  return (
    <div className="profile-card relative w-64 aspect-[3/4] mb-12 -rotate-12 transition-transform duration-500 ease-out glow-lavender rounded-xl border border-white/10 bg-surface-container-high/40 backdrop-blur-md overflow-hidden shadow-2xl">
      <img
        alt="High-end serious portrait of a young professional male in dramatic lighting against a dark background"
        className="profile-card-image w-full h-full object-cover opacity-80 mix-blend-luminosity"
        src={PROFILE_IMAGE}
      />
      <div className="profile-card-gradient absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
      <div className="profile-card-actions absolute bottom-20 left-0 right-0 px-4 flex justify-between items-center z-30">
        <MockAction icon="undo" tone="yellow" small />
        <MockAction icon="close" tone="red" />
        <MockAction icon="star" tone="blue" small />
        <MockAction icon="favorite" tone="green" />
        <MockAction icon="bolt" tone="purple" small />
      </div>
      <div className="profile-card-caption absolute bottom-4 left-4 right-4 flex justify-between items-end">
        <div>
          <h2 className="font-title-lg text-title-lg text-white">Александр, 28</h2>
          <p className="font-body-md text-body-md text-on-surface-variant">Founder Tech</p>
        </div>
      </div>
    </div>
  );
}

function MockAction(props: { icon: string; tone: "yellow" | "red" | "blue" | "green" | "purple"; small?: boolean }): ReactElement {
  return (
    <button
      className={`mock-action ${props.small ? "mock-action-small" : "mock-action-large"} mock-action-${props.tone}`}
      type="button"
      aria-hidden="true"
      tabIndex={-1}
    >
      <span className="material-symbols-outlined">{props.icon}</span>
    </button>
  );
}

function BottomCta(props: { onClick: () => void; label: string; disabled?: boolean }): ReactElement {
  return (
    <div className="bottom-cta fixed bottom-0 w-full p-margin bg-gradient-to-t from-black via-black/80 to-transparent z-20 flex justify-center pb-xl">
      <button
        className="pill-cta bg-primary text-on-primary font-label-md text-label-md uppercase tracking-wider px-12 py-4 rounded-full shadow-[0_0_20px_rgba(168,85,247,0.2)] hover:bg-secondary transition-all duration-300 transform hover:scale-105 active:scale-95 font-bold"
        disabled={props.disabled}
        onClick={props.onClick}
      >
        {props.label}
      </button>
    </div>
  );
}

function CountUpText(props: { value: string }): ReactElement {
  const parsed = parseCountValue(props.value);
  const [display, setDisplay] = useState(() => formatCountValue(parsed, 1));

  useEffect(() => {
    const durationMs = 1250;
    const startedAt = performance.now();
    let frame = 0;

    function tick(now: number): void {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const eased = easeOutQuint(progress);
      const current = Math.round(1 + (parsed.target - 1) * eased);
      setDisplay(formatCountValue(parsed, current));
      if (progress < 1) {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      setDisplay(formatCountValue(parsed, parsed.target));
    }

    setDisplay(formatCountValue(parsed, 1));
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [props.value]);

  return <>{display}</>;
}

interface ParsedCountValue {
  prefix: string;
  suffix: string;
  target: number;
}

function parseCountValue(value: string): ParsedCountValue {
  const match = value.match(/\d+/);
  if (!match) return { prefix: "", suffix: "", target: 1 };
  const target = Math.max(1, Number.parseInt(match[0], 10));
  return {
    prefix: value.slice(0, match.index),
    suffix: value.slice((match.index ?? 0) + match[0].length),
    target,
  };
}

function formatCountValue(parsed: ParsedCountValue, value: number): string {
  return `${parsed.prefix}${Math.min(parsed.target, Math.max(1, value))}${parsed.suffix}`;
}

function easeOutQuint(progress: number): number {
  return 1 - (1 - progress) ** 5;
}

function ConsentGate(props: { onState: (state: TelegramOnboardingState) => void }): ReactElement {
  const [terms, setTerms] = useState(false);
  const [research, setResearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!app?.initData || busy) return;
    setBusy(true);
    setError(null);
    try {
      const state = await acceptTelegramOnboardingConsent(app.initData, research);
      app.HapticFeedback?.notificationOccurred("success");
      props.onState(state);
    } catch (err) {
      setError(errorCopy(err));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <GateShell>
      <h1>Сначала короткая формальность</h1>
      <p>Gennety подбирает людей по глубокому контексту, поэтому нам нужно явное согласие перед продолжением.</p>
      {error ? <div className="gate-error">{error}</div> : null}
      <label className="check-row">
        <input type="checkbox" checked={terms} onChange={(event) => setTerms(event.currentTarget.checked)} />
        <span>Я принимаю условия сервиса и политику приватности.</span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={research} onChange={(event) => setResearch(event.currentTarget.checked)} />
        <span>Можно использовать мои обезличенные данные для улучшения матчмейкинга.</span>
      </label>
      <button className="gate-button" disabled={!terms || busy || !app?.initData} onClick={() => void submit()}>
        {busy ? "Сохраняю..." : "Продолжить"}
      </button>
    </GateShell>
  );
}

function LanguageGate(props: {
  selected: OnboardingLanguage | null;
  onState: (state: TelegramOnboardingState) => void;
}): ReactElement {
  const [busy, setBusy] = useState<OnboardingLanguage | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(language: OnboardingLanguage): Promise<void> {
    if (!app?.initData || busy) return;
    setBusy(language);
    setError(null);
    try {
      const state = await setTelegramOnboardingLanguage(app.initData, language);
      app.HapticFeedback?.selectionChanged();
      props.onState(state);
    } catch (err) {
      setError(errorCopy(err));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <GateShell>
      <h1>Выбери язык</h1>
      <p>Дальше бот продолжит разговор на выбранном языке.</p>
      {error ? <div className="gate-error">{error}</div> : null}
      <div className="choice-row">
        {LANGUAGE_OPTIONS.map((option) => (
          <button
            key={option.value}
            className={`choice-button ${props.selected === option.value ? "is-selected" : ""}`}
            disabled={busy !== null || !app?.initData}
            onClick={() => void choose(option.value)}
          >
            <span>
              <strong>{option.label}</strong>
              <br />
              <small>{busy === option.value ? "Сохраняю..." : option.sub}</small>
            </span>
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        ))}
      </div>
    </GateShell>
  );
}

function EmailGate(props: {
  defaultEmail: string;
  onOtp: (email: string) => void;
  onState: (state: TelegramOnboardingState) => void;
}): ReactElement {
  const [email, setEmail] = useState(props.defaultEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!app?.initData || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await requestTelegramOnboardingOtp(app.initData, email);
      app.HapticFeedback?.notificationOccurred("success");
      if (result.alreadyVerified) {
        const state = await fetchTelegramOnboardingState(app.initData, source);
        props.onState(state);
        return;
      }
      props.onOtp(email.trim().toLowerCase());
    } catch (err) {
      setError(errorCopy(err));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <GateShell>
      <h1>Университетская почта</h1>
      <p>Это обязательный фильтр Gennety: пары подбираются внутри реального студенческого контекста.</p>
      {error ? <div className="gate-error">{error}</div> : null}
      <div className="gate-stack">
        <input
          className="gate-input"
          inputMode="email"
          autoCapitalize="none"
          autoComplete="email"
          placeholder="name@university.edu"
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
        />
        <button className="gate-button" disabled={!email.trim() || busy || !app?.initData} onClick={() => void submit()}>
          {busy ? "Отправляю..." : "Получить код"}
        </button>
      </div>
      <div className="gate-meta">Если ты уже подтвердил почту на сайте, этот экран будет пропущен.</div>
    </GateShell>
  );
}

function OtpGate(props: {
  email: string;
  onState: (state: TelegramOnboardingState) => void;
}): ReactElement {
  const [digits, setDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const code = digits.join("");

  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  function setAt(index: number, value: string): void {
    const clean = value.replace(/\D/g, "").slice(-1);
    setDigits((current) => {
      const next = [...current];
      next[index] = clean;
      return next;
    });
    if (clean && index < 5) refs.current[index + 1]?.focus();
  }

  function paste(value: string): void {
    const clean = value.replace(/\D/g, "").slice(0, 6);
    if (!clean) return;
    setDigits(Array.from({ length: 6 }, (_, index) => clean[index] ?? ""));
    refs.current[Math.min(clean.length, 5)]?.focus();
  }

  async function submit(): Promise<void> {
    if (!app?.initData || busy || code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const state = await verifyTelegramOnboardingOtp(app.initData, code);
      app.HapticFeedback?.notificationOccurred("success");
      props.onState(state);
    } catch (err) {
      setError(errorCopy(err));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <GateShell>
      <h1>Код из письма</h1>
      <p>Мы отправили 6-значный код на {props.email}. Он живёт недолго.</p>
      {error ? <div className="gate-error">{error}</div> : null}
      <div className="otp-grid">
        {digits.map((digit, index) => (
          <input
            key={index}
            ref={(node) => {
              refs.current[index] = node;
            }}
            className="otp-box"
            inputMode="numeric"
            autoComplete={index === 0 ? "one-time-code" : "off"}
            value={digit}
            onChange={(event) => setAt(index, event.currentTarget.value)}
            onPaste={(event) => {
              event.preventDefault();
              paste(event.clipboardData.getData("text"));
            }}
            onKeyDown={(event) => {
              if (event.key === "Backspace" && !digits[index] && index > 0) refs.current[index - 1]?.focus();
              if (event.key === "Enter") void submit();
            }}
            maxLength={1}
            aria-label={`OTP digit ${index + 1}`}
          />
        ))}
      </div>
      <button className="gate-button" disabled={code.length !== 6 || busy || !app?.initData} onClick={() => void submit()}>
        {busy ? "Проверяю..." : "Подтвердить"}
      </button>
    </GateShell>
  );
}

function HandoffLoading(props: {
  active: boolean;
  flowToken: string | null;
  onDone: () => void;
}): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const onDoneRef = useRef(props.onDone);

  useEffect(() => {
    onDoneRef.current = props.onDone;
  }, [props.onDone]);

  useEffect(() => {
    if (!props.active) return;
    if (!app?.initData) return;
    if (!props.flowToken) {
      setError("Сессия Mini App не синхронизирована. Открой вход из чата ещё раз.");
      return;
    }
    const delay = new Promise<void>((resolve) => window.setTimeout(resolve, 6000));
    const post = completeTelegramOnboardingGate(app.initData, props.flowToken);
    void Promise.all([delay, post])
      .then(([, result]) => {
        if (!result.botTookOver && !result.completed) {
          setError("Бот пока не смог продолжить. Попробуй ещё раз.");
          return;
        }
        setComplete(true);
        app.HapticFeedback?.notificationOccurred("success");
        window.setTimeout(() => {
          onDoneRef.current();
        }, 900);
      })
      .catch((err: unknown) => {
        setError(errorCopy(err));
        app.HapticFeedback?.notificationOccurred("error");
      });
  }, [attempt, props.active, props.flowToken]);

  return (
    <div className="orb-wrap">
      <div>
        <div className="loading-orb" />
        <h1>{complete ? "Бот уже ждёт тебя" : "Передаю контекст боту"}</h1>
        <p>{error ?? "Сейчас Gennety продолжит в чате, без лишних экранов."}</p>
        {error ? (
          <button
            className="gate-button"
            style={{ marginTop: 20 }}
            onClick={() => {
              setError(null);
              setAttempt((current) => current + 1);
            }}
          >
            Попробовать ещё раз
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DoneScene(): ReactElement {
  return (
    <div className="orb-wrap">
      <div>
        <div className="loading-orb" />
        <h1>Готово</h1>
        <p>Бот уже продолжил онбординг в чате. Закрой Mini App, когда будешь готов.</p>
        <button className="gate-button done-close-button" onClick={() => app?.close()}>
          Вернуться в чат
        </button>
      </div>
    </div>
  );
}

function SyncingScene(): ReactElement {
  return (
    <div className="orb-wrap">
      <div>
        <div className="loading-orb syncing-orb" />
        <h1>Синхронизирую</h1>
        <p>Проверяю состояние онбординга перед следующим шагом.</p>
      </div>
    </div>
  );
}

function GateShell(props: { children: ReactNode }): ReactElement {
  return (
    <main className="gate-main">
      <div className="lavender-glow" />
      <section className="gate-card">{props.children}</section>
    </main>
  );
}

function errorCopy(err: unknown): string {
  if (err instanceof CalendarApiError) {
    switch (err.reason) {
      case "Invalid university email":
      case "invalid-email":
        return "Нужна корпоративная или университетская почта.";
      case "email-linked-to-other-account":
        return "Эта почта уже привязана к другому Telegram аккаунту.";
      case "mismatch":
        return "Код не совпал. Проверь письмо и попробуй ещё раз.";
      case "expired":
        return "Код истёк. Вернись назад и запроси новый.";
      case "exhausted":
        return "Слишком много попыток. Запроси новый код.";
      case "terms-required":
        return "Сначала нужно принять условия.";
      case "language-required":
        return "Сначала выбери язык.";
      case "email-required":
        return "Сначала подтверди университетскую почту.";
      case "Invalid initData":
      case "Missing tma initData":
      case "Empty initData":
        return "Открой мини-приложение из чата с ботом, чтобы продолжить.";
      default:
        return err.reason ?? err.message;
    }
  }
  return err instanceof Error ? err.message : "Что-то пошло не так. Попробуй ещё раз.";
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
