import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  claimTelegramOnboardingReferralGift,
  setTelegramOnboardingLanguage,
  setTelegramOnboardingTheme,
  setTelegramOnboardingTrack,
  verifyTelegramOnboardingOtp,
  CalendarApiError,
  type AiMemoryExportPreference,
  type EmailVerificationState,
  type OnboardingLanguage,
  type OnboardingTheme,
  type RegistrationTrack,
  type TelegramCityHit,
  type TelegramOnboardingState,
} from "./api.js";
import { reconcileTheme, setTheme } from "./theme.js";
import {
  bootPhaseFromRemote,
  postVisualPhaseFromRemote,
  preVisualPhaseFromRemote,
  VISUAL_DONE,
  VISUAL_LAST_INDEX,
  type OnboardingPhase,
} from "./onboarding-route.js";
import {
  clearOnboardingProgress,
  loadOnboardingProgress,
  saveOnboardingProgress,
} from "./device-storage.js";
import { type Lang } from "./i18n.js";
import {
  initialOnboardingLanguage,
  onboardingStrings,
  type OnboardingStrings,
} from "./onboarding-i18n.js";
import { typewriterLineHoldMs } from "./onboarding-timing.js";
import bumbleIcon from "./app-icons/bumble.png";
import tinderIcon from "./app-icons/tinder.png";
import badooIcon from "./app-icons/badoo.png";
import gennetyIcon from "./brand/gennety-icon.png";
import "./theme.css";
import "./onboarding.css";

const app = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const source = params.get("source") ?? app?.initDataUnsafe?.start_param ?? null;

/**
 * Dev-QA standalone preview of the referral welcome-gift scene. `?preview=referral-gift`
 * routes straight to that scene with mock data and NO Telegram/remote-state
 * requirement, so it can be opened in a plain browser for design review (the
 * scene otherwise sits mid-onboarding behind the initData gate). Harmless in
 * prod: the flag is only set by that explicit query param, and the Continue
 * button still requires real initData to actually claim.
 */
const PREVIEW_REFERRAL_GIFT = params.get("preview") === "referral-gift";

const TRAP_BACKGROUND =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuDT22v5JOFjqN2g1VkI86PnzZJ_vTS3whfVoE4pTqZMVY_zqEjFKQf0fGlab3jjVTIxx1gKK5zx4u10XcEtFiFDqeEsGaLjoNTdZMWbR46RULeC47iOvuiqYHU8PJrKZ9kQVqufAHWY-pv_0RSTu1V7cSz_tLD89uoBf8RE9OxG9ZhXIGcEKvxkjcwB3oa3Kf9KjRlxyoUZcBMol4eX5hJ6Oh2_fhyciV6tYxlSEoexfNp4Pr7iGISmsLdSC0fp35_bW0OO_cj0xmGN";
const DRUM_CYCLE_INTERVAL_MS = 2500; // Stats (screen 1) auto-cycle interval
const PROFILE_CYCLE_INTERVAL_MS = 3000; // Profile (screen 2) text auto-cycle interval
const PROFILE_SWIPE_INTERVAL_MS = 1000; // Profile (screen 2) Tinder-style card swipe cadence

interface ProfileCardData {
  name: string;
  age: number;
  photo: string;
  distanceKm: number;
  bio: string;
  interests: string[];
}

// Demo Tinder-style cards for the Profile scene. Photos live in
// `apps/webapp/public/profiles/` (1.jpg..9.jpg, in this order); a missing
// file degrades gracefully to the dark card background.
//
// Card order is deliberately gender-interleaved as (male, male, female) ×3.
// The deck swipes each card the opposite direction of the last (see
// `ProfileDeck`), so a strictly alternating M/F order would lock every man to
// one direction and every woman to the other. Grouping the men in pairs keeps
// each gender to a run of at most two in a row (holds cyclically as the deck
// loops) and spreads both genders across left and right swipes.
const PROFILE_CARDS: ProfileCardData[] = [
  { name: "Leo", age: 24, photo: "/profiles/1.jpg", distanceKm: 3, bio: "Night-owl builder running on energy drinks", interests: ["Coding", "Gaming", "Techno", "eSports"] },
  { name: "Max", age: 22, photo: "/profiles/2.jpg", distanceKm: 2, bio: "Vinyl crates and midnight drives", interests: ["Indie music", "Vinyl", "Skating", "Film"] },
  { name: "Alina", age: 23, photo: "/profiles/3.jpg", distanceKm: 4, bio: "Pilates in the a.m., wine in the p.m.", interests: ["Pilates", "Fashion", "Travel", "Wine"] },
  { name: "Daniel", age: 25, photo: "/profiles/4.jpg", distanceKm: 1, bio: "Gym rat who actually cooks", interests: ["Gym", "Cooking", "Football", "Beaches"] },
  { name: "Tom", age: 27, photo: "/profiles/5.jpg", distanceKm: 6, bio: "Weekends on the water, always", interests: ["Fishing", "Boating", "BBQ", "Road trips"] },
  { name: "Mia", age: 21, photo: "/profiles/6.jpg", distanceKm: 3, bio: "Golden-hour chaser & playlist maker", interests: ["Photography", "Coffee", "Indie music", "Sunsets"] },
  { name: "Chris", age: 28, photo: "/profiles/7.jpg", distanceKm: 5, bio: "Low-key nights and good coffee", interests: ["Coffee", "Cinema", "Cooking", "Vinyl"] },
  { name: "Sasha", age: 20, photo: "/profiles/8.jpg", distanceKm: 2, bio: "Hoodie weather and lo-fi beats", interests: ["Lo-fi", "Streetwear", "Skating", "Gaming"] },
  { name: "Lena", age: 24, photo: "/profiles/9.jpg", distanceKm: 4, bio: "Loud laughs and cozy sweaters", interests: ["Dancing", "Baking", "Travel", "Dogs"] },
];

// Intro typewriter ("live human typing") timings. Tuned ~2.5x faster than the
// original cinematic pacing while keeping the human cadence and beats.
const INTRO_TYPE_CHAR_MS = 26; // base per-character speed (~30 chars/sec with the jitter below)
const INTRO_TYPE_JITTER_MS = 14; // random extra per character for an organic cadence
const INTRO_PUNCT_PAUSE_MS = 73; // small beat after sentence punctuation
const INTRO_LINE_HOLD_MS = 1500; // Intro (screen 0): hold a completed line before it fades
const PIVOT_LINE_HOLD_MS = 1440; // Pivot (screen 3): unchanged between-line hold
const INTRO_LINE_FADE_MS = 200; // fade-out before the next line types in
const INTRO_FINAL_HOLD_MS = 2040; // hold on the closing hook question (+1s read buffer)
const INTRO_SKIP_HOLD_MS = 600; // hold on the final line when the user taps to skip
// Per-part pre-type pauses, indexed [lineIndex][partIndex]. Single-line
// typewriter screens (waste / burnout / cost-2026 / matchmaker) only need a
// no-op leading pause.
const SINGLE_LINE_PAUSES: number[][] = [[0]];
// Stat-hook screen (after the Stats drum): the "only 3% ..." payload types
// straight through as one line.
const STAT_HOOK_PAUSES: number[][] = [[0]];
// Pivot scene ("we built Gennety") — a short beat before the brand name.
const PIVOT_PART_PAUSES_MS: number[][] = [[0], [0, 160]];
const MATCHMAKER_PART_PAUSES_MS: number[][] = SINGLE_LINE_PAUSES;

