import {
  fetchVerificationInit,
  postVerificationEvent,
  CalendarApiError,
  type VerificationInit,
} from "./api.js";
import { pickLang, tr, type Lang } from "./i18n.js";

/**
 * Verification Mini App entry point (Phase 6.3 — Persona embedded flow).
 *
 * UX flow:
 *   1. User taps "🟢 Verify now" on the bot's onboarding CTA. Telegram
 *      opens this page via `InlineKeyboardButton.web_app` inside the
 *      native WebView — no browser frame, no in-app browser handoff.
 *   2. `GET /v1/verification/mini-app/init` returns the Persona template
 *      / environment ids and the user's stable referenceId (= User.id).
 *   3. Persona Embedded SDK mounts inline in the iframe (#persona-mount).
 *      Selfie/document capture happens *inside* the Telegram WebView, so
 *      camera permissions piggyback on Telegram's pre-granted Mini App
 *      camera grant — no second permission prompt sequence.
 *   4. On a terminal SDK event (`onComplete` / `onCancel` / `onError`) we
 *      POST to `/v1/verification/mini-app/event`. `complete` triggers the
 *      bot's pull-fallback pipeline so the result DM lands even when
 *      Persona's webhook is delayed; cancel/error are best-effort logs.
 *
 * Trust boundary (re-emphasised):
 *   The Mini App NEVER writes `verified` / `rejected` directly. The HMAC
 *   webhook (routes/persona-webhook.ts) is the only path that can flip a
 *   user to `verified` — even the `complete` event handler only triggers
 *   a server-to-server check against Persona's REST API.
 *
 * Backwards-compat: if the Mini App fails to load entirely (offline mode,
 * blocked CDN, etc.) the bot's CTA falls back to the hosted-URL flow —
 * see handlers/onboarding/verification.ts.
 */

// ---------------------------------------------------------------------------
// Persona SDK type shim — minimal subset used by this Mini App. Imported as
// a global at runtime (`<script src="…/persona-v5.x.x.js">`). Pinned to v5
// in verification.html; this shim mirrors the v5 client constructor surface.
// ---------------------------------------------------------------------------
interface PersonaClient {
  open(): void;
  cancel?(): void;
  destroy?(): void;
}

interface PersonaCompleteEvent {
  inquiryId?: string;
  status?: string;
}

interface PersonaErrorEvent {
  message?: string;
  code?: string;
}

interface PersonaClientOptions {
  templateId: string;
  environmentId: string;
  referenceId: string;
  language?: string;
  frameAncestors?: string[];
  /** Where to render the iframe. Without it, Persona injects into <body>. */
  parent?: HTMLElement;
  onLoad?: () => void;
  onReady?: () => void;
  onEvent?: (name: string, meta?: unknown) => void;
  onComplete?: (event: PersonaCompleteEvent) => void;
  onCancel?: (event: { inquiryId?: string }) => void;
  onError?: (event: PersonaErrorEvent) => void;
}

interface PersonaGlobal {
  Client: new (opts: PersonaClientOptions) => PersonaClient;
}

declare global {
  interface Window {
    Persona?: PersonaGlobal;
  }
}

// ---------------------------------------------------------------------------
// Pure handlers — exported so verification.test.ts can drive them with
// mocked Telegram.WebApp + mocked POST endpoint without booting the whole
// page lifecycle.
// ---------------------------------------------------------------------------

export interface HandlerDeps {
  initData: string;
  lang: Lang;
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
  render: (view: "loading" | "finishing" | "error" | "success") => void;
  postEvent: typeof postVerificationEvent;
  closeDelayMs?: number;
}

export async function handleComplete(
  event: PersonaCompleteEvent,
  deps: HandlerDeps,
): Promise<void> {
  deps.render("finishing");
  deps.app.HapticFeedback?.notificationOccurred?.("success");
  try {
    await deps.postEvent(deps.initData, {
      kind: "complete",
      inquiryId: event.inquiryId ?? null,
      status: event.status ?? null,
    });
  } catch (err) {
    // The webhook is the source of truth for status anyway; a failed POST
    // here only loses the pull-fallback nudge. Log + carry on closing so
    // the user doesn't get stuck on the success screen forever.
    console.warn("[verification] /event complete POST failed", err);
  }
  // Brief delay so the success/finishing copy is visible before the WebView
  // dismisses — without it iOS dismisses too fast for the user to perceive.
  const delay = deps.closeDelayMs ?? 1500;
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
  event: PersonaErrorEvent,
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
  const button = deps.app.MainButton;
  if (button) {
    button.setText(tr(deps.lang, "verifyMiniAppCloseBtn"));
    button.onClick(() => deps.app.close());
    button.show();
  }
}

