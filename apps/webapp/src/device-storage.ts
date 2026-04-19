/**
 * Thin Promise wrapper around Telegram.WebApp.DeviceStorage.
 *
 * DeviceStorage (Bot API 9.0) is a per-bot, per-user key/value store that
 * survives the user swiping the Web App window away — which is exactly the
 * scenario PRODUCT_SPEC.md §3.3 calls out for iteration 3 of scheduling.
 *
 * We cache the user's in-progress selection under a key scoped by matchId
 * so two parallel matches can't clobber each other.
 */

const NS = "gennety.calendar";

function storage(): TelegramWebAppDeviceStorage | null {
  // `Telegram.WebApp.DeviceStorage` is only available inside Telegram —
  // during local `vite dev` in a browser it will be undefined.
  return window.Telegram?.WebApp?.DeviceStorage ?? null;
}

function key(matchId: string): string {
  return `${NS}.match.${matchId}`;
}

export async function savePickedIso(matchId: string, iso: string): Promise<void> {
  const ds = storage();
  if (!ds) {
    try {
      window.localStorage.setItem(key(matchId), iso);
    } catch {
      // ignore
    }
    return;
  }
  await new Promise<void>((resolve) => {
    ds.setItem(key(matchId), iso, (err) => {
      if (err) console.warn("DeviceStorage setItem failed:", err);
      resolve();
    });
  });
}

export async function loadPickedIso(matchId: string): Promise<string | null> {
  const ds = storage();
  if (!ds) {
    try {
      return window.localStorage.getItem(key(matchId));
    } catch {
      return null;
    }
  }
  return new Promise<string | null>((resolve) => {
    ds.getItem(key(matchId), (err, value) => {
      if (err) {
        console.warn("DeviceStorage getItem failed:", err);
        resolve(null);
        return;
      }
      resolve(value ?? null);
    });
  });
}

export async function clearPicked(matchId: string): Promise<void> {
  const ds = storage();
  if (!ds) {
    try {
      window.localStorage.removeItem(key(matchId));
    } catch {
      // ignore
    }
    return;
  }
  await new Promise<void>((resolve) => {
    ds.removeItem(key(matchId), () => resolve());
  });
}
