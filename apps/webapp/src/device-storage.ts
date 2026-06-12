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

// Onboarding visual-animation progress. There is one active onboarding run per
// user, so a static key (DeviceStorage is already per-bot/per-user) is enough.
const ONBOARDING_VISUAL_KEY = "gennety.onboarding.visual";

// Snapshot of the peer's slot set at the user's last successful save.
// Used to NEW-badge slots the peer has added since the user last "acted".
function peerSeenKey(matchId: string): string {
  return `${NS}.match.${matchId}.peer-seen`;
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
      return Array.isArray(parsed) && parsed.every((x) => typeof x === "string")
        ? normalizeIsoList(parsed)
        : null;
    } catch {
      return null;
    }
  }
  return normalizeIsoList([raw]);
}

export async function savePeerSeen(matchId: string, isos: string[]): Promise<void> {
  const value = JSON.stringify(isos);
  const ds = storage();
  if (!ds) {
    try {
      window.localStorage.setItem(peerSeenKey(matchId), value);
    } catch {
      // ignore
    }
    return;
  }
  await new Promise<void>((resolve) => {
    ds.setItem(peerSeenKey(matchId), value, (err) => {
      if (err) console.warn("DeviceStorage setItem failed:", err);
      resolve();
    });
  });
}

export async function loadPeerSeen(matchId: string): Promise<string[] | null> {
  const ds = storage();
  const raw = ds
    ? await new Promise<string | null>((resolve) => {
        ds.getItem(peerSeenKey(matchId), (err, value) => {
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
          return window.localStorage.getItem(peerSeenKey(matchId));
        } catch {
          return null;
        }
      })();

  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
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

/**
 * Persist the user's current position in the onboarding visual animation so a
 * swipe-away-and-return resumes on the same scene instead of replaying from 0.
 * Stored as a plain integer (scene index, or the VISUAL_DONE sentinel).
 */
export async function saveOnboardingProgress(progress: number): Promise<void> {
  const value = String(Math.floor(progress));
  const ds = storage();
  if (!ds) {
    try {
      window.localStorage.setItem(ONBOARDING_VISUAL_KEY, value);
    } catch {
      // ignore
    }
    return;
  }
  await new Promise<void>((resolve) => {
    ds.setItem(ONBOARDING_VISUAL_KEY, value, (err) => {
      if (err) console.warn("DeviceStorage setItem failed:", err);
      resolve();
    });
  });
}

export async function loadOnboardingProgress(): Promise<number | null> {
  const ds = storage();
  const raw = ds
    ? await new Promise<string | null>((resolve) => {
        ds.getItem(ONBOARDING_VISUAL_KEY, (err, value) => {
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
          return window.localStorage.getItem(ONBOARDING_VISUAL_KEY);
        } catch {
          return null;
        }
      })();

  if (raw === null || raw.trim() === "") return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function clearOnboardingProgress(): Promise<void> {
  const ds = storage();
  if (!ds) {
    try {
      window.localStorage.removeItem(ONBOARDING_VISUAL_KEY);
    } catch {
      // ignore
    }
    return;
  }
  await new Promise<void>((resolve) => {
    ds.removeItem(ONBOARDING_VISUAL_KEY, () => resolve());
  });
}

function normalizeIsoList(values: string[]): string[] | null {
  const normalized = values.filter((value) => {
    if (value.trim() === "") return false;
    return !Number.isNaN(new Date(value).getTime());
  });
  return normalized.length > 0 ? normalized : null;
}
