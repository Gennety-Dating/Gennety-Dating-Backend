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
 * Telegram-native bottom button. Used as the "Confirm" CTA in the calendar:
 * `sendData` is silently a no-op when the Mini App is opened via inline
 * keyboard, so we POST to the bot's public API on MainButton tap instead.
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

interface TelegramWebApp {
  /** Raw init data — contains user, auth_date, hash, start_param, etc. */
  initData: string;
  /** Parsed init data. `start_param` is the value passed via the t.me link. */
  initDataUnsafe: {
    start_param?: string;
    user?: { id: number; first_name: string };
  };
  /**
   * DeviceStorage (Bot API 9.0) — per-user, per-bot persistent key/value.
   * Survives swipe-down dismissal of the Web App.
   */
  DeviceStorage: TelegramWebAppDeviceStorage;
  MainButton: TelegramWebAppMainButton;
  ready(): void;
  expand(): void;
  close(): void;
  /** Send a string payload back to the bot and close the Web App. */
  sendData(data: string): void;
  /** Native modal alert — used to surface POST errors to the user. */
  showAlert(message: string, callback?: () => void): void;
}

interface Window {
  Telegram: { WebApp: TelegramWebApp };
}
