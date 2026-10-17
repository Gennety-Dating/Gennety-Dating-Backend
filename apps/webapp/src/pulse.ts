import { apiBase, apiFetch } from "./api.js";

/**
 * Pulse — the Mini App half of product analytics
 * (docs/product/domains/pulse-analytics.md §2–§4).
 *
 * Screens, visible time on them and taps, batched to `POST /v1/client/events`
 * under the same `Authorization: tma <initData>` every other call here uses.
 * No SDK and no dependency: the whole point of Pulse is that this data never
 * leaves our own API and Postgres (spec §1.2).
 *
 * Consent is the load-bearing part, and it has four states:
 *
 *   - `pending`  — onboarding before the consent screen is answered. Events are
 *                  held in MEMORY only (spec §2.3): nothing is sent, nothing is
 *                  written to storage, not even the install id.
 *   - `granted`  — the user ticked the box (or /state says they did earlier).
 *                  The held queue goes out, then every 15 s.
 *   - `denied`   — the box was left empty. The queue is wiped and every later
 *                  event is dropped on the floor for this page load.
 *   - `server`   — every non-onboarding page, which does not know the user's
 *                  choice. It sends, and the SERVER decides: an identified user
 *                  without consent gets `consent: false` back and no row is
 *                  written (spec §2.4), which stops this tracker for the rest of
 *                  the page load. A 404 means the feature flag is off — same stop.
 *
 * The demo bot never collects (spec §1.7): `isDemoBuild()` turns the whole
 * module into a no-op, so the demo bundle cannot send even a first batch.
 */

/**
 * Screens that record `tap` / `dead_tap` (spec §3.5).
 *
 * Mirrors the `tracksTaps: true` Mini App entries of
 * `packages/shared/src/pulse-screens.ts` — `apps/webapp` deliberately does not
 * depend on `@gennety/shared`, so this is a copy, held to the original by
 * `pulse.test.ts`.
 */
export const PULSE_TAP_SCREENS: ReadonlySet<string> = new Set([
  "mini_onb_visual",
  "mini_onb_detail",
  "mini_onb_consent",
  "mini_onb_language",
  "mini_onb_path",
  "mini_onb_email",
  "mini_onb_otp",
  "mini_onb_phone",
  "mini_onb_city",
  "mini_onb_theme",
  "mini_onb_basics",
]);

export type PulseExit = "next" | "back" | "background" | "dismiss";
export type PulseConsent = "pending" | "granted" | "denied" | "server";

export interface PulseEvent {
  id: string;
  type: "screen_view" | "screen_left" | "tap" | "dead_tap";
  at: string;
  session?: string;
  props: Record<string, string | number>;
}

export interface PulseAppInfo {
  version: string;
  build: string;
  os: string;
  locale: string;
}

/** What one POST came back with, reduced to what the tracker acts on. */
export interface PulseSendResult {
  status: number;
  consent?: boolean;
}

export interface PulseDeps {
  /** POST one batch. Throws on a network failure. */
  send(body: string, keepalive: boolean): Promise<PulseSendResult>;
  /** Wall clock, ms. */
  now(): number;
  uuid(): string;
  app: PulseAppInfo;
  /**
   * Install id already on disk, if any. When there is none, the tracker mints
   * one in memory and asks `persist` to keep it only once collection is
   * allowed — writing an identifier to someone's device before they agreed to
   * anything is exactly what §25 TDDDG is about.
   */
  storedInstallId: string | null;
  session: string;
  /** Called once collection is known to be allowed. */
  persist?(installId: string, session: string): void;
}

/** Spec §3.4: at most this many events per POST (the server allows more). */
export const PULSE_BATCH_MAX = 50;
/** Flush cadence while the page is open. */
export const PULSE_FLUSH_MS = 15_000;
/**
 * Memory ceiling. A user who never answers the consent screen, or a network
 * that never comes back, must not grow this without bound; the oldest go first
 * because the newest screen is the one a finding would be about.
 */
export const PULSE_QUEUE_MAX = 500;
/**
 * The keepalive budget is 64 KB for ALL in-flight keepalive requests of the
 * page, so the unload burst is capped well under it (~250 B per event).
 */
const KEEPALIVE_BATCHES_MAX = 4;
/** Element ids and screen keys share the server's prop-value grammar (spec §1.5). */
const PULSE_ID = /^[a-z0-9_]{1,32}$/;

/** Round to 3 decimals and clamp into 0…1 (spec §3.4 / §3.6). */
export function normalizeCoord(position: number, extent: number): number {
  if (!Number.isFinite(position) || !Number.isFinite(extent) || extent <= 0) return 0;
  const ratio = Math.min(Math.max(position / extent, 0), 1);
  return Math.round(ratio * 1000) / 1000;
}

