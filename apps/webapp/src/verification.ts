import {
  fetchVerificationInit,
  postVerificationConsent,
  postVerificationEvent,
  CalendarApiError,
  type VerificationInit,
} from "./api.js";
import { pickLang, tr, type Lang } from "./i18n.js";
import { butterflyLoaderMarkup } from "./butterfly-loader.js";
import {
  butterflySuccessMarkup,
  onSuccessSettle,
  restDelayFrom,
  SUCCESS_READ_MS,
} from "./butterfly-success.js";
import { wireContentInsets } from "./telegram-insets.js";

/**
 * Verification Mini App — AWS Rekognition Face Liveness.
 *
 * UX flow:
 *   1. User taps "🟢 Verify now" on the bot's CTA. Telegram opens this page via
 *      `InlineKeyboardButton.web_app` inside the native WebView — no browser
 *      frame, no redirect to any third party.
 *   2. `GET /v1/verification/mini-app/init` returns a liveness `sessionId`, the
 *      region, and short-lived AWS credentials scoped to a single action.
 *   3. Amplify's `FaceLivenessDetector` (mounted as a React island by
 *      `liveness-detector.tsx`) runs the check on-device and streams the selfie
 *      video straight to Rekognition. The video never touches our server.
 *   4. On completion we POST `/event`, which reads AWS's verdict server-side
 *      and either starts face-matching or asks the user to try again.
 *
 * Two things drive the design:
 *   • The session expires 3 MINUTES after step 2, taking the reference image
 *     with it. So the `complete` POST is not a nudge — it is the only chance to
 *     read the result, and the user must not sit on the loading screen.
 *   • The client never learns whether it passed. The bot DMs the outcome; this
 *     page only distinguishes "we're checking" from "run it again".
 *
 * Why an island instead of a React page: the surrounding screens (loading,
 * error, success, already-verified) are four mutually-exclusive states of plain
 * HTML, and the Telegram lifecycle (fullscreen, theme, BackButton, closing
 * confirmation) is imperative. Only the detector needs React.
 */

/** Kept in sync with the same constant in `onboarding.tsx`. */
const PRIVACY_POLICY_URL = "https://gennety.com/privacy";

// ---------------------------------------------------------------------------
// Pure handlers — exported so verification.test.ts can drive them with
// mocked Telegram.WebApp + mocked POST endpoint without booting the whole
// page lifecycle.
// ---------------------------------------------------------------------------

export interface HandlerDeps {
  initData: string;
  lang: Lang;
  /** Session being reported on. Null only for cancel, which needs no verdict. */
  sessionId: string | null;
  app: {
    HapticFeedback?: { notificationOccurred?: (kind: "success" | "error") => void };
    close(): void;
    MainButton?: {
      setText(text: string): void;
      show(): void;
      hide(): void;
      onClick(handler: () => void): void;
      offClick?(handler: () => void): void;
    };
  };
  render: (view: Screen) => void;
  postEvent: typeof postVerificationEvent;
  closeDelayMs?: number;
}

/**
 * The detector finished capturing. Unlike the Persona flow this POST is
 * load-bearing: the server reads AWS's verdict inside it, so we wait for the
 * response and branch on the outcome instead of closing optimistically.
 */