// Reveal timings for the two typewriter screens that raise an image once the
// line finishes typing: scene 0 raises the three dating-app icons, scene 6
// (Pivot) raises the Gennety star. `delay` waits after the text lands before
// the image rises; `view` holds it on screen before the scene auto-advances.
// Scene 0 raises the dating-app icon row once the "waste" line lands. The old
// pacing sat on the finished long line for the full 2.2s long-line read buffer
// and *then* waited another 1s before the icons rose — ~3.2s of dead air. Cut
// both: a short breath on the finished line (like the Pivot's PIVOT_FINAL_HOLD_MS)
// plus a brief reveal delay ≈ 0.75s total, so the icons follow the text closely.
const ICON_REVEAL_FINAL_HOLD_MS = 300;
const ICON_REVEAL_DELAY_MS = 450;
const ICON_REVEAL_VIEW_MS = 2400;
const LOGO_RISE_DELAY_MS = 150;
const LOGO_RISE_VIEW_MS = 2200;
// Pivot (scene 6): raise the Gennety logo almost the instant the line lands,
// instead of sitting on the finished "So we built Gennety" text for the full
// read-buffer hold. Just a short breath so it doesn't fire on the last keystroke.
const PIVOT_FINAL_HOLD_MS = 300;
// Matchmaker (scene 7): the copy here is longer, so hold it well past the
// default read buffer (~1.8s more than the standard long-line hold) before it
// advances to How-it-works — the time freed up by the faster logo above is
// spent here, where there's more to read.
const MATCHMAKER_FINAL_HOLD_MS = 4000;

// Competitor app icons (scene 0 arc + stats tray) and the Gennety icon (Pivot).
// Imported as Vite assets so their emitted filenames are content-hashed — a
// changed icon busts the `immutable`-cached URL automatically, instead of
// serving a stale PNG from a fixed `public/` path.
const APP_ICONS: Array<{ key: string; src: string; label: string }> = [
  { key: "bumble", src: bumbleIcon, label: "Bumble" },
  { key: "tinder", src: tinderIcon, label: "Tinder" },
  { key: "badoo", src: badooIcon, label: "Badoo" },
];
const GENNETY_ICON_SRC = gennetyIcon;
const PRIVACY_POLICY_URL = "https://gennety.com/privacy";
const TERMS_OF_SERVICE_URL = "https://gennety.com/terms";

type RemoteUser = TelegramOnboardingState["user"];

interface StatCopy {
  value: string;
  label: string;
  valueSmall?: boolean;
  labelSentence?: boolean;
}

const LANGUAGE_OPTIONS: Array<{ value: OnboardingLanguage; label: string; sub: string }> = [
  { value: "en", label: "English", sub: "Continue in English" },
  { value: "ru", label: "Русский", sub: "Продолжить на русском" },
  { value: "uk", label: "Українська", sub: "Продовжити українською" },
  { value: "de", label: "Deutsch", sub: "Auf Deutsch fortfahren" },
  { value: "pl", label: "Polski", sub: "Kontynuuj po polsku" },
];

const OnboardingI18nContext = createContext<OnboardingStrings>(onboardingStrings("en"));