/**
 * The slice of a DOM element the tap classifier reads. Kept structural so the
 * classification is testable without a DOM (this package's tests run in node).
 */
export interface PulseNode {
  tagName: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  parentElement: PulseNode | null;
}

const INTERACTIVE_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "LABEL"]);

/**
 * What one pointerdown hit:
 *   - `{ kind: "tap", element }` — an element (or its ancestor) is named by
 *     `data-pulse="<id>"`; the name wins even inside a generic control;
 *   - `{ kind: "control" }` — some other interactive element: a real touch on a
 *     control we did not name, which is neither worth a tap nor a dead tap;
 *   - `{ kind: "dead" }` — nothing interactive anywhere up the chain. A pile of
 *     these on one spot is what tells us people expect something there.
 */
export type PulseTapTarget = { kind: "tap"; element: string } | { kind: "control" } | { kind: "dead" };

export function classifyTapTarget(target: PulseNode | null): PulseTapTarget {
  let interactive = false;
  for (let node = target; node; node = node.parentElement) {
    const named = node.getAttribute("data-pulse");
    if (named && PULSE_ID.test(named)) return { kind: "tap", element: named };
    if (
      !interactive &&
      (INTERACTIVE_TAGS.has(node.tagName.toUpperCase()) ||
        node.getAttribute("role") === "button" ||
        node.hasAttribute("onclick"))
    ) {
      // Keep walking: a `data-pulse` further up still names this touch.
      interactive = true;
    }
  }
  return interactive ? { kind: "control" } : { kind: "dead" };
}

/**
 * The tracker itself — no DOM, no globals, every effect behind `deps`, so the
 * queue, the gating and the screen clock are unit-testable as plain logic. The
 * browser wiring is `bootPulse` below.
 */
export class PulseTracker {
  private queue: PulseEvent[] = [];
  private consent: PulseConsent;
  /** Set for good by `consent: false` or a 404; nothing is queued after it. */
  private stopped = false;
  private inFlight = false;
  private readonly installId: string;
  private persisted = false;

  private screen: string | null = null;
  private visibleMs = 0;
  /** Start of the current visible stretch; null while the page is hidden. */
  private visibleSince: number | null = null;
  private viewAt = 0;
  private firstActionMs: number | null = null;

  constructor(
    private readonly deps: PulseDeps,
    consent: PulseConsent,
  ) {
    this.consent = consent;
    this.installId = deps.storedInstallId ?? deps.uuid();
  }

  get pending(): readonly PulseEvent[] {
    return this.queue;
  }

  get currentScreen(): string | null {
    return this.screen;
  }

  get isStopped(): boolean {
    return this.stopped || this.consent === "denied";
  }

  /** The onboarding consent answer, or the user's stored choice from /state. */
  setConsent(optIn: boolean): void {
    if (this.consent === "denied" || this.stopped) return;
    if (!optIn) {
      this.consent = "denied";
      this.queue = [];
      return;
    }
    this.consent = "granted";
    this.persistOnce();
    void this.flush();
  }

  /**
   * Move to `screen`. Closes the current one with `exit` first; a repeat of the
   * same key is not a transition (a basics sub-step or the next intro scene
   * stays on one screen key) and records nothing.
   */
  navigate(screen: string, exit: PulseExit = "next"): void {
    if (!PULSE_ID.test(screen) || screen === this.screen) return;
    const from = this.screen;
    if (from) this.leave(exit);
    this.screen = screen;
    const now = this.deps.now();
    this.viewAt = now;
    this.visibleMs = 0;
    this.visibleSince = now;
    this.firstActionMs = null;
    this.push("screen_view", from ? { screen, from } : { screen });
  }

  /** Close the current screen without opening another (the page is going away). */
  leave(exit: PulseExit): void {
    const screen = this.screen;
    if (!screen) return;
    const now = this.deps.now();
    const dwell = this.visibleMs + (this.visibleSince === null ? 0 : now - this.visibleSince);
    const props: Record<string, string | number> = {
      screen,
      exit,
      dwell_ms: Math.max(0, Math.min(Math.round(dwell), 86_400_000)),
    };
    if (this.firstActionMs !== null) props.first_action_ms = this.firstActionMs;
    this.push("screen_left", props);
    this.screen = null;
    this.visibleSince = null;
    this.visibleMs = 0;
  }

  /**
   * Visibility drives the screen clock: `dwell_ms` is foreground time only
   * (spec §3.4), so time behind another Telegram chat is not counted as
   * someone thinking about this screen.
   */
  setVisible(visible: boolean): void {
    const now = this.deps.now();
    if (visible) {
      if (this.visibleSince === null && this.screen) this.visibleSince = now;
      return;
    }
    if (this.visibleSince !== null) {
      this.visibleMs += now - this.visibleSince;
      this.visibleSince = null;
    }
  }