export async function handleComplete(deps: HandlerDeps): Promise<void> {
  deps.render("finishing");
  // The mark goes on screen HERE, before the verdict is known, and then we wait
  // on a network round-trip. So neither the haptic nor the close can be a flat
  // offset from this point: both are measured from the mark's own mount.
  const markMountedAt = Date.now();
  try {
    const result = await deps.postEvent(deps.initData, {
      kind: "complete",
      sessionId: deps.sessionId,
    });
    if (result.outcome === "retry") {
      // Not a failure of ours and not a rejection of them — the capture just
      // wasn't convincing. The bot has already sent a fresh Verify button.
      deps.app.HapticFeedback?.notificationOccurred?.("error");
      deps.render("retry");
      showCloseButton(deps);
      return;
    }
    // Buzz when the butterfly LANDS, not when the POST returns. A fast response
    // used to fire this while the mark was still mid-flight, so the phone
    // confirmed a success the screen had not finished stating; a slow one is
    // already past the landing and pulses immediately.
    onSuccessSettle(
      () => deps.app.HapticFeedback?.notificationOccurred?.("success"),
      markMountedAt,
    );
  } catch (err) {
    // The check may well have passed; we just couldn't tell the server. Say so
    // honestly rather than showing a success tick we can't back up.
    console.warn("[verification] /event complete POST failed", err);
    deps.render("error");
    showCloseButton(deps);
    return;
  }
  // Never dismiss over a moving mark, then hold a readable beat on top. Both
  // halves are derived from the animation rather than hand-tuned (this was a
  // flat 2200ms fitted to the old disc-and-tick), so lengthening the flight
  // cannot silently start closing the WebView over a half-drawn tick.
  const delay = deps.closeDelayMs ?? restDelayFrom(markMountedAt) + SUCCESS_READ_MS;
  setTimeout(() => deps.app.close(), delay);
}

export async function handleCancel(deps: HandlerDeps): Promise<void> {
  try {
    await deps.postEvent(deps.initData, { kind: "cancel" });
  } catch (err) {
    console.warn("[verification] /event cancel POST failed", err);
  }
  deps.app.close();
}

export async function handleError(
  event: { message?: string; detail?: string },
  deps: HandlerDeps,
): Promise<void> {
  deps.app.HapticFeedback?.notificationOccurred?.("error");
  try {
    await deps.postEvent(deps.initData, {
      kind: "error",
      message: event.message ?? null,
      detail: event.detail ?? null,
    });
  } catch (err) {
    console.warn("[verification] /event error POST failed", err);
  }
  deps.render("error");
  showCloseButton(deps);
}

function showCloseButton(deps: HandlerDeps): void {
  const button = deps.app.MainButton;
  if (!button) return;
  button.setText(tr(deps.lang, "verifyMiniAppCloseBtn"));
  button.onClick(() => deps.app.close());
  button.show();
}

// ---------------------------------------------------------------------------
// Page-level rendering — swaps inner HTML of #root for the requested screen.
// Kept as a single function (not a component framework) because these are
// mutually-exclusive static views; only the detector itself needs React.
// ---------------------------------------------------------------------------

export type Screen =
  | "consent"
  | "loading"
  | "finishing"
  | "error"
  | "retry"
  | "success"
  | "already-verified"
  | "unavailable";

/**
 * The success screen — the shared brand mark plus this screen's own line.
 *
 * The green-disc-and-white-tick that used to live here was one of four
 * unrelated checkmarks across the Mini Apps; it is now
 * `butterfly-success.ts`, which every success screen in the product renders.
 * The caption rides the mark's own `label`, so it fades in on the mark's
 * schedule instead of needing this page's `check-caption` timing.
 */
function successScreen(lang: Lang, textKey: Parameters<typeof tr>[1]): string {
  return `
    <div class="screen">
      ${butterflySuccessMarkup({ label: tr(lang, textKey) })}
    </div>`;
}

function panelScreen(lang: Lang, glyph: string, textKey: Parameters<typeof tr>[1]): string {
  return `
    <div class="screen">
      <div class="screen__panel">
        <div class="error-glyph">${glyph}</div>
        <p class="screen-title">${escapeHtml(tr(lang, textKey))}</p>
      </div>
    </div>`;
}

/**
 * Explicit biometric-consent screen (GDPR Art. 9(2)(a)).
 *
 * Shown before the detector is ever mounted, and only when the server says
 * consent is missing. It states the four things a valid explicit consent has
 * to state — what is captured, who processes it, how long it is kept, and what
 * happens if you decline — because tapping a button labelled "Verify" under
 * copy that never mentions biometrics is not consent to biometric processing.
 */