function useOnboardingStrings(): OnboardingStrings {
  return useContext(OnboardingI18nContext);
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
  const [lang, setLang] = useState<Lang>(() =>
    initialOnboardingLanguage(params.get("lang"), app?.initDataUnsafe?.user?.language_code),
  );
  const [phase, setPhase] = useState<OnboardingPhase>({ kind: "syncing" });
  const [remoteUser, setRemoteUser] = useState<RemoteUser | null>(null);
  const [flowToken, setFlowToken] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  // Pivot → Matchmaker: the Gennety logo lives in a persistent overlay ABOVE
  // the scene stack (not inside either scene), so it stays put while the copy
  // crossfades from "So we built Gennety" to the matchmaker line, then fades
  // out on the way to "How it works". The Pivot scene's reveal cue flips this
  // true once its line has landed.
  const [logoRisen, setLogoRisen] = useState(false);
  // Stable per language: the typewriter scenes key their run on the `lines`
  // array identity, so a mid-scene parent re-render (e.g. the logo rising)
  // must not hand them a fresh object and restart the typing.
  const strings = useMemo(() => onboardingStrings(lang), [lang]);

  useEffect(() => {
    document.documentElement?.setAttribute("lang", lang);
  }, [lang]);

  // Warm the competitor icons during the boot round-trip (the reveal DOM only
  // mounts once /state resolves, so this buys scene 0 a real head start).
  // `img.src =` alone only starts the fetch, so decode() is what actually leaves
  // a paintable bitmap in the cache. This is a head start, not the guarantee —
  // AppIcon gates each icon on its own decode, so a preload that loses the race
  // just delays an icon instead of flashing a half-decoded slab.
  useEffect(() => {
    for (const icon of APP_ICONS) {
      const img = new Image();
      img.src = icon.src;
      void img.decode().catch(() => {
        // Warming is best-effort; AppIcon's own gate is what the reveal waits on.
      });
    }
  }, []);

  useEffect(() => {
    configureTelegramChrome();
    // Standalone visual preview — no Telegram, no remote state (see the flag's doc).
    if (PREVIEW_REFERRAL_GIFT) {
      setRemoteUser({ referrerFirstName: "Anna", referralGiftMonths: 1 } as unknown as RemoteUser);
      setPhase({ kind: "referralGift" });
      return;
    }
    if (!app?.initData) {
      setBootError(strings.errors["Missing tma initData"] ?? strings.genericError);
      return;
    }
    void fetchTelegramOnboardingState(app.initData, source)
      .then(async (state) => {
        // Resume the client-only visual animation where the user left off
        // (server state is authoritative for everything up to the city gate).
        // Loaded before the state setters so user + phase batch into one
        // render — otherwise the syncing-fallback effect could briefly route
        // the animation back to scene 0.
        const storedProgress = await loadOnboardingProgress();
        reconcileTheme(state.user.theme);
        setRemoteUser(state.user);
        setFlowToken(state.flowToken);
        if (state.user.language) setLang(state.user.language);
        // Dev-QA override: `?preview=referral-gift` jumps straight to the
        // referral welcome-gift screen for visual review (harmless in prod — the
        // Claim button hits the real, idempotent endpoint and then routes on).
        if (new URLSearchParams(location.search).get("preview") === "referral-gift") {
          setPhase({ kind: "referralGift" });
        } else {
          setPhase(bootPhaseFromRemote(state.user, storedProgress));
        }
      })
      .catch((err: unknown) => {
        setBootError(errorCopy(err, onboardingStrings(lang)));
        app?.HapticFeedback?.notificationOccurred("error");
      });
  }, []);

  // Keyboard-aware viewport. Telegram's WebView (notably iOS) floats the
  // on-screen keyboard over the page without shrinking the layout viewport,
  // so a vertically centered gate card — and the city search results below
  // its input — end up hidden behind the keyboard. `visualViewport` reports
  // the real visible height; we mirror the keyboard's height into the
  // `--kb-height` custom property so the gates can shrink their centered area
  // and scroll region to stay above it. No-ops on clients without
  // `visualViewport`, where `--kb-height` stays 0 and layout is unchanged.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = (): void => {
      const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty("--kb-height", `${Math.round(keyboard)}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
    };
  }, []);

  // Log every screen transition so a re-entry resumes on the same scene.
  // Visual scenes persist their index; finishing the animation persists the
  // VISUAL_DONE sentinel; reaching any pre-animation gate clears the stored
  // value (self-heals a stale value from a previous / reset onboarding run).
  useEffect(() => {
    if (phase.kind === "visual") {
      void saveOnboardingProgress(phase.index);
    } else if (
      phase.kind === "detail" ||
      phase.kind === "referralGift" ||
      phase.kind === "aiMemoryExport" ||
      phase.kind === "loading" ||
      phase.kind === "done"
    ) {
      void saveOnboardingProgress(VISUAL_DONE);
    } else if (
      phase.kind === "consent" ||
      phase.kind === "language" ||
      phase.kind === "path" ||
      phase.kind === "email" ||
      phase.kind === "otp" ||
      phase.kind === "phone" ||
      phase.kind === "city" ||
      phase.kind === "theme"
    ) {
      void clearOnboardingProgress();
    }
  }, [phase]);

  const goBack = useCallback(() => {
    setPhase((current) => {
      if (current.kind === "visual" && current.index > 0) {
        return { kind: "visual", index: current.index - 1 };
      }
      if (current.kind === "visual" && current.index === 0) {
        return { kind: "theme" };
      }
      if (current.kind === "theme") return { kind: "city" };
      if (current.kind === "detail" && current.index > 0) {
        return { kind: "detail", index: current.index - 1 };
      }
      if (current.kind === "detail" && current.index === 0) {
        return { kind: "visual", index: VISUAL_LAST_INDEX };
      }
      if (current.kind === "consent") return { kind: "language" };
      // Registration v2: with the fork live, contact gates back out to the
      // path chooser; without it (legacy) email backs out to consent as before.
      if (current.kind === "path") return { kind: "consent" };
      if (current.kind === "email") {
        return remoteUser?.phoneAuthEnabled ? { kind: "path" } : { kind: "consent" };
      }
      if (current.kind === "otp") return { kind: "email" };
      if (current.kind === "phone") return { kind: "path" };
      if (current.kind === "city") {
        return remoteUser?.phoneAuthEnabled && remoteUser?.registrationTrack === "general"
          ? { kind: "phone" }
          : { kind: "email" };
      }
      if (current.kind === "aiMemoryExport") return { kind: "visual", index: VISUAL_LAST_INDEX };
      return current;
    });
  }, [remoteUser]);

  const canGoBack =
    phase.kind === "visual"
      ? // How-it-works (last visual scene) carries its own in-dock back arrow
        // that pages its sub-steps, so the global top-left chrome arrow is
        // suppressed there to keep the photo frame clean.
        phase.index > 0 && phase.index !== VISUAL_LAST_INDEX
      : phase.kind === "consent" ||
        phase.kind === "path" ||
        phase.kind === "email" ||
        phase.kind === "otp" ||
        phase.kind === "phone" ||
        phase.kind === "city" ||
        phase.kind === "theme" ||
        phase.kind === "aiMemoryExport" ||
        phase.kind === "detail";

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
      reconcileTheme(state.user.theme);
      setRemoteUser(state.user);
      setFlowToken(state.flowToken);
      if (state.user.language) setLang(state.user.language);
      routeFromRemote(state.user);
    },
    [routeFromRemote],
  );

  useEffect(() => {
    if (phase.kind === "syncing" && remoteUser) {
      routeFromRemote(remoteUser);
    }
  }, [phase.kind, remoteUser, routeFromRemote]);

  // Re-arm the logo each time the Pivot scene (index 6) is (re)entered so paging
  // back replays the rise; the Pivot reveal cue sets it true again after the
  // line lands, and it stays true across the Matchmaker scene (index 7).
  useEffect(() => {
    if (phase.kind === "visual" && phase.index === 6) setLogoRisen(false);
  }, [phase]);

  const chrome = canGoBack ? <TopChrome onBack={goBack} /> : null;

  return (
    <OnboardingI18nContext.Provider value={strings}>
      <div className="onboarding-shell bg-surface text-on-surface min-h-screen antialiased">
      {chrome}
      {bootError ? <div className="gate-meta" style={{ position: "fixed", top: 12, left: 20, right: 20, zIndex: 60 }}>{bootError}</div> : null}
      <Scene active={phase.kind === "visual" && phase.index === 0}>
        <TypewriterScene
          active={phase.kind === "visual" && phase.index === 0}
          lines={strings.wasteLines}
          pauses={SINGLE_LINE_PAUSES}
          onNext={nextVisualSilently}
          finalHoldMs={ICON_REVEAL_FINAL_HOLD_MS}
          reveal={<AppIconRow variant="reveal" />}
          revealDelayMs={ICON_REVEAL_DELAY_MS}
          revealViewMs={ICON_REVEAL_VIEW_MS}
        />
      </Scene>
      <Scene active={phase.kind === "visual" && phase.index === 1}>
        <TypewriterScene
          active={phase.kind === "visual" && phase.index === 1}
          lines={strings.burnoutLines}
          pauses={SINGLE_LINE_PAUSES}
          onNext={nextVisualSilently}
        />
      </Scene>
      <Scene active={phase.kind === "visual" && phase.index === 2}>
        <TypewriterScene
          active={phase.kind === "visual" && phase.index === 2}
          lines={strings.cost2026Lines}
          pauses={SINGLE_LINE_PAUSES}
          onNext={nextVisualSilently}
        />
      </Scene>
      <Scene active={phase.kind === "visual" && phase.index === 3}>
        <StatsCycleScene active={phase.kind === "visual" && phase.index === 3} onNext={nextVisualWithHaptic} />
      </Scene>
      <Scene active={phase.kind === "visual" && phase.index === 4}>
        <TypewriterScene
          active={phase.kind === "visual" && phase.index === 4}
          lines={strings.statHookLines}
          pauses={STAT_HOOK_PAUSES}
          onNext={nextVisualSilently}
        />
      </Scene>
      <Scene active={phase.kind === "visual" && phase.index === 5}>
        <ProfileCycleScene active={phase.kind === "visual" && phase.index === 5} onNext={nextVisualWithHaptic} />
      </Scene>
      <Scene active={phase.kind === "visual" && phase.index === 6}>
        <TypewriterScene
          active={phase.kind === "visual" && phase.index === 6}
          lines={strings.pivotLines}
          pauses={PIVOT_PART_PAUSES_MS}
          lineHoldMs={PIVOT_LINE_HOLD_MS}
          finalHoldMs={PIVOT_FINAL_HOLD_MS}
          onNext={nextVisualSilently}
          // The logo itself is the persistent overlay below; this invisible cue
          // just reuses the reveal timing to rise it once the line has landed.
          reveal={<span className="pivot-reveal-cue" aria-hidden="true" />}
          revealDelayMs={LOGO_RISE_DELAY_MS}
          revealViewMs={LOGO_RISE_VIEW_MS}
          onReveal={() => setLogoRisen(true)}
        />
      </Scene>
      <Scene active={phase.kind === "visual" && phase.index === 7}>
        <TypewriterScene
          active={phase.kind === "visual" && phase.index === 7}
          lines={strings.matchmakerLines}
          pauses={MATCHMAKER_PART_PAUSES_MS}
          finalHoldMs={MATCHMAKER_FINAL_HOLD_MS}
          onNext={nextVisualSilently}
          // Sits a touch lower than centre so the persistent logo above it has
          // clear room.
          mainClassName="hook-main--lower"
        />
      </Scene>
      <Scene active={phase.kind === "visual" && phase.index === 8}>
        <HowItWorksScene
          active={phase.kind === "visual" && phase.index === 8}
          onMore={() => setPhase({ kind: "detail", index: 0 })}
        />
      </Scene>
      <Scene active={phase.kind === "detail"}>
        <DateFlowScene
          index={phase.kind === "detail" ? phase.index : 0}
          onBack={goBack}
          onNext={() =>
            setPhase((current) =>
              current.kind === "detail"
                ? { kind: "detail", index: current.index + 1 }
                : current,
            )
          }
          onDone={() => setPhase(postVisualPhaseFromRemote(remoteUser))}
        />
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
      <Scene active={phase.kind === "path"}>
        <PathGate onState={onState} selected={remoteUser?.registrationTrack ?? null} />
      </Scene>
      <Scene active={phase.kind === "phone"}>
        <PhoneGate onState={onState} />
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
      <Scene active={phase.kind === "theme"}>
        <ThemeGate selected={remoteUser?.theme ?? "dark"} onState={onState} />
      </Scene>
      <Scene active={phase.kind === "referralGift"}>
        <ReferralGiftGate
          months={remoteUser?.referralGiftMonths ?? 1}
          referrerName={remoteUser?.referrerFirstName ?? null}
          onClaimed={(state) => {
            setRemoteUser(state.user);
            setFlowToken(state.flowToken);
            setPhase(postVisualPhaseFromRemote(state.user));
          }}
        />
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
      {phase.kind === "visual" ? (
        <div
          className={`pivot-logo ${phase.index === 6 || phase.index === 7 ? (logoRisen ? "is-risen" : "") : ""}`}
          aria-hidden="true"
        >
          <span className="pivot-logo-slot">
            <img
              className="pivot-logo-icon"
              src={GENNETY_ICON_SRC}
              alt=""
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          </span>
        </div>
      ) : null}
      </div>
    </OnboardingI18nContext.Provider>
  );
}

function Scene(props: { active: boolean; children: ReactNode }): ReactElement {
  return <section className={`scene-stage ${props.active ? "is-active" : ""}`}>{props.children}</section>;
}

function TopChrome(props: { onBack: () => void }): ReactElement {
  const s = useOnboardingStrings();
  return (
    <header className="top-app-bar bg-transparent text-zinc-100 font-inter text-sm tracking-widest uppercase docked full-width top-0 border-none flat no shadows">
      <button aria-label={s.back} className="chrome-button flex items-center justify-center w-10 h-10 rounded-full hover:bg-surface-variant transition-colors group" onClick={props.onBack}>
        <span className="material-symbols-outlined text-zinc-100 group-hover:text-purple-400 transition-colors duration-300">arrow_back</span>
      </button>
      <div className="text-xl font-bold text-white tracking-tighter" />
      <span className="chrome-spacer" aria-hidden="true" />
    </header>
  );
}

function useIntroStream(
  active: boolean,
  lines: string[][],
  pauses: number[][],
  lineHoldMs: number = INTRO_LINE_HOLD_MS,
  // Overrides the hold on the FINAL line before it resolves (`done`). Raw when
  // provided — it deliberately skips the long-line bump so a scene can raise its
  // reveal the instant the line lands (Pivot) or hold longer copy (Matchmaker).
  finalHoldMs?: number,
): { display: string; lineIndex: number; fading: boolean; done: boolean; skip: () => void } {
  const [display, setDisplay] = useState("");
  const [lineIndex, setLineIndex] = useState(0);
  const [fading, setFading] = useState(false);
  const [done, setDone] = useState(false);
  const skipRef = useRef(false);

  useEffect(() => {
    skipRef.current = false;
    if (!active) {
      setDisplay("");
      setLineIndex(0);
      setFading(false);
      setDone(false);
      return;
    }

    let cancelled = false;
    const timers = new Set<number>();
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          resolve();
        }, ms);
        timers.add(timer);
      });
    const lastIndex = lines.length - 1;
    const stop = () => cancelled || skipRef.current;

    async function run(): Promise<void> {
      for (let li = 0; li <= lastIndex; li += 1) {
        if (stop()) break;
        setLineIndex(li);
        setFading(false);
        setDisplay("");
        let current = "";
        const parts = lines[li] ?? [];
        for (let pi = 0; pi < parts.length; pi += 1) {
          if (stop()) break;
          const pause = pauses[li]?.[pi] ?? 0;
          if (pause > 0) {
            await wait(pause);
            if (stop()) break;
          }
          for (const char of parts[pi] ?? "") {
            if (stop()) break;
            current += char;
            setDisplay(current);
            const punct = ",.!?".includes(char) ? INTRO_PUNCT_PAUSE_MS : 0;
            await wait(INTRO_TYPE_CHAR_MS + Math.random() * INTRO_TYPE_JITTER_MS + punct);
          }
        }
        if (stop()) break;
        if (li < lastIndex) {
          await wait(typewriterLineHoldMs(parts, lineHoldMs));
          if (stop()) break;
          setFading(true);
          await wait(INTRO_LINE_FADE_MS);
        } else {
          await wait(finalHoldMs ?? typewriterLineHoldMs(parts, INTRO_FINAL_HOLD_MS));
        }
      }

      if (cancelled) return;
      if (skipRef.current && lastIndex >= 0) {
        setFading(false);
        setLineIndex(lastIndex);
        setDisplay((lines[lastIndex] ?? []).join(""));
        await wait(INTRO_SKIP_HOLD_MS);
        if (cancelled) return;
      }
      setDone(true);
    }

    void run();
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [active, lines, pauses, lineHoldMs, finalHoldMs]);

  const skip = useCallback(() => {
    skipRef.current = true;
  }, []);

  return { display, lineIndex, fading, done, skip };
}

// One competitor icon, held back until its PNG is fully decoded.
//
// A non-interlaced PNG paints incrementally as its scanlines arrive, so a
// half-arrived icon paints as a rectangular slab — the decoded top rows at full
// width with a hard flat bottom. That slab, not the element box, is what the
// reveal's `drop-shadow` traces, which is why scene 0 used to flash a dark
// square on the light theme (on the near-black theme the same 16% shadow is
// invisible). `decode()` is the only signal that the whole bitmap is paintable;
// `complete`/`onLoad` fire too late to help and `img.src =` alone just starts
// the fetch. Until then the img must paint NOTHING at all — opacity 0 with no
// filter, which also covers the alt text and any UA placeholder.
//
// Failure resolves the gate too, so a broken icon can never leave the row
// permanently blank: the onError guard below hides that slot as it always did.
function AppIcon(props: { src: string; alt: string }): ReactElement {
  const [ready, setReady] = useState(false);

  // A ref, not onLoad: an icon already warmed by the mount-time preload can be
  // decoded before React ever attaches a load listener, and onLoad would never
  // fire. decode() settles correctly whether the bitmap is already in hand or
  // still on the wire.
  const gate = useCallback((img: HTMLImageElement | null) => {
    if (!img) return;
    const settle = () => setReady(true);
    try {
      // Reject settles too: a row of icons that never paint would be a worse
      // bug than the flash this gate exists to remove.
      void img.decode().then(settle, settle);
    } catch {
      // No decode() on this WebView — paint immediately rather than never.
      settle();
    }
  }, []);

  return (
    <img
      ref={gate}
      className={`app-icon${ready ? " is-ready" : ""}`}
      src={props.src}
      alt={props.alt}
      onError={(e) => {
        e.currentTarget.style.visibility = "hidden";
      }}
    />
  );
}

// Row of competitor app icons. `reveal` is the large row that rises on scene 0;
// `stats` is the larger liquid-glass tray shown above the numbers on the stats
// scene. The icons are bundled assets (see the imports at the top); the onError
// guard just hides a slot rather than showing a broken-image glyph.
function AppIconRow(props: { variant: "reveal" | "stats" }): ReactElement {
  return (
    <div className={`app-icon-row app-icon-row--${props.variant}`}>
      {APP_ICONS.map((icon) => {
        const img = <AppIcon src={icon.src} alt={icon.label} />;
        // The reveal wraps each icon in a slot: the slot carries the arc
        // position + staggered spring entrance, the img inside carries the
        // gentle float, so the two transforms never fight (see onboarding.css).
        return props.variant === "reveal" ? (
          <span key={icon.key} className="app-icon-slot">
            {img}
          </span>
        ) : (
          <span key={icon.key} className="app-icon-tile">
            {img}
          </span>
        );
      })}
    </div>
  );
}

// One typewriter screen. Types `lines` out with the "live human" cadence, then
// auto-advances. If `reveal` is set, once the line lands the scene waits
// `revealDelayMs`, rises the image in, holds it `revealViewMs`, then advances
// (scene 0's app icons use this to raise the dating-app row; the Pivot screen
// passes an invisible cue whose `onReveal` rises the persistent logo overlay).
function TypewriterScene(props: {
  active: boolean;
  lines: string[][];
  pauses: number[][];
  lineHoldMs?: number;
  // Raw hold on the final line before the scene resolves (skips the long-line
  // bump). Used to raise the Pivot logo immediately / hold the Matchmaker copy.
  finalHoldMs?: number;
  onNext: () => void;
  reveal?: ReactNode;
  revealDelayMs?: number;
  revealViewMs?: number;
  // Places the reveal above the centered line instead of below it.
  revealAbove?: boolean;
  // Fires the moment the reveal is shown (used to hand the Pivot's logo off to
  // the persistent overlay).
  onReveal?: () => void;
  // Extra modifier on the scene <main> (e.g. shift the copy lower).
  mainClassName?: string;
}): ReactElement {
  const { display, lineIndex, fading, done, skip } = useIntroStream(
    props.active,
    props.lines,
    props.pauses,
    props.lineHoldMs,
    props.finalHoldMs,
  );
  const [revealShown, setRevealShown] = useState(false);

  const { active, onNext, reveal, revealDelayMs = 0, revealViewMs = 0, onReveal } = props;

  // Replay the reveal on every re-entry (e.g. the user pages back to this scene).
  useEffect(() => {
    if (!active) setRevealShown(false);
  }, [active]);

  useEffect(() => {
    if (!done) return;
    if (!reveal) {
      onNext();
      return;
    }
    const timers = [
      window.setTimeout(() => {
        setRevealShown(true);
        onReveal?.();
      }, revealDelayMs),
      window.setTimeout(() => onNext(), revealDelayMs + revealViewMs),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [done, reveal, revealDelayMs, revealViewMs, onNext, onReveal]);

  return (
    <main className={`hook-main intro-main ${props.mainClassName ?? ""}`} onClick={skip}>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-20">
        <div className="hook-glow w-64 h-64 bg-primary rounded-full blur-[100px]" />
      </div>
      <p key={lineIndex} className={`hook-title intro-line ${fading ? "is-fading" : ""}`}>
        <span className="intro-line-text">
          {display}
          <span className="intro-caret" aria-hidden="true" />
        </span>
      </p>
      {reveal ? (
        <div
          className={`intro-reveal ${props.revealAbove ? "intro-reveal--above" : ""} ${revealShown ? "is-shown" : ""}`}
          aria-hidden="true"
        >
          {reveal}
        </div>
      ) : null}
    </main>
  );
}

function useTimedCycle(
  active: boolean,
  length: number,
  intervalMs: number = DRUM_CYCLE_INTERVAL_MS,
): { index: number; canContinue: boolean } {
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
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [active, length, intervalMs]);

  return { index, canContinue };
}

function ProfileCycleScene(props: {
  active: boolean;
  onNext: () => void;
}): ReactElement {
  const s = useOnboardingStrings();
  const cycle = useTimedCycle(props.active, s.exhaustionLines.length, PROFILE_CYCLE_INTERVAL_MS);
  const copy = s.exhaustionLines[cycle.index] ?? s.exhaustionLines[0]!;

  return (
    <>
      <main className="exhaustion-main">
        <div className="lavender-glow" />
        <ProfileDeck active={props.active} />
        <div className="exhaustion-copy exhaustion-drum">
          <div key={copy} className="drum-window profile-drum-window">
            <p key={copy} className="copy-headline drum-copy-item">
              {copy}
            </p>
          </div>
        </div>
      </main>
      {/* Docked near the bottom (rising above the CTA when it appears) instead
          of floating under the centered copy, so the screen indicator sits close
          to the Next button. */}
      <div className={`dots-dock ${cycle.canContinue ? "with-cta" : ""}`}>
        <CycleDots total={s.exhaustionLines.length} active={cycle.index} complete={cycle.canContinue} />
      </div>
      {cycle.canContinue ? <BottomCta onClick={props.onNext} label={s.next} /> : null}
    </>
  );
}

// Per-step hero photos for the How-it-works screens. Files live in
// `apps/webapp/public/how-it-works/` and ship to the Mini App root; a missing
// file degrades gracefully to the dark photo frame.
const HOWITWORKS_PHOTOS = [
  "/how-it-works/1.jpg",
  "/how-it-works/2.jpg",
  "/how-it-works/3.jpg",
];
// Blurred photo backdrops for the six "Подробнее" date-flow screens. One photo
// spans two consecutive slides (0-1, 2-3, 4-5) so the scene's white icon/copy
// stays the focus; the blur + dark scrim live in `.dateflow-bg` (onboarding.css).
// Files live in `apps/webapp/public/date-flow/`; a missing file degrades to the
// plain dark background.
const DATEFLOW_PHOTOS = [
  "/date-flow/1.webp",
  "/date-flow/2.jpg",
  "/date-flow/3.webp",
];
// Abstract, frameless, white line-art icons for the six date-flow slides.
// Each is a hand-built SVG (not a Material Symbols glyph) so individual parts
// can carry a short thematic animation — played once on slide-enter (mobile,
// no cursor) and replayed on hover (Telegram Desktop). Keyed CSS classes in
// onboarding.css (`.dfi-*`) drive the motion; reduced-motion disables it.
const DATEFLOW_SVGS: ReadonlyArray<() => ReactElement> = [
  // 1. Agreement — two arrows converge on a shared node ("you both said yes").
  () => (
    <svg className="dfi-svg dfi-converge" viewBox="0 0 48 48" aria-hidden="true">
      <g className="dfi-left">
        <path d="M4 24h13" />
        <path d="M12 18l6 6-6 6" />
      </g>
      <g className="dfi-right">
        <path d="M44 24H31" />
        <path d="M36 18l-6 6 6 6" />
      </g>
      <circle className="dfi-dot" cx="24" cy="24" r="2.6" />
    </svg>
  ),
  // 2. Calendar — one cell highlights ("you pick when").
  () => (
    <svg className="dfi-svg dfi-calendar" viewBox="0 0 48 48" aria-hidden="true">
      <rect x="8" y="11" width="32" height="29" rx="5" />
      <path d="M8 19h32" />
      <path d="M16 8v6" />
      <path d="M32 8v6" />
      <rect className="dfi-cell" x="20" y="25" width="9" height="8" rx="2.2" />
    </svg>
  ),
  // 3. Compass — needle sweeps ("we pick where").
  () => (
    <svg className="dfi-svg dfi-compass" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="15" />
      <path className="dfi-needle" d="M24 13l5 11-5 4-5-4z" />
    </svg>
  ),
  // 4. Confirmed — checkmark draws in ("time and place are set").
  () => (
    <svg className="dfi-svg dfi-confirm" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="15" />
      <path className="dfi-check" d="M16 24.5l5.5 5.5L33 19" />
    </svg>
  ),
  // 5. Spark — sparkle twinkles ("just before you meet").
  () => (
    <svg className="dfi-svg dfi-spark" viewBox="0 0 48 48" aria-hidden="true">
      <path
        className="dfi-star4"
        d="M24 8c1 10 2 11 12 16-10 5-11 6-12 16-1-10-2-11-12-16 10-5 11-6 12-16z"
      />
      <circle className="dfi-twinkle" cx="37" cy="12" r="2" />
    </svg>
  ),
  // 6. Feedback — star pops inside a speech bubble ("tell us how it went").
  () => (
    <svg className="dfi-svg dfi-feedback" viewBox="0 0 48 48" aria-hidden="true">
      <path d="M10 14h28a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H22l-7 6v-6h-5a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4z" />
      <path
        className="dfi-star5"
        d="M24 19l1.8 3.7 4 .5-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.5z"
      />
    </svg>
  ),
];

function HowItWorksScene(props: {
  active: boolean;
  onMore: () => void;
}): ReactElement {
  const s = useOnboardingStrings();
  const total = s.howItWorksSteps.length;
  const [index, setIndex] = useState(0);
  const step = s.howItWorksSteps[index] ?? s.howItWorksSteps[0]!;
  const photo = HOWITWORKS_PHOTOS[index] ?? HOWITWORKS_PHOTOS[0]!;
  const isLast = index === total - 1;
  const hasBack = index > 0;

  // Reset to the first step whenever the scene is left, so a re-entry starts clean.
  useEffect(() => {
    if (!props.active) setIndex(0);
  }, [props.active]);

  const handleStep = useCallback(() => {
    app?.HapticFeedback?.selectionChanged();
    setIndex((cur) => Math.min(total - 1, cur + 1));
  }, [total]);

  const handleBack = useCallback(() => {
    app?.HapticFeedback?.selectionChanged();
    setIndex((cur) => Math.max(0, cur - 1));
  }, []);

  return (
    <main className="howitworks-main has-photo">
      <div className="howitworks-photo">
        <img key={index} src={photo} alt="" />
      </div>
      <div className="howitworks-foot">
        <div key={index} className="howitworks-foot-text">
          <h2 className="howitworks-title">{step.title}</h2>
          <p className="howitworks-body">{step.body}</p>
        </div>
        <CycleDots total={total} active={index} complete={isLast} />
        <div className="howitworks-actions">
          {hasBack ? (
            <button
              type="button"
              className="howitworks-back"
              onClick={handleBack}
              aria-label={s.back}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                arrow_back
              </span>
            </button>
          ) : null}
          <button
            type="button"
            className={`pill-cta howitworks-next ${hasBack ? "is-compact" : ""}`}
            onClick={isLast ? props.onMore : handleStep}
          >
            {isLast ? s.more : s.next}
          </button>
        </div>
      </div>
    </main>
  );
}

// Optional "Подробнее" walkthrough reached only from the last how-it-works
// screen. Driven by the phase index (not internal state) so the native Telegram
// BackButton pages it identically to the in-content back arrow.
function DateFlowScene(props: {
  index: number;
  onBack: () => void;
  onNext: () => void;
  onDone: () => void;
}): ReactElement {
  const s = useOnboardingStrings();
  const total = s.dateFlowSteps.length;
  const index = Math.max(0, Math.min(total - 1, props.index));
  const step = s.dateFlowSteps[index] ?? s.dateFlowSteps[0]!;
  const renderIcon = DATEFLOW_SVGS[index] ?? DATEFLOW_SVGS[0]!;
  const isLast = index === total - 1;
  const paragraphs = step.body.split("\n\n");
  // One backdrop photo per two slides (0-1, 2-3, 4-5).
  const photoIndex = Math.min(DATEFLOW_PHOTOS.length - 1, Math.floor(index / 2));
  const photo = DATEFLOW_PHOTOS[photoIndex] ?? DATEFLOW_PHOTOS[0]!;

  const handleForward = useCallback(() => {
    app?.HapticFeedback?.selectionChanged();
    if (isLast) props.onDone();
    else props.onNext();
  }, [isLast, props.onDone, props.onNext]);

  const handleBack = useCallback(() => {
    app?.HapticFeedback?.selectionChanged();
    props.onBack();
  }, [props.onBack]);

  return (
    <>
      <main className="howitworks-main">
        <div className="dateflow-bg" aria-hidden="true">
          <img key={photoIndex} src={photo} alt="" />
        </div>
        <div className="lavender-glow" />
        <div key={index} className="howitworks-card">
          <div className="howitworks-icon">{renderIcon()}</div>
          <h2 className="howitworks-title">{step.title}</h2>
          {paragraphs.map((paragraph, i) => (
            <p key={i} className="howitworks-body">
              {paragraph}
            </p>
          ))}
        </div>
      </main>
      <div className="howitworks-dock">
        <CycleDots total={total} active={index} complete={isLast} />
        <div className="howitworks-actions">
          <button
            type="button"
            className="howitworks-back"
            onClick={handleBack}
            aria-label={s.back}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              arrow_back
            </span>
          </button>
          <button
            type="button"
            className="pill-cta howitworks-next is-compact"
            onClick={handleForward}
          >
            {isLast ? s.continue : s.next}
          </button>
        </div>
      </div>
    </>
  );
}

function StatsCycleScene(props: {
  active: boolean;
  onNext: () => void;
}): ReactElement {
  const s = useOnboardingStrings();
  const statCopy: StatCopy[] = [
    { value: "75", label: s.statLabels[0] },
    { value: "9500", label: s.statLabels[1] },
    { value: "$200", valueSmall: true, label: s.statLabels[2], labelSentence: true },
  ];
  const cycle = useTimedCycle(props.active, statCopy.length);
  const copy = statCopy[cycle.index] ?? statCopy[0]!;

  return (
    <div className="trap-body">
      <div className="trap-bg" aria-hidden="true">
        <img alt="" className="trap-bg-image" src={TRAP_BACKGROUND} />
      </div>
      <main className="trap-main">
        <div className="stats-native-panel">
          <div className="stat-wrap stat-drum-wrap">
            <AppIconRow variant="stats" />
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
        <div className="stat-footnote-block">
          <p className="stat-footnote">{s.statFootnote}</p>
        </div>
      </main>
      <div className={`dots-dock ${cycle.canContinue ? "with-cta" : ""}`}>
        <CycleDots total={statCopy.length} active={cycle.index} complete={cycle.canContinue} />
      </div>
      {cycle.canContinue ? <BottomCta onClick={props.onNext} label={s.next} /> : null}
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

function ProfileDeck(props: { active: boolean }): ReactElement {
  const total = PROFILE_CARDS.length;
  const [index, setIndex] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [dir, setDir] = useState<"left" | "right">("right");

  useEffect(() => {
    if (!props.active) {
      setIndex(0);
      setLeaving(false);
      setDir("right");
      return;
    }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const timer = window.setInterval(() => {
      if (reduce) {
        setIndex((cur) => (cur + 1) % total);
        setDir((cur) => (cur === "right" ? "left" : "right"));
      } else {
        setLeaving(true);
      }
    }, PROFILE_SWIPE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [props.active, total]);

  // Warm the image cache once so a freshly-mounted back card never flashes its
  // dark placeholder before the photo paints.
  useEffect(() => {
    for (const card of PROFILE_CARDS) {
      const img = new Image();
      img.src = card.photo;
    }
  }, []);

  const handleExitEnd = useCallback(() => {
    setIndex((cur) => (cur + 1) % total);
    setDir((cur) => (cur === "right" ? "left" : "right"));
    setLeaving(false);
  }, [total]);

  const front = PROFILE_CARDS[index] ?? PROFILE_CARDS[0]!;
  const back = PROFILE_CARDS[(index + 1) % total] ?? PROFILE_CARDS[0]!;

  return (
    <div className="swipe-deck">
      {/* Keyed by profile index (not slot) so the back card's already-painted
          element is reused as the next front — without this React remounts a
          blank card on every advance and it flashes its dark placeholder. */}
      <ProfileCard key={(index + 1) % total} data={back} variant="back" rising={leaving} />
      <ProfileCard
        key={index}
        data={front}
        variant="front"
        leaving={leaving}
        dir={dir}
        onExitEnd={handleExitEnd}
      />
    </div>
  );
}

function ProfileCard(props: {
  data: ProfileCardData;
  variant: "front" | "back";
  rising?: boolean;
  leaving?: boolean;
  dir?: "left" | "right";
  onExitEnd?: () => void;
}): ReactElement {
  const { data } = props;
  const className = [
    "profile-card",
    `is-${props.variant}`,
    props.rising ? "is-rising" : "",
    props.leaving ? `is-leaving-${props.dir}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      onAnimationEnd={(event) => {
        if (props.leaving && event.animationName.startsWith("swipeOut")) props.onExitEnd?.();
      }}
    >
      <img className="profile-card-image" src={data.photo} alt="" />
      <div className="profile-card-gradient" />
      <div className="profile-card-foot">
        <div className="profile-card-caption">
          <h2 className="profile-card-name">
            {data.name}
            <span className="profile-card-age">{data.age}</span>
            <span className="profile-card-verified material-symbols-outlined" aria-hidden="true">
              verified
            </span>
          </h2>
          <p className="profile-card-meta">
            <span className="material-symbols-outlined" aria-hidden="true">
              location_on
            </span>
            {data.distanceKm} km
          </p>
          <div className="profile-card-tags">
            {data.interests.slice(0, 3).map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        </div>
        <div className="profile-card-actions">
          <MockAction icon="undo" tone="yellow" small />
          <MockAction icon="close" tone="red" />
          <MockAction icon="star" tone="blue" small />
          <MockAction icon="favorite" tone="green" />
          <MockAction icon="bolt" tone="purple" small />
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
        className="pill-cta font-label-md text-label-md uppercase tracking-wider px-12 py-4 rounded-full transition-all duration-300 transform hover:scale-105 active:scale-95 font-bold"
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
  const s = useOnboardingStrings();
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
      setError(errorCopy(err, s));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <GateShell>
      <h1>{s.consentTitle}</h1>
      <p>{s.consentLead}</p>
      {error ? <div className="gate-error">{error}</div> : null}
      <label className="check-row">
        <input type="checkbox" checked={terms} onChange={(event) => setTerms(event.currentTarget.checked)} />
        <span>
          {s.consentTermsPrefix}{" "}
          <a className="gate-link" href={TERMS_OF_SERVICE_URL} rel="noreferrer" target="_blank">
            {s.consentTerms}
          </a>{" "}
          {s.consentAnd}{" "}
          <a className="gate-link" href={PRIVACY_POLICY_URL} rel="noreferrer" target="_blank">
            {s.consentPrivacy}
          </a>
          .
        </span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={research} onChange={(event) => setResearch(event.currentTarget.checked)} />
        <span>{s.consentResearch}</span>
      </label>
      <button className="gate-button" disabled={!terms || busy || !app?.initData} onClick={() => void submit()}>
        {busy ? s.saving : s.continue}
      </button>
    </GateShell>
  );
}

function LanguageGate(props: {
  selected: OnboardingLanguage | null;
  onState: (state: TelegramOnboardingState) => void;
}): ReactElement {
  const s = useOnboardingStrings();
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
      setError(errorCopy(err, s));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <GateShell>
      <h1>{s.languageTitle}</h1>
      <p>{s.languageLead}</p>
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
              <small>{busy === option.value ? s.saving : option.sub}</small>
            </span>
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        ))}
      </div>
    </GateShell>
  );
}

