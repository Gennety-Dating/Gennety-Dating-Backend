/**
 * Minimal type shim for the Telegram Web App global. Mirrors the subset
 * used by the Calendar Mini App. Keeps us decoupled from `@twa-dev/sdk`
 * (not yet approved as a dependency — see AGENTS.md).
 *
 * Reference: https://core.telegram.org/bots/webapps
 */

interface TelegramWebAppDeviceStorage {
  setItem(key: string, value: string, callback?: (err: string | null, ok: boolean) => void): void;
  getItem(key: string, callback: (err: string | null, value: string | null) => void): void;
  removeItem(key: string, callback?: (err: string | null, ok: boolean) => void): void;
  clear(callback?: (err: string | null, ok: boolean) => void): void;
}

/**
 * Telegram-native bottom button. Used as the "Confirm" / "Send" CTA across
 * Mini Apps: `sendData` is silently a no-op when the Mini App is opened via
 * inline keyboard, so we POST to the bot's public API on MainButton tap.
 */
interface TelegramWebAppMainButton {
  text: string;
  isVisible: boolean;
  isActive: boolean;
  show(): void;
  hide(): void;
  enable(): void;
  disable(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
  setText(text: string): void;
  onClick(handler: () => void): void;
  offClick(handler: () => void): void;
}

/** Telegram-native back button shown in the Mini App header. */
interface TelegramWebAppBackButton {
  isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(handler: () => void): void;
  offClick(handler: () => void): void;
}

/**
 * Telegram haptic feedback API (Bot API 6.1+). Best-effort: a no-op on
 * desktop / web. We probe `Telegram.WebApp.HapticFeedback` before calling.
 */
interface TelegramHapticFeedback {
  impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
  notificationOccurred(type: "error" | "success" | "warning"): void;
  selectionChanged(): void;
}

/**
 * Safe-area inset reported by Telegram (Bot API 8.0+). `safeAreaInset` is the
 * device inset (notch / rounded corners); `contentSafeAreaInset` is the extra
 * reserve taken by Telegram's own chrome (close ×, menu ⋯) in fullscreen mode.
 */
interface TelegramSafeAreaInset {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface TelegramWebApp {
  /** Raw init data — contains user, auth_date, hash, start_param, etc. */
  initData: string;
  /** Parsed init data. `start_param` is the value passed via the t.me link. */
  initDataUnsafe: {
    start_param?: string;
    user?: { id: number; first_name: string; language_code?: string };
  };
  /**
   * Telegram theme tokens. Keys are kebab-cased CSS variables on
   * `<html>` (--tg-theme-bg-color, --tg-theme-text-color, etc.); we read
   * them via `getComputedStyle` rather than this object so the values
   * survive theme switches without manual rebinding.
   */
  themeParams?: Record<string, string | undefined>;
  colorScheme?: "light" | "dark";
  version?: string;
  platform?: string;
  isFullscreen?: boolean;
  /** Device safe-area inset (notch / rounded corners). */
  safeAreaInset?: TelegramSafeAreaInset;
  /**
   * Content inset accounting for Telegram's own chrome (close ×, menu ⋯) in
   * fullscreen mode. Not covered by `env(safe-area-inset-*)`.
   */
  contentSafeAreaInset?: TelegramSafeAreaInset;
  /** Subscribe to a Web App event, e.g. `contentSafeAreaChanged`. */
  onEvent?(event: string, handler: () => void): void;
  /** Unsubscribe from a Web App event. */
  offEvent?(event: string, handler: () => void): void;
  /**
   * DeviceStorage (Bot API 9.0) — per-user, per-bot persistent key/value.
   * Survives swipe-down dismissal of the Web App.
   */
  DeviceStorage: TelegramWebAppDeviceStorage;
  MainButton: TelegramWebAppMainButton;
  BackButton?: TelegramWebAppBackButton;
  HapticFeedback?: TelegramHapticFeedback;
  ready(): void;
  expand(): void;
  isVersionAtLeast?(version: string): boolean;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  requestFullscreen?(): void;
  exitFullscreen?(): void;
  lockOrientation?(): void;
  unlockOrientation?(): void;
  close(): void;
  /** Send a string payload back to the bot and close the Web App. */
  sendData(data: string): void;
  /** Native modal alert — used to surface POST errors to the user. */
  showAlert(message: string, callback?: () => void): void;
  /** Native confirm popup (Bot API 6.2+) — OK/Cancel; callback gets `true` on OK. */
  showConfirm?(message: string, callback?: (confirmed: boolean) => void): void;
  /**
   * Request the user's phone number (Bot API 6.9+). Shows a native consent
   * popup; on accept Telegram delivers the contact to the BOT as a trusted
   * `message.contact` (the number is NOT returned to JS). The callback receives
   * whether the user shared. The general-track onboarding gate uses this for
   * phone verification (Registration v2).
   */
  requestContact?(callback?: (shared: boolean) => void): void;
  /**
   * Open a Telegram invoice link (Bot API 6.1+) — used for native Telegram
   * Stars (XTR) payments inside the Mini App. `url` comes from the server's
   * `createInvoiceLink`. The callback fires with the terminal status; the wallet
   * / date-gate itself is settled server-side by the bot's `successful_payment`
   * handler.
   */
  openInvoice?(
    url: string,
    callback?: (status: "paid" | "cancelled" | "failed" | "pending") => void,
  ): void;
  /**
   * Open an external URL (Bot API 6.1+). Used for the public Premium venue
   * showcase — Telegram opens it in its in-app browser rather than the WebView.
   */
  openLink?(url: string, options?: { try_instant_view?: boolean }): void;
}

interface Window {
  Telegram: { WebApp: TelegramWebApp };
}
