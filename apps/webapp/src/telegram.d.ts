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
  ready(): void;
  expand(): void;
  close(): void;
  /** Send a string payload back to the bot and close the Web App. */
  sendData(data: string): void;
}

interface Window {
  Telegram: { WebApp: TelegramWebApp };
}