/* Hand-drawn, on-brand glyphs for the theme picker (burgundy via currentColor). */
const MoonGlyph = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M21 12.9A8.5 8.5 0 1 1 11.1 3a6.6 6.6 0 0 0 9.9 9.9z" />
  </svg>
);
const SunGlyph = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4.1" fill="currentColor" stroke="none" />
    <path d="M12 2.4v2.3M12 19.3v2.3M4.3 4.3l1.6 1.6M18.1 18.1l1.6 1.6M2.4 12h2.3M19.3 12h2.3M4.3 19.7l1.6-1.6M18.1 5.9l1.6-1.6" />
  </svg>
);
const CheckGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7" />
  </svg>
);

const THEME_VALUES: readonly OnboardingTheme[] = ["dark", "light"];

function ThemeGate(props: {
  selected: OnboardingTheme;
  onState: (state: TelegramOnboardingState) => void;
}): ReactElement {
  const s = useOnboardingStrings();
  const [busy, setBusy] = useState<OnboardingTheme | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(theme: OnboardingTheme): Promise<void> {
    if (!app?.initData || busy) return;
    setBusy(theme);
    setError(null);
    // Optimistic: apply instantly so the choice — and the visual intro that
    // follows — render in the picked theme without waiting on the round-trip.
    setTheme(theme);
    try {
      const state = await setTelegramOnboardingTheme(app.initData, theme);
      app.HapticFeedback?.selectionChanged();
      props.onState(state);
    } catch (err) {
      setError(errorCopy(err, s));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <GateShell>
      <h1>{s.themeTitle}</h1>
      <p>{s.themeLead}</p>
      {error ? <div className="gate-error">{error}</div> : null}
      <div className="theme-tile-row">
        {THEME_VALUES.map((value) => {
          const label = value === "dark" ? s.themeDark : s.themeLight;
          return (
            <button
              key={value}
              type="button"
              className={`theme-tile theme-tile--${value} ${props.selected === value ? "is-selected" : ""}`}
              disabled={busy !== null || !app?.initData}
              onClick={() => void choose(value)}
              aria-label={label}
              aria-pressed={props.selected === value}
            >
              <span className="theme-tile__sky" aria-hidden="true">
                <span className="theme-tile__glyph">
                  {value === "dark" ? MoonGlyph : SunGlyph}
                </span>
                <span className="theme-tile__check">{CheckGlyph}</span>
              </span>
              <span className="theme-tile__mini" aria-hidden="true">
                <span className="theme-tile__mini-accent" />
                <span className="theme-tile__mini-line" />
                <span className="theme-tile__mini-line theme-tile__mini-line--short" />
              </span>
            </button>
          );
        })}
      </div>
    </GateShell>
  );
}

function PathGate(props: {
  selected: RegistrationTrack | null;
  onState: (state: TelegramOnboardingState) => void;
}): ReactElement {
  const s = useOnboardingStrings();
  const [busy, setBusy] = useState<RegistrationTrack | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options: Array<{
    value: RegistrationTrack;
    label: string;
    sub: string;
    recommended?: boolean;
  }> = [
    { value: "student", label: s.pathStudentTitle, sub: s.pathStudentSub, recommended: true },
    { value: "general", label: s.pathGeneralTitle, sub: s.pathGeneralSub },
  ];

  async function choose(track: RegistrationTrack): Promise<void> {
    if (!app?.initData || busy) return;
    setBusy(track);
    setError(null);
    try {
      const state = await setTelegramOnboardingTrack(app.initData, track);
      app.HapticFeedback?.selectionChanged();
      props.onState(state);
    } catch (err) {
      setError(errorCopy(err, s));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <GateShell>
      <h1>{s.pathTitle}</h1>
      <p>{s.pathLead}</p>
      {error ? <div className="gate-error">{error}</div> : null}
      <div className="choice-row">
        {options.map((option) => (
          <button
            key={option.value}
            className={`choice-button ${option.recommended ? "is-priority" : ""} ${props.selected === option.value ? "is-selected" : ""}`}
            disabled={busy !== null || !app?.initData}
            onClick={() => void choose(option.value)}
          >
            <span>
              <strong>{option.label}</strong>
              <small>{busy === option.value ? s.saving : option.sub}</small>
            </span>
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        ))}
      </div>
    </GateShell>
  );
}

function PhoneGate(props: {
  onState: (state: TelegramOnboardingState) => void;
}): ReactElement {
  const s = useOnboardingStrings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initData = app?.initData;
  const requestContact = app?.requestContact;

  function share(): void {
    if (!requestContact || !initData || busy) return;
    setBusy(true);
    setError(null);
    requestContact((shared) => {
      if (!shared) {
        setBusy(false);
        return;
      }
      // Telegram delivers the number to the BOT as a trusted message.contact
      // (never to JS). Poll /state until the bot records phoneVerifiedAt.
      void (async () => {
        try {
          for (let attempt = 0; attempt < 24; attempt++) {
            const state = await fetchTelegramOnboardingState(initData, source);
            if (state.user.isPhoneVerified) {
              app?.HapticFeedback?.notificationOccurred("success");
              props.onState(state);
              return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
          }
          setError(s.phoneTimeout);
          app?.HapticFeedback?.notificationOccurred("error");
        } catch (err) {
          setError(errorCopy(err, s));
          app?.HapticFeedback?.notificationOccurred("error");
        } finally {
          setBusy(false);
        }
      })();
    });
  }

  return (
    <GateShell>
      <h1>{s.phoneTitle}</h1>
      <p>{s.phoneLead}</p>
      {error ? <div className="gate-error">{error}</div> : null}
      <div className="gate-stack">
        <button
          className="gate-button"
          disabled={busy || !requestContact || !initData}
          onClick={share}
        >
          {busy ? s.phoneSharing : s.phoneShare}
        </button>
      </div>
      <div className="gate-meta">{s.phoneMeta}</div>
    </GateShell>
  );
}

function EmailGate(props: {
  defaultEmail: string;
  onOtp: (email: string, emailVerification?: EmailVerificationState) => void;
  onState: (state: TelegramOnboardingState) => void;
}): ReactElement {
  const s = useOnboardingStrings();
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
      setError(errorCopy(err, s));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <GateShell>
      <h1>{s.emailTitle}</h1>
      <p>{s.emailLead}</p>
      {error ? <div className="gate-error">{error}</div> : null}
      <div className="gate-stack">
        <input
          className="gate-input"
          inputMode="email"
          autoCapitalize="none"
          autoComplete="email"
          enterKeyHint="send"
          placeholder="name@university.edu"
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Enter on the soft/hardware keyboard fires the same path as the
            // "Next" button, so the user never has to scroll down to tap it.
            if (event.key === "Enter" && email.trim() && !busy && app?.initData) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button className="gate-button" disabled={!email.trim() || busy || !app?.initData} onClick={() => void submit()}>
          {busy ? s.emailSending : s.emailSend}
        </button>
      </div>
      <div className="gate-meta">{s.emailMeta}</div>
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
  const s = useOnboardingStrings();
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
      setError(errorCopy(err, s));
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
      setError(errorCopy(err, s));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setResendBusy(false);
    }
  }

  return (
    <GateShell>
      <h1>{s.otpTitle}</h1>
      <p>{s.otpLead(props.email)}</p>
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
            aria-label={s.otpDigit(index + 1)}
          />
        ))}
      </div>
      <button className="gate-button" disabled={code.length !== 6 || busy || !app?.initData} onClick={() => void submit()}>
        {busy ? s.otpChecking : s.otpConfirm}
      </button>
      <div className="otp-actions">
        <button
          className="gate-link"
          disabled={resendBusy || resendSeconds > 0 || !app?.initData}
          onClick={() => void resend()}
        >
          {resendBusy
            ? s.otpResending
            : resendSeconds > 0
              ? s.otpResendIn(resendSeconds)
              : s.otpResend}
        </button>
        <button className="gate-link" disabled={busy || resendBusy} onClick={props.onChangeEmail}>
          {s.otpChangeEmail}
        </button>
      </div>
    </GateShell>
  );
}