// ---------------------------------------------------------------------------
// Page-level rendering — swaps inner HTML of #root for the requested screen.
// Kept as a single function (not a component framework) because we only have
// 4 mutually-exclusive views and React would mean a 30KB+ bundle hit for
// a screen that's 95% Persona's iframe.
// ---------------------------------------------------------------------------

type Screen = "loading" | "finishing" | "error" | "success" | "already-verified" | "unavailable";

function renderScreen(root: HTMLElement, screen: Screen, lang: Lang): void {
  switch (screen) {
    case "loading":
      root.innerHTML = `
        <div class="screen">
          <div class="spinner" aria-hidden="true"></div>
          <p class="screen-text">${escapeHtml(tr(lang, "verifyMiniAppLoading"))}</p>
        </div>`;
      return;
    case "finishing":
      root.innerHTML = `
        <div class="screen">
          <div class="success-glyph">✅</div>
          <p class="screen-text">${escapeHtml(tr(lang, "verifyMiniAppFinishing"))}</p>
        </div>`;
      return;
    case "success":
      root.innerHTML = `
        <div class="screen">
          <div class="success-glyph">✅</div>
          <p class="screen-text">${escapeHtml(tr(lang, "verifyMiniAppFinishing"))}</p>
        </div>`;
      return;
    case "error":
      root.innerHTML = `
        <div class="screen">
          <div class="error-glyph">⚠️</div>
          <p class="screen-title">${escapeHtml(tr(lang, "verifyMiniAppError"))}</p>
        </div>`;
      return;
    case "already-verified":
      root.innerHTML = `
        <div class="screen">
          <div class="success-glyph">✅</div>
          <p class="screen-text">${escapeHtml(tr(lang, "verifyMiniAppAlreadyVerified"))}</p>
        </div>`;
      return;
    case "unavailable":
      root.innerHTML = `
        <div class="screen">
          <p class="screen-text">${escapeHtml(tr(lang, "verifyMiniAppNotConfigured"))}</p>
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
  // Bot API 8.0+ — immersive fullscreen for KYC capture. Older clients
  // gracefully fall through to expanded-but-not-fullscreen.
  try {
    app.requestFullscreen?.();
  } catch (err) {
    console.warn("[verification] requestFullscreen failed (non-fatal)", err);
  }
  // Catch accidental swipe-down dismissals during selfie capture.
  try {
    (app as unknown as { enableClosingConfirmation?: () => void }).enableClosingConfirmation?.();
  } catch {
    // SDK without that helper — ignore, not all builds expose it.
  }
  // Back button as an explicit "I want out" affordance during the flow.
  app.BackButton?.show();
  app.BackButton?.onClick(() => {
    void handleCancel(buildDeps(app, root, lang));
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
    // initial GET fails — Persona never mounted, so they're staring at a
    // dead screen otherwise.
    const button = app.MainButton;
    button.setText(tr(lang, "verifyMiniAppCloseBtn"));
    button.onClick(() => app.close());
    button.show();
    return;
  }

  // Lightweight console-only diagnostic logger. Useful when remote-
  // debugging the Mini App in iOS Telegram WebView via Safari Web
  // Inspector or Android Chrome via `chrome://inspect`. Avoid coupling
  // diagnostics to the /event endpoint — sending every Persona lifecycle
  // event to the server as a synthetic "error" floods bot logs and makes
  // real failures hard to spot.
  const debugLog = (stage: string, extra?: unknown): void => {
    console.log("[verification]", stage, extra ?? "");
  };

  debugLog("init-ok", {
    templateId: init.templateId.slice(0, 12) + "…",
    environmentId: init.environmentId.slice(0, 12) + "…",
    language: init.language,
    hasPersonaGlobal: typeof window.Persona,
    location: location.origin,
    tgVersion: app.version ?? "unknown",
    tgPlatform: app.platform ?? "unknown",
  });

  if (!window.Persona) {
    // SDK script tag failed to load — same dead-screen risk; show the error
    // card with Close-button affordance.
    debugLog("persona-global-missing");
    renderScreen(root, "error", lang);
    const button = app.MainButton;
    button.setText(tr(lang, "verifyMiniAppCloseBtn"));
    button.onClick(() => app.close());
    button.show();
    return;
  }

  // Persona SDK v5 on mobile injects an overlay and applies
  // `body > *:not(#persona-widget-id) { display: none }` once `client.open()`
  // fires. If we mount Persona inside `#root` (a `body > *` child) that
  // selector also hides the Persona overlay itself. Letting Persona default
  // to mounting at `document.body` keeps the overlay rule consistent.
  //
  // We keep the loading screen visible inside `#root` until `onReady`
  // confirms the SDK actually mounted. On `onReady` we clear `#root` so
  // only Persona's body-level overlay remains.
  //
  // Diagnostic message-bus listener so we can see Persona's postMessage
  // traffic from inside the user's WebView. Forwarded server-side via
  // debugLog so bot logs surface what the browser console shows.
  window.addEventListener("message", (e) => {
    if (typeof e.origin === "string" && e.origin.includes("persona")) {
      debugLog("persona-postmessage", {
        origin: e.origin,
        data: typeof e.data === "object" ? Object.keys((e.data as object) ?? {}) : String(e.data),
      });
    }
  });

  // Also probe any iframe that Persona injects so we can see its src/load/error
  // events server-side. We scan body and root for new iframes shortly after
  // SDK construction.
  setTimeout(() => {
    const iframes = document.querySelectorAll("iframe");
    debugLog("iframe-scan", {
      count: iframes.length,
      srcs: Array.from(iframes).map((f) => (f as HTMLIFrameElement).src.slice(0, 200)),
    });
  }, 1500);

  const deps = buildDeps(app, root, lang);

  let readyFired = false;
  const readyTimeout = window.setTimeout(() => {
    if (readyFired) return;
    debugLog("timeout-10s-no-onReady");
    void handleError(
      { message: "Persona SDK did not initialize within 10s" },
      deps,
    );
  }, 10_000);

  // No `parent`, no `frameAncestors` — defer to SDK defaults per Persona
  // v5 troubleshooting guidance for WebView contexts.
  debugLog("persona-client-construct-start");
  const client = new window.Persona.Client({
    templateId: init.templateId,
    environmentId: init.environmentId,
    referenceId: init.referenceId,
    language: init.language,
    onLoad: () => {
      debugLog("persona-onLoad");
    },
    onReady: () => {
      debugLog("persona-onReady");
      readyFired = true;
      window.clearTimeout(readyTimeout);
      root.innerHTML = "";
      client.open();
    },
    onEvent: (name: string, meta?: unknown) => {
      debugLog("persona-onEvent", { name, meta });
    },
    onComplete: (event) => {
      window.clearTimeout(readyTimeout);
      void handleComplete(event, deps);
    },
    onCancel: () => {
      window.clearTimeout(readyTimeout);
      void handleCancel(deps);
    },
    onError: (event) => {
      window.clearTimeout(readyTimeout);
      debugLog("persona-onError", event);
      void handleError(event, deps);
    },
  });
  debugLog("persona-client-construct-done", { hasClient: !!client });
}

function buildDeps(
  app: NonNullable<typeof window.Telegram>["WebApp"],
  root: HTMLElement,
  lang: Lang,
): HandlerDeps {
  // Conditional spread keeps `HapticFeedback` absent from the deps object
  // when the host client doesn't expose it — `exactOptionalPropertyTypes`
  // forbids assigning `T | undefined` to a `T?` field, and a missing key
  // is the semantic the handlers actually want (they `?.()` it anyway).
  return {
    initData: app.initData,
    lang,
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
// `typeof window`) keeps the importer-side from instantiating the SDK or
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
