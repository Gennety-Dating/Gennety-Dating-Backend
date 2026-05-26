/**
 * Thin Promise wrapper around Telegram.WebApp.DeviceStorage.
 *
 * DeviceStorage (Bot API 9.0) is a per-bot, per-user key/value store that
 * survives the user swiping the Web App window away — useful so a
 * mid-edit selection isn't lost on accidental dismiss.
 *
 * The calendar uses a *set* of ISO timestamps now (the user can mark
 * many slots), so we serialise as JSON. Legacy single-string values
 * from older bundles are tolerated transparently for backwards-compat.
 */

const NS = "gennety.calendar";

function storage(): TelegramWebAppDeviceStorage | null {
  return window.Telegram?.WebApp?.DeviceStorage ?? null;
}

function key(matchId: string): string {
  return `${NS}.match.${matchId}`;
}

export async function savePickedSet(matchId: string, isos: string[]): Promise<void> {
  const value = JSON.stringify(isos);
  const ds = storage();
  if (!ds) {
    try {
      window.localStorage.setItem(key(matchId), value);
    } catch {
      // ignore
    }
    return;
  }
  await new Promise<void>((resolve) => {
    ds.setItem(key(matchId), value, (err) => {
      if (err) console.warn("DeviceStorage setItem failed:", err);
      resolve();
    });
  });
}

export async function loadPickedSet(matchId: string): Promise<string[] | null> {
  const ds = storage();
  const raw = ds
    ? await new Promise<string | null>((resolve) => {
        ds.getItem(key(matchId), (err, value) => {
          if (err) {
            console.warn("DeviceStorage getItem failed:", err);
            resolve(null);
            return;
          }
          resolve(value ?? null);
        });
      })
    : (() => {
        try {
          return window.localStorage.getItem(key(matchId));
        } catch {
          return null;
        }
      })();

  if (raw === null) return null;
  // Legacy: a single ISO string from the previous Mini App bundle.
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.every((x) => typeof x === "string") ? parsed : null;
    } catch {
      return null;
    }
  }
  return [raw];
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