function CityGate(props: { onState: (state: TelegramOnboardingState) => void }): ReactElement {
  const s = useOnboardingStrings();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TelegramCityHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [geoBusy, setGeoBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
          setError(errorCopy(err, s));
          setResults([]);
        })
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Reveal the city list above the keyboard. Telegram's WebView overlays the
  // keyboard without scrolling the focused field up, so when matches land we
  // pull the input to the top of the (keyboard-bounded) scrollable card — the
  // results then sit directly beneath it instead of below the fold. Only fires
  // when the card actually overflows, so a no-keyboard / desktop layout that
  // already shows everything is left untouched.
  useEffect(() => {
    if (results.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      const card = input?.closest(".gate-card");
      if (!input || !card) return;
      if (card.scrollHeight > card.clientHeight + 4) {
        input.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [results]);

  async function choose(city: TelegramCityHit, allowWhileGeo = false): Promise<void> {
    if (!app?.initData || busy || (geoBusy && !allowWhileGeo)) return;
    setBusy(true);
    setError(null);
    try {
      const state = await selectTelegramOnboardingCity(app.initData, city);
      app.HapticFeedback?.notificationOccurred("success");
      props.onState(state);
    } catch (err) {
      setError(errorCopy(err, s));
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
      setError(s.cityGeoUnavailable);
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
        setError(s.cityGeoDenied);
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
      setError(errorCopy(err, s));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setGeoBusy(false);
    }
  }

  return (
    <GateShell>
      <h1>{s.cityTitle}</h1>
      <p>{s.cityLead}</p>
      {error ? <div className="gate-error">{error}</div> : null}
      <div className="gate-stack">
        <button className="choice-button" disabled={busy || geoBusy || !app?.initData} onClick={useCurrentLocation}>
          <span>
            <strong>{geoBusy ? s.cityDetecting : s.cityDetect}</strong>
            <small>{s.cityGeoMeta}</small>
          </span>
          <span className="material-symbols-outlined">my_location</span>
        </button>
        <input
          ref={inputRef}
          className="gate-input"
          autoCapitalize="words"
          autoComplete="address-level2"
          placeholder={s.cityPlaceholder}
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
                <small>{city.label}</small>
              </span>
              <span className="material-symbols-outlined">chevron_right</span>
            </button>
          ))}
        </div>
        {searching ? <div className="gate-meta">{s.citySearching}</div> : null}
      </div>
    </GateShell>
  );
}