  /** One pointerdown, already in viewport px. */
  pointer(clientX: number, clientY: number, width: number, height: number, target: PulseTapTarget): void {
    const screen = this.screen;
    if (!screen) return;
    if (this.firstActionMs === null) {
      this.firstActionMs = Math.max(0, Math.round(this.deps.now() - this.viewAt));
    }
    if (!PULSE_TAP_SCREENS.has(screen) || target.kind === "control") return;
    const x = normalizeCoord(clientX, width);
    const y = normalizeCoord(clientY, height);
    if (target.kind === "tap") this.push("tap", { screen, element: target.element, x, y });
    else this.push("dead_tap", { screen, x, y });
  }

  /**
   * Send what is queued. `keepalive` is the unload path: fire every batch at
   * once (the page may be gone before an await returns) and never retry.
   */
  async flush(keepalive = false): Promise<void> {
    if (!this.canSend() || this.queue.length === 0) return;
    if (keepalive) {
      for (let i = 0; i < KEEPALIVE_BATCHES_MAX && this.queue.length > 0; i += 1) {
        const batch = this.queue.splice(0, PULSE_BATCH_MAX);
        void this.deps.send(this.body(batch), true).catch(() => undefined);
      }
      return;
    }
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      while (this.canSend() && this.queue.length > 0) {
        const batch = this.queue.splice(0, PULSE_BATCH_MAX);
        let result: PulseSendResult;
        try {
          result = await this.deps.send(this.body(batch), false);
        } catch {
          // Network failure: put the batch back for the next tick.
          this.requeue(batch);
          return;
        }
        if (result.status === 404 || result.consent === false) {
          // Flag off, or a user who never agreed: stop for this page load.
          this.stop();
          return;
        }
        if (result.status >= 500 || result.status === 429) {
          this.requeue(batch);
          return;
        }
        // 2xx, or a 4xx that would only repeat itself — either way the batch
        // is done. On success in `server` mode collection is now known to be
        // allowed, which is the earliest the install id may touch the disk.
        if (result.status < 300) this.persistOnce();
      }
    } finally {
      this.inFlight = false;
    }
  }

  private canSend(): boolean {
    return !this.stopped && (this.consent === "granted" || this.consent === "server");
  }

  private stop(): void {
    this.stopped = true;
    this.queue = [];
  }

  private requeue(batch: PulseEvent[]): void {
    this.queue = [...batch, ...this.queue].slice(-PULSE_QUEUE_MAX);
  }

  private persistOnce(): void {
    if (this.persisted) return;
    this.persisted = true;
    this.deps.persist?.(this.installId, this.deps.session);
  }

  private push(type: PulseEvent["type"], props: Record<string, string | number>): void {
    if (this.isStopped) return;
    this.queue.push({
      id: this.deps.uuid(),
      type,
      at: new Date(this.deps.now()).toISOString(),
      session: this.deps.session,
      props,
    });
    if (this.queue.length > PULSE_QUEUE_MAX) this.queue.splice(0, this.queue.length - PULSE_QUEUE_MAX);
  }

  private body(events: PulseEvent[]): string {
    return JSON.stringify({ installId: this.installId, platform: "miniapp", app: this.deps.app, events });
  }
}

// ---------------------------------------------------------------------------
// Browser wiring
// ---------------------------------------------------------------------------

const INSTALL_KEY = "gennety.pulse.install";
const SESSION_KEY = "gennety.pulse.session";
/** Spec §3.2: a new session after 30 minutes away. */
const SESSION_IDLE_MS = 30 * 60 * 1000;
/**
 * A `pagehide` within this long of the page going hidden is the user closing
 * the Mini App (`dismiss`); later than that, the app had been sitting in the
 * background and Telegram or the OS discarded it (`background`).
 */
const BACKGROUND_EXIT_MS = 1000;

/**
 * The demo bundle is the same source built against the demo API
 * (docs/product/demo-mode.md, `scripts/deploy-demo.sh`), so the API base is the
 * only thing that tells it apart at runtime.
 */
export function isDemoBuild(base: string = apiBase): boolean {
  return /\/\/demo-api\./.test(base);
}

function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Older WebViews: RFC 4122 v4 from getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readStorage(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    // Private mode / disabled storage: run on in-memory ids.
    return null;
  }
}

function writeStorage(store: () => Storage, key: string, value: string): void {
  try {
    store().setItem(key, value);
  } catch {
    // Same as above — losing the id costs continuity, not correctness.
  }
}

/** Reuse this tab's session while it was active in the last 30 minutes. */
function resumeSession(now: number): string | null {
  const raw = readStorage(() => sessionStorage, SESSION_KEY);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as { id?: unknown; at?: unknown };
    if (typeof saved.id === "string" && typeof saved.at === "number" && now - saved.at < SESSION_IDLE_MS) {
      return saved.id;
    }
  } catch {
    // A corrupt entry is just a new session.
  }
  return null;
}

