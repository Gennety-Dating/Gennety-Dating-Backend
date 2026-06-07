import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  acceptTelegramOnboardingConsent,
  completeTelegramOnboardingGate,
  fetchTelegramOnboardingState,
  requestTelegramOnboardingOtp,
  resolveTelegramOnboardingCity,
  searchTelegramOnboardingCities,
  selectTelegramOnboardingCity,
  setTelegramOnboardingAiMemoryPreference,
  setTelegramOnboardingLanguage,
  verifyTelegramOnboardingOtp,
  CalendarApiError,
  type AiMemoryExportPreference,
  type EmailVerificationState,
  type OnboardingLanguage,
  type TelegramCityHit,
  type TelegramOnboardingState,
} from "./api.js";
import {
  postVisualPhaseFromRemote,
  preVisualPhaseFromRemote,
  type OnboardingPhase,
} from "./onboarding-route.js";
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
const DRUM_CYCLE_INTERVAL_MS = 2500;
const PRIVACY_POLICY_URL = "https://gennety.com/privacy";

type RemoteUser = TelegramOnboardingState["user"];

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
  const [phase, setPhase] = useState<OnboardingPhase>({ kind: "syncing" });
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
      if (current.kind === "city") return { kind: "email" };
      if (current.kind === "aiMemoryExport") return { kind: "visual", index: VISUAL_LAST_INDEX };
      return current;
    });
  }, [remoteUser]);

  const canGoBack =
    phase.kind === "visual"
      ? phase.index > 0
      : phase.kind === "language" ||
        phase.kind === "email" ||
        phase.kind === "otp" ||
        phase.kind === "city" ||
        phase.kind === "aiMemoryExport";

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
          onOtp={(email, emailVerification) =>
            setPhase({
              kind: "otp",
              email,
              expiresAt: emailVerification?.expiresAt ?? null,
              resendAvailableAt: emailVerification?.resendAvailableAt ?? null,
            })
          }
          onState={onState}
        />
      </Scene>
      <Scene active={phase.kind === "otp"}>
        {phase.kind === "otp" ? (
          <OtpGate
            email={phase.email}
            expiresAt={phase.expiresAt}
            resendAvailableAt={phase.resendAvailableAt}
            onState={onState}
            onChangeEmail={() => setPhase({ kind: "email" })}
            onChallengeChanged={(emailVerification) =>
              setPhase({
                kind: "otp",
                email: phase.email,
                expiresAt: emailVerification.expiresAt,
                resendAvailableAt: emailVerification.resendAvailableAt,
              })
            }
          />
        ) : null}
      </Scene>
      <Scene active={phase.kind === "city"}>
        <CityGate onState={onState} />
      </Scene>
      <Scene active={phase.kind === "aiMemoryExport"}>
        <AiMemoryExportGate
          onSaved={(state) => {
            setRemoteUser(state.user);
            setFlowToken(state.flowToken);
            setPhase({ kind: "loading" });
          }}
        />
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
        <span>
          Я принимаю условия сервиса и{" "}
          <a className="gate-link" href={PRIVACY_POLICY_URL} rel="noreferrer" target="_blank">
            политику приватности
          </a>
          .
        </span>
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
  onOtp: (email: string, emailVerification?: EmailVerificationState) => void;
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
      props.onOtp(email.trim().toLowerCase(), result.emailVerification);
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
  expiresAt: string | null;
  resendAvailableAt: string | null;
  onState: (state: TelegramOnboardingState) => void;
  onChangeEmail: () => void;
  onChallengeChanged: (state: EmailVerificationState) => void;
}): ReactElement {
  const [digits, setDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [busy, setBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const code = digits.join("");
  const resendAt = props.resendAvailableAt ? Date.parse(props.resendAvailableAt) : 0;
  const resendSeconds = Math.max(0, Math.ceil((resendAt - now) / 1000));

  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

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

  async function resend(): Promise<void> {
    if (!app?.initData || resendBusy || resendSeconds > 0) return;
    setResendBusy(true);
    setError(null);
    try {
      const result = await requestTelegramOnboardingOtp(app.initData, props.email);
      if (result.emailVerification) props.onChallengeChanged(result.emailVerification);
      setDigits(["", "", "", "", "", ""]);
      setNow(Date.now());
      refs.current[0]?.focus();
      app.HapticFeedback?.notificationOccurred("success");
    } catch (err) {
      setError(errorCopy(err));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setResendBusy(false);
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
      <div className="otp-actions">
        <button
          className="gate-link"
          disabled={resendBusy || resendSeconds > 0 || !app?.initData}
          onClick={() => void resend()}
        >
          {resendBusy
            ? "Отправляю..."
            : resendSeconds > 0
              ? `Отправить снова через ${resendSeconds} сек.`
              : "Отправить код снова"}
        </button>
        <button className="gate-link" disabled={busy || resendBusy} onClick={props.onChangeEmail}>
          Изменить почту
        </button>
      </div>
    </GateShell>
  );
}

function CityGate(props: { onState: (state: TelegramOnboardingState) => void }): ReactElement {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TelegramCityHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [geoBusy, setGeoBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!app?.initData) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchTelegramOnboardingCities(app.initData, trimmed)
        .then((hits) => {
          setResults(hits);
          setError(null);
        })
        .catch((err: unknown) => {
          setError(errorCopy(err));
          setResults([]);
        })
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function choose(city: TelegramCityHit, allowWhileGeo = false): Promise<void> {
    if (!app?.initData || busy || (geoBusy && !allowWhileGeo)) return;
    setBusy(true);
    setError(null);
    try {
      const state = await selectTelegramOnboardingCity(app.initData, city);
      app.HapticFeedback?.notificationOccurred("success");
      props.onState(state);
    } catch (err) {
      setError(errorCopy(err));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setBusy(false);
    }
  }

  function useCurrentLocation(): void {
    if (!app?.initData || busy || geoBusy) return;
    if (
      typeof navigator === "undefined" ||
      !navigator.geolocation ||
      window.isSecureContext === false
    ) {
      setError("Не получилось открыть геолокацию. Выбери город через поиск.");
      return;
    }

    setGeoBusy(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        void resolveAndChoose(position);
      },
      () => {
        setGeoBusy(false);
        setError("Геолокация недоступна. Выбери город через поиск.");
        app?.HapticFeedback?.notificationOccurred("warning");
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }

  async function resolveAndChoose(position: GeolocationPosition): Promise<void> {
    if (!app?.initData) return;
    try {
      const city = await resolveTelegramOnboardingCity(
        app.initData,
        position.coords.latitude,
        position.coords.longitude,
      );
      setQuery(city.label);
      await choose(city, true);
    } catch (err) {
      setError(errorCopy(err));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setGeoBusy(false);
    }
  }

  return (
    <GateShell>
      <h1>Город для мэтчей</h1>
      <p>Выбери город, где ты сейчас готов ходить на свидания. Мы не сохраняем домашний адрес.</p>
      {error ? <div className="gate-error">{error}</div> : null}
      <div className="gate-stack">
        <button className="choice-button" disabled={busy || geoBusy || !app?.initData} onClick={useCurrentLocation}>
          <span>
            <strong>{geoBusy ? "Определяю город..." : "Определить автоматически"}</strong>
            <br />
            <small>Используем геопозицию только для выбора города</small>
          </span>
          <span className="material-symbols-outlined">my_location</span>
        </button>
        <input
          className="gate-input"
          autoCapitalize="words"
          autoComplete="address-level2"
          placeholder="Kyiv, Lviv, Warsaw..."
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div className="choice-row">
          {results.map((city) => (
            <button
              key={`${city.homeCityKey}:${city.homePlaceId ?? city.label}`}
              className="choice-button"
              disabled={busy || geoBusy || !app?.initData}
              onClick={() => void choose(city)}
            >
              <span>
                <strong>{city.homeCity}</strong>
                <br />
                <small>{city.label}</small>
              </span>
              <span className="material-symbols-outlined">chevron_right</span>
            </button>
          ))}
        </div>
        {searching ? <div className="gate-meta">Ищу город...</div> : null}
      </div>
    </GateShell>
  );
}

function AiMemoryExportGate(props: {
  onSaved: (state: TelegramOnboardingState) => void;
}): ReactElement {
  const [busy, setBusy] = useState<Exclude<AiMemoryExportPreference, "undecided"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(
    preference: Exclude<AiMemoryExportPreference, "undecided">,
  ): Promise<void> {
    if (!app?.initData || busy) return;
    setBusy(preference);
    setError(null);
    try {
      const state = await setTelegramOnboardingAiMemoryPreference(
        app.initData,
        preference,
      );
      app.HapticFeedback?.notificationOccurred("success");
      props.onSaved(state);
    } catch (err) {
      setError(errorCopy(err));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="ai-memory-screen">
      <div className="ai-memory-content">
        <h1>
          Would you like to export your memory from other AI apps to give your AI
          matchmaker more context about you?
        </h1>

        <div className="ai-logo-fan" aria-label="ChatGPT, Claude and Gemini">
          <div className="ai-logo-card ai-logo-card-claude">
            <ClaudeLogo />
          </div>
          <div className="ai-logo-card ai-logo-card-gemini">
            <GeminiLogo />
          </div>
          <div className="ai-logo-card ai-logo-card-openai">
            <OpenAiLogo />
          </div>
        </div>

        {error ? <div className="gate-error ai-memory-error">{error}</div> : null}
      </div>

      <div className="ai-memory-actions">
        <button
          className="ai-memory-primary"
          disabled={busy !== null || !app?.initData}
          onClick={() => void choose("accepted")}
        >
          {busy === "accepted" ? "Connecting..." : "Yes, connect"}
        </button>
        <button
          className="ai-memory-secondary"
          disabled={busy !== null || !app?.initData}
          onClick={() => void choose("declined")}
        >
          {busy === "declined" ? "Saving..." : "Later"}
        </button>
      </div>
    </main>
  );
}

function ClaudeLogo(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Claude">
      <path
        d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
        fill="#d97757"
      />
    </svg>
  );
}

function GeminiLogo(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Gemini">
      <path
        d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
        fill="#3186ff"
      />
      <path
        d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
        fill="url(#gemini-green)"
      />
      <path
        d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
        fill="url(#gemini-red)"
      />
      <path
        d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
        fill="url(#gemini-yellow)"
      />
      <defs>
        <linearGradient
          id="gemini-green"
          gradientUnits="userSpaceOnUse"
          x1="7"
          x2="11"
          y1="15.5"
          y2="12"
        >
          <stop stopColor="#08b962" />
          <stop offset="1" stopColor="#08b962" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id="gemini-red"
          gradientUnits="userSpaceOnUse"
          x1="8"
          x2="11.5"
          y1="5.5"
          y2="11"
        >
          <stop stopColor="#f94543" />
          <stop offset="1" stopColor="#f94543" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id="gemini-yellow"
          gradientUnits="userSpaceOnUse"
          x1="3.5"
          x2="17.5"
          y1="13.5"
          y2="12"
        >
          <stop stopColor="#fabc12" />
          <stop offset=".46" stopColor="#fabc12" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function OpenAiLogo(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="ChatGPT">
      <path
        d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"
        fill="currentColor"
      />
    </svg>
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
        return "Код истёк. Запроси новый код ниже.";
      case "exhausted":
        return "Слишком много попыток. Запроси новый код.";
      case "otp-cooldown":
        return "Новый код уже отправлен. Подожди несколько секунд.";
      case "otp-send-failed":
        return "Не удалось отправить письмо. Попробуй ещё раз.";
      case "terms-required":
        return "Сначала нужно принять условия.";
      case "language-required":
        return "Сначала выбери язык.";
      case "ai-memory-preference-required":
        return "Сначала выбери, хочешь ли подключить память из AI-приложений.";
      case "invalid-ai-memory-preference":
        return "Не получилось сохранить выбор. Попробуй ещё раз.";
      case "email-required":
        return "Сначала подтверди университетскую почту.";
      case "location-required":
        return "Сначала выбери город для мэтчей.";
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