function ReferralGiftGate(props: {
  months: number;
  referrerName: string | null;
  onClaimed: (state: TelegramOnboardingState) => void;
}): ReactElement {
  const s = useOnboardingStrings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const months = String(props.months);
  const body = props.referrerName
    ? s.referralGiftBody.replaceAll("{name}", props.referrerName).replaceAll("{months}", months)
    : s.referralGiftBodyNoName.replaceAll("{months}", months);

  async function claim(): Promise<void> {
    if (!app?.initData || busy) return;
    setBusy(true);
    setError(null);
    try {
      const state = await claimTelegramOnboardingReferralGift(app.initData);
      app.HapticFeedback?.notificationOccurred("success");
      props.onClaimed(state);
    } catch (err) {
      setError(errorCopy(err, s));
      app.HapticFeedback?.notificationOccurred("error");
      setBusy(false);
    }
  }

  return (
    <main className="referral-gift-screen">
      <div className="referral-gift-content">
        <div className="referral-gift-badge" aria-hidden="true">
          ✨
        </div>
        <h1 className="referral-gift-title">{s.referralGiftTitle}</h1>
        <p className="referral-gift-body">{body}</p>
        {error ? <div className="gate-error referral-gift-error">{error}</div> : null}
      </div>
      <div className="referral-gift-actions">
        <button
          className="referral-gift-primary"
          disabled={busy || (!app?.initData && !PREVIEW_REFERRAL_GIFT)}
          onClick={() => void claim()}
        >
          {busy ? s.referralGiftClaiming : s.referralGiftContinue}
        </button>
      </div>
    </main>
  );
}