let tracker: PulseTracker | null = null;

/**
 * Start collection for this page load. Returns null — and every helper below
 * becomes a no-op — in the demo bundle and outside Telegram (dev previews,
 * a plain browser), where there is no initData to attribute a batch with.
 */
function bootPulse(consent: PulseConsent): PulseTracker | null {
  if (tracker) return tracker;
  // Entry modules call this at import time, and some are imported by tests
  // that run in node, where there is no window at all.
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  // Analytics must never be the reason a page fails to open: an exotic
  // WebView (or a test's stub DOM) missing some API just runs without Pulse.
  try {
    tracker = createPulse(consent);
  } catch {
    tracker = null;
  }
  return tracker;
}

function createPulse(consent: PulseConsent): PulseTracker | null {
  const app = window.Telegram?.WebApp;
  const initData = app?.initData;
  if (!initData || isDemoBuild()) return null;

  const now = Date.now();
  const session = resumeSession(now) ?? uuid();
  const lang = document.documentElement.lang || navigator.language || "";
  // Flips once collection is known to be allowed; until then nothing of
  // Pulse's touches storage (see `PulseDeps.storedInstallId`).
  let allowed = false;
  const t = new PulseTracker(
    {
      now: () => Date.now(),
      uuid,
      session,
      storedInstallId: readStorage(() => localStorage, INSTALL_KEY),
      app: {
        version: __WEBAPP_VERSION__,
        build: __WEBAPP_BUILD__,
        os: (app.platform ?? "unknown").slice(0, 32),
        locale: lang.slice(0, 32),
      },
      persist: (installId) => {
        allowed = true;
        writeStorage(() => localStorage, INSTALL_KEY, installId);
        writeStorage(() => sessionStorage, SESSION_KEY, JSON.stringify({ id: session, at: Date.now() }));
      },
      send: async (body, keepalive) => {
        const init: RequestInit = {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `tma ${initData}` },
          body,
        };
        // keepalive requests are exempt from apiFetch's abort on purpose: the
        // page is unloading, and the platform finishes them on its own.
        const res = keepalive
          ? await fetch(`${apiBase}/v1/client/events`, { ...init, keepalive: true })
          : await apiFetch(`${apiBase}/v1/client/events`, init);
        if (!res.ok) return { status: res.status };
        const json = (await res.json().catch(() => null)) as { consent?: unknown } | null;
        return json?.consent === false ? { status: res.status, consent: false } : { status: res.status };
      },
    },
    consent,
  );

  const interval = setInterval(() => void t.flush(), PULSE_FLUSH_MS);
  let hiddenAt: number | null = document.visibilityState === "hidden" ? now : null;
  if (hiddenAt !== null) t.setVisible(false);

  document.addEventListener("visibilitychange", () => {
    const hidden = document.visibilityState === "hidden";
    hiddenAt = hidden ? Date.now() : null;
    t.setVisible(!hidden);
    // Hidden may be the last moment this page runs (Telegram can discard a
    // backgrounded WebView without a pagehide), so it is an unload flush.
    if (hidden) void t.flush(true);
    else if (allowed) writeStorage(() => sessionStorage, SESSION_KEY, JSON.stringify({ id: session, at: Date.now() }));
  });
  window.addEventListener("pagehide", () => {
    const exit: PulseExit = hiddenAt !== null && Date.now() - hiddenAt > BACKGROUND_EXIT_MS ? "background" : "dismiss";
    t.leave(exit);
    void t.flush(true);
    clearInterval(interval);
  });
  // Capture phase: a control that stops propagation still counts as touched.
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target =
        typeof Element !== "undefined" && event.target instanceof Element
          ? (event.target as unknown as PulseNode)
          : null;
      t.pointer(event.clientX, event.clientY, window.innerWidth, window.innerHeight, classifyTapTarget(target));
    },
    { capture: true, passive: true },
  );
  return t;
}

/**
 * One-line entry for a Mini App page that does not know the user's analytics
 * choice: `startPulse("mini_calendar")`. Records the screen on load and its
 * exit on `pagehide`; the server's `consent: false` / 404 stops it.
 */
export function startPulse(screen: string): void {
  bootPulse("server")?.navigate(screen);
}

/**
 * Onboarding entry: collection starts `pending` — held in memory until the
 * consent screen (or /state for someone who answered it before) decides.
 */
export function startOnboardingPulse(): void {
  bootPulse("pending");
}

export function pulseNavigate(screen: string, exit: PulseExit = "next"): void {
  tracker?.navigate(screen, exit);
}

export function setPulseConsent(optIn: boolean): void {
  tracker?.setConsent(optIn);
}