function consentScreen(lang: Lang): string {
  const p = (key: Parameters<typeof tr>[1]): string =>
    `<p class="consent-text">${escapeHtml(tr(lang, key))}</p>`;
  return `
    <div class="screen screen--consent">
      <div class="consent">
        <h1 class="consent-title">${escapeHtml(tr(lang, "verifyConsentTitle"))}</h1>
        ${p("verifyConsentLead")}
        ${p("verifyConsentWhat")}
        ${p("verifyConsentWho")}
        ${p("verifyConsentKeep")}
        ${p("verifyConsentRefuse")}
        <a class="consent-link" href="${PRIVACY_POLICY_URL}" target="_blank" rel="noreferrer">
          ${escapeHtml(tr(lang, "verifyConsentPolicyLink"))}
        </a>
        <p class="consent-error" id="consent-error" hidden></p>
      </div>
      <button class="consent-cta" id="consent-agree" type="button">
        ${escapeHtml(tr(lang, "verifyConsentAgreeBtn"))}
      </button>
    </div>`;
}

export function renderScreen(root: HTMLElement, screen: Screen, lang: Lang): void {
  switch (screen) {
    case "consent":
      root.innerHTML = consentScreen(lang);
      return;
    case "loading":
      // Markup deliberately identical to the inline pre-paint shell in
      // verification.html, so the bundle taking over the #root is invisible
      // rather than a ring→butterfly swap. `butterfly-loader.test.ts` pins the
      // two together.
      root.innerHTML = `
        <div class="screen">
          ${butterflyLoaderMarkup({ label: tr(lang, "verifyMiniAppLoading") })}
        </div>`;
      return;
    case "finishing":
      root.innerHTML = successScreen(lang, "verifyMiniAppFinishing");
      return;
    case "success":
      root.innerHTML = successScreen(lang, "verifyMiniAppFinishing");
      return;
    case "retry":
      root.innerHTML = panelScreen(lang, "🙈", "verifyMiniAppRetry");
      return;
    case "error":
      root.innerHTML = panelScreen(lang, "⚠️", "verifyMiniAppError");
      return;
    case "already-verified":
      root.innerHTML = successScreen(lang, "verifyMiniAppAlreadyVerified");
      return;
    case "unavailable":
      root.innerHTML = `
        <div class="screen">
          <div class="screen__panel">
            <p class="screen-text">${escapeHtml(tr(lang, "verifyMiniAppNotConfigured"))}</p>
          </div>
        </div>`;
      return;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Bootstrap — only runs when the module is imported in the actual page
// context (Telegram WebApp present). Tests import the handler functions
// directly and skip this side-effecting block by checking the global.
// ---------------------------------------------------------------------------

function boot(): void {
  const app = window.Telegram?.WebApp;
  const root = document.getElementById("root");
  if (!root) return;

  const params = new URLSearchParams(location.search);
  const lang: Lang = pickLang(params.get("lang") ?? app?.initDataUnsafe?.user?.language_code);
  document.documentElement?.setAttribute("lang", lang);

  // Initial paint — verification.html ships the loading screen inline, but
  // we re-render so language picks land before the network call returns.
  renderScreen(root, "loading", lang);

  if (!app) {
    // Opened outside Telegram (e.g. bookmarked URL) — surface a clear
    // "this needs Telegram" state rather than hanging on /init.
    renderScreen(root, "unavailable", lang);
    return;
  }

  app.ready();
  app.expand();
  // Bot API 8.0+ — immersive fullscreen for the capture. Older clients
  // gracefully fall through to expanded-but-not-fullscreen. Paint Telegram's
  // chrome to match the active theme so it doesn't flash the wrong color.
  const bootTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const chromeColor = bootTheme === "light" ? "#f5f5f5" : "#030303";
  try {
    app.requestFullscreen?.();
    app.setHeaderColor?.(chromeColor);
    app.setBackgroundColor?.(chromeColor);
    app.setBottomBarColor?.(chromeColor);
  } catch (err) {
    console.warn("[verification] fullscreen/chrome setup failed (non-fatal)", err);
  }
  // Fullscreen floats Telegram's close ×/menu ⋯ over the page and `env()` does
  // not account for them, so the consent copy would slide under the chrome.
  // Mirrors the real reserve into --tg-content-top/bottom for the CSS above.
  wireContentInsets(app);

  // TEMPORARY, dev-only: `?preview=success` renders the success-mark comparison
  // board (success-variants.ts) instead of this page. It hangs off verification
  // rather than a new HTML entry because a new entry would be built and shipped;
  // this branch and the module behind it are deleted once a variant is chosen.
  // Dynamically imported so the production build, where the condition folds to
  // `false`, drops the module and its stylesheet entirely.
  if (import.meta.env.DEV && params.get("preview") === "success") {
    void import("./success-variants.js").then((m) => m.mountVariantsBoard(root));
    return;
  }

  // Dev-only screen preview: `?screen=loading|success|retry|error|...` renders
  // that state and skips the liveness session, so every themed status screen
  // can be reviewed without burning a real check. Inert in production builds.
  if (import.meta.env.DEV) {
    const forced = params.get("screen");
    const allowed: Screen[] = [
      "loading",
      "finishing",
      "success",
      "retry",
      "error",
      "unavailable",
      "already-verified",
    ];
    if (forced && (allowed as string[]).includes(forced)) {
      renderScreen(root, forced as Screen, lang);
      return;
    }
  }
  // Catch accidental swipe-down dismissals during capture.
  try {
    (app as unknown as { enableClosingConfirmation?: () => void }).enableClosingConfirmation?.();
  } catch {
    // SDK without that helper — ignore, not all builds expose it.
  }
  // Back button as an explicit "I want out" affordance during the flow.
  app.BackButton?.show();
  app.BackButton?.onClick(() => {
    void handleCancel(buildDeps(app, root, lang, null));
  });

  void bootstrap(app, root, lang);
}

/**
 * Show the biometric-consent screen and resolve once the user has agreed AND
 * the server has recorded it. Rejects only if the user backs out.
 *
 * The action is an in-page floating button rather than Telegram's MainButton:
 * this page runs fullscreen, and the MainButton renders as a full-width bar
 * welded to the bottom edge, which is the one shape this screen doesn't want.
 * The affirmative act is unchanged — one explicit tap, recorded server-side
 * before any session is minted.
 */
async function collectConsent(
  app: NonNullable<typeof window.Telegram>["WebApp"],
  root: HTMLElement,
  lang: Lang,
): Promise<boolean> {
  renderScreen(root, "consent", lang);
  // Defensive: an earlier screen may have left the bottom bar up, and the whole
  // point here is that it isn't there.
  app.MainButton?.hide();
  const button = document.getElementById("consent-agree") as HTMLButtonElement | null;
  if (!button) return false;

  return new Promise<boolean>((resolve) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      button.disabled = true;
      void postVerificationConsent(app.initData)
        .then(() => {
          resolve(true);
        })
        .catch(() => {
          button.disabled = false;
          const err = document.getElementById("consent-error");
          if (err) {
            err.textContent = tr(lang, "verifyConsentFailed");
            err.hidden = false;
          }
          app.HapticFeedback?.notificationOccurred?.("error");
          // Deliberately NOT resolving: the screen stays up so the user can
          // tap again. Consent that we failed to record must not become a
          // session — the server would refuse it anyway.
        });
    });
  });
}