function AiMemoryExportGate(props: {
  onSaved: (state: TelegramOnboardingState) => void;
}): ReactElement {
  const s = useOnboardingStrings();
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
      setError(errorCopy(err, s));
      app.HapticFeedback?.notificationOccurred("error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="ai-memory-screen">
      <div className="ai-memory-content">
        <h1>
          {s.aiMemoryTitle}
        </h1>

        <div className="ai-logo-fan" aria-label={s.aiMemoryAria}>
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
          {busy === "accepted" ? s.aiMemoryAccepting : s.aiMemoryAccept}
        </button>
        <button
          className="ai-memory-secondary"
          disabled={busy !== null || !app?.initData}
          onClick={() => void choose("declined")}
        >
          {busy === "declined" ? s.aiMemorySaving : s.aiMemoryLater}
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
  const s = useOnboardingStrings();
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
      setError(s.handoffMissingSession);
      return;
    }
    const delay = new Promise<void>((resolve) => window.setTimeout(resolve, 6000));
    const post = completeTelegramOnboardingGate(app.initData, props.flowToken);
    void Promise.all([delay, post])
      .then(([, result]) => {
        if (!result.botTookOver && !result.completed) {
          setError(s.handoffFailed);
          return;
        }
        setComplete(true);
        app.HapticFeedback?.notificationOccurred("success");
        window.setTimeout(() => {
          onDoneRef.current();
        }, 900);
      })
      .catch((err: unknown) => {
        setError(errorCopy(err, s));
        app.HapticFeedback?.notificationOccurred("error");
      });
  }, [attempt, props.active, props.flowToken]);

  return (
    <div className="orb-wrap">
      <div>
        <div className="loading-orb" />
        <h1>{complete ? s.handoffReadyTitle : s.handoffTitle}</h1>
        <p>{error ?? s.handoffLead}</p>
        {error ? (
          <button
            className="gate-button"
            style={{ marginTop: 20 }}
            onClick={() => {
              setError(null);
              setAttempt((current) => current + 1);
            }}
          >
            {s.retry}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DoneScene(): ReactElement {
  const s = useOnboardingStrings();
  return (
    <div className="orb-wrap">
      <div>
        <div className="loading-orb" />
        <h1>{s.doneTitle}</h1>
        <p>{s.doneLead}</p>
        <button className="gate-button done-close-button" onClick={() => app?.close()}>
          {s.backToChat}
        </button>
      </div>
    </div>
  );
}

function SyncingScene(): ReactElement {
  const s = useOnboardingStrings();
  return (
    <div className="orb-wrap">
      <div>
        <div className="loading-orb syncing-orb" />
        <h1>{s.syncingTitle}</h1>
        <p>{s.syncingLead}</p>
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

function errorCopy(err: unknown, strings: OnboardingStrings): string {
  if (err instanceof CalendarApiError) {
    if (err.reason && strings.errors[err.reason]) return strings.errors[err.reason];
    return err.reason ?? err.message;
  }
  return err instanceof Error ? err.message : strings.genericError;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
