import {
  fetchVerificationInit,
  postVerificationEvent,
  CalendarApiError,
  type VerificationInit,
} from "./api.js";
import { pickLang, tr, type Lang } from "./i18n.js";

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
    deps.app.HapticFeedback?.notificationOccurred?.("success");
  } catch (err) {
    // The check may well have passed; we just couldn't tell the server. Say so
    // honestly rather than showing a success tick we can't back up.
    console.warn("[verification] /event complete POST failed", err);
    deps.render("error");
    showCloseButton(deps);
    return;
  }
  // Brief delay so the success checkmark animation can play out before the
  // WebView dismisses — the disc-pop + tick-draw + halo settle in ~1s, so we
  // hold a beat past that. Without it iOS dismisses too fast to perceive.
  const delay = deps.closeDelayMs ?? 2200;
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
  event: { message?: string },
  deps: HandlerDeps,
): Promise<void> {
  deps.app.HapticFeedback?.notificationOccurred?.("error");
  try {
    await deps.postEvent(deps.initData, {
      kind: "error",
      message: event.message ?? null,
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
  | "loading"
  | "finishing"
  | "error"
  | "retry"
  | "success"
  | "already-verified"
  | "unavailable";

/**
 * Animated success checkmark — the "all done" moment after the check passes.
 *
 * Implemented as an inline animated SVG (no Lottie runtime, no CDN) so it can
 * never fail to load inside the Telegram WebView the way an external player or
 * JSON asset could, and adds zero bytes to the bundle. Visually it's the same
 * "classic ✅" beat: a green disc pops in with a slight overshoot, a white tick
 * strokes itself in, and a soft halo ring expands once and fades. The whole
 * thing settles in ~1s and honours `prefers-reduced-motion`.
 */
function successCheckMarkup(): string {
  return `
    <div class="check-anim" aria-hidden="true">
      <span class="check-anim__halo"></span>
      <svg class="check-anim__svg" viewBox="0 0 56 56" role="img">
        <circle class="check-anim__disc" cx="28" cy="28" r="26" />
        <path class="check-anim__tick" d="M17 29 l7.5 7.5 L40 21" />
      </svg>
    </div>`;
}

function successScreen(lang: Lang, textKey: Parameters<typeof tr>[1]): string {
  return `
    <div class="screen">
      ${successCheckMarkup()}
      <p class="screen-text check-caption">${escapeHtml(tr(lang, textKey))}</p>
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

export function renderScreen(root: HTMLElement, screen: Screen, lang: Lang): void {
  switch (screen) {
    case "loading":
      root.innerHTML = `
        <div class="screen">
          <div class="spinner" aria-hidden="true"></div>
          <p class="screen-text">${escapeHtml(tr(lang, "verifyMiniAppLoading"))}</p>
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

async function bootstrap(
  app: NonNullable<typeof window.Telegram>["WebApp"],
  root: HTMLElement,
  lang: Lang,
): Promise<void> {
  let init: VerificationInit;
  try {
    init = await fetchVerificationInit(app.initData);
  } catch (err) {
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
    onComplete: () => {
      void handleComplete(deps);
    },
    onCancel: () => {
      void handleCancel(deps);
    },
    onError: (message) => {
      void handleError({ message }, deps);
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