async function bootstrap(
  app: NonNullable<typeof window.Telegram>["WebApp"],
  root: HTMLElement,
  lang: Lang,
): Promise<void> {
  let init: VerificationInit;
  try {
    init = await fetchVerificationInit(app.initData);
  } catch (err) {
    // 409 `consent-required` is not an error state — it is the server telling
    // us this user has never given explicit biometric consent. Collect it,
    // then retry exactly once. Any other 409 really is "already verified".
    if (
      err instanceof CalendarApiError &&
      err.status === 409 &&
      err.reason === "consent-required"
    ) {
      const agreed = await collectConsent(app, root, lang);
      if (!agreed) return;
      renderScreen(root, "loading", lang);
      try {
        init = await fetchVerificationInit(app.initData);
      } catch {
        renderScreen(root, "error", lang);
        return;
      }
      await mountDetector(app, root, lang, init);
      return;
    }
    if (err instanceof CalendarApiError) {
      if (err.status === 409) {
        renderScreen(root, "already-verified", lang);
      } else if (err.status === 503) {
        renderScreen(root, "unavailable", lang);
      } else {
        renderScreen(root, "error", lang);
      }
    } else {
      renderScreen(root, "error", lang);
    }
    // Surface a Close MainButton so the user has an obvious exit when the
    // initial GET fails — nothing mounted, so they're staring at a dead screen
    // otherwise.
    const button = app.MainButton;
    button.setText(tr(lang, "verifyMiniAppCloseBtn"));
    button.onClick(() => app.close());
    button.show();
    return;
  }

  await mountDetector(app, root, lang, init);
}

async function mountDetector(
  app: NonNullable<typeof window.Telegram>["WebApp"],
  root: HTMLElement,
  lang: Lang,
  init: VerificationInit,
): Promise<void> {
  const deps = buildDeps(app, root, lang, init.sessionId);

  // The detector bundle (Amplify + its Rekognition streaming client) is heavy,
  // so it is only fetched once a session actually exists — a user who bounces
  // off the 409/503 screens never downloads it.
  const { mountLivenessDetector } = await import("./liveness-detector.js");

  root.innerHTML = `<div class="liveness-mount" id="liveness-mount"></div>`;
  const mount = document.getElementById("liveness-mount");
  if (!mount) {
    void handleError({ message: "liveness mount missing" }, deps);
    return;
  }

  mountLivenessDetector(mount, {
    sessionId: init.sessionId,
    region: init.region,
    credentials: init.credentials,
    // `/init` returns the user's own `User.language`, which is more
    // trustworthy than the URL param or the Telegram client locale.
    lang: init.language,
    onComplete: () => {
      void handleComplete(deps);
    },
    onCancel: () => {
      void handleCancel(deps);
    },
    onError: (message, detail) => {
      void handleError({ message, detail }, deps);
    },
  });
}

function buildDeps(
  app: NonNullable<typeof window.Telegram>["WebApp"],
  root: HTMLElement,
  lang: Lang,
  sessionId: string | null,
): HandlerDeps {
  // Conditional spread keeps `HapticFeedback` absent from the deps object
  // when the host client doesn't expose it — `exactOptionalPropertyTypes`
  // forbids assigning `T | undefined` to a `T?` field, and a missing key
  // is the semantic the handlers actually want (they `?.()` it anyway).
  return {
    initData: app.initData,
    lang,
    sessionId,
    app: {
      ...(app.HapticFeedback ? { HapticFeedback: app.HapticFeedback } : {}),
      close: () => app.close(),
      MainButton: app.MainButton,
    },
    render: (view) => renderScreen(root, view, lang),
    postEvent: postVerificationEvent,
  };
}

// Side-effect: run the bootstrap when this module is loaded as a page entry.
// In tests `window.Telegram` is absent — checking for it (instead of just
// `typeof window`) keeps the importer-side from mounting the detector or
// touching `document.getElementById`, which the test stubs intentionally
// don't provide.
if (
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof (document as Document).addEventListener === "function" &&
  (window as Window).Telegram !== undefined
) {
  // Defer to DOMContentLoaded so #root is present even if the script is
  // (unusually) placed in <head>. Cheap enough either way.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}
