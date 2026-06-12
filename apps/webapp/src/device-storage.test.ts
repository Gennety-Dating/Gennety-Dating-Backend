import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Telegram WebApp global before importing
const mockSetItem = vi.fn((_key: string, _val: string, cb: (err: any) => void) => cb(null));
const mockGetItem = vi.fn((_key: string, cb: (err: any, val?: string) => void) =>
  cb(null, undefined),
);
const mockRemoveItem = vi.fn((_key: string, cb: () => void) => cb());

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).window = {
    Telegram: undefined,
    localStorage: {
      setItem: vi.fn(),
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
    },
  };
});

async function importModule() {
  return import("./device-storage.js");
}

describe("device-storage (no Telegram, falls back to localStorage)", () => {
  it("savePickedSet writes a JSON-encoded array to localStorage", async () => {
    const mod = await importModule();
    await mod.savePickedSet("match-1", [
      "2026-05-01T19:00:00.000Z",
      "2026-05-02T19:00:00.000Z",
    ]);

    expect((globalThis as any).window.localStorage.setItem).toHaveBeenCalledWith(
      "gennety.calendar.match.match-1",
      JSON.stringify(["2026-05-01T19:00:00.000Z", "2026-05-02T19:00:00.000Z"]),
    );
  });

  it("loadPickedSet parses a JSON array back into an ISO list", async () => {
    (globalThis as any).window.localStorage.getItem = vi.fn(() =>
      JSON.stringify(["2026-05-01T19:00:00.000Z"]),
    );
    const mod = await importModule();
    const result = await mod.loadPickedSet("match-1");
    expect(result).toEqual(["2026-05-01T19:00:00.000Z"]);
  });

  it("loadPickedSet drops empty or malformed cached values", async () => {
    (globalThis as any).window.localStorage.getItem = vi.fn(() =>
      JSON.stringify(["", "not-a-date", "2026-05-01T19:00:00.000Z"]),
    );
    const mod = await importModule();
    const result = await mod.loadPickedSet("match-1");
    expect(result).toEqual(["2026-05-01T19:00:00.000Z"]);
  });

  it("loadPickedSet returns null when a legacy cached value is empty", async () => {
    (globalThis as any).window.localStorage.getItem = vi.fn(() => "");
    const mod = await importModule();
    const result = await mod.loadPickedSet("match-1");
    expect(result).toBeNull();
  });

  it("loadPickedSet upgrades a legacy single-string value into a one-item array", async () => {
    // Older Mini App bundles wrote a bare ISO string. Backwards-compat path.
    (globalThis as any).window.localStorage.getItem = vi.fn(
      () => "2026-05-01T19:00:00.000Z",
    );
    const mod = await importModule();
    const result = await mod.loadPickedSet("match-1");
    expect(result).toEqual(["2026-05-01T19:00:00.000Z"]);
  });

  it("loadPickedSet returns null when key does not exist", async () => {
    const mod = await importModule();
    const result = await mod.loadPickedSet("nonexistent");
    expect(result).toBeNull();
  });

  it("clearPicked removes from localStorage", async () => {
    const mod = await importModule();
    await mod.clearPicked("match-1");

    expect((globalThis as any).window.localStorage.removeItem).toHaveBeenCalledWith(
      "gennety.calendar.match.match-1",
    );
  });
});

describe("device-storage (with Telegram DeviceStorage)", () => {
  beforeEach(() => {
    (globalThis as any).window = {
      Telegram: {
        WebApp: {
          DeviceStorage: {
            setItem: mockSetItem,
            getItem: mockGetItem,
            removeItem: mockRemoveItem,
          },
        },
      },
    };
  });

  it("savePickedSet writes a JSON array via DeviceStorage.setItem", async () => {
    const mod = await importModule();
    await mod.savePickedSet("match-2", ["2026-06-01T19:00:00.000Z"]);

    expect(mockSetItem).toHaveBeenCalledWith(
      "gennety.calendar.match.match-2",
      JSON.stringify(["2026-06-01T19:00:00.000Z"]),
      expect.any(Function),
    );
  });

  it("loadPickedSet parses the JSON array returned from DeviceStorage", async () => {
    mockGetItem.mockImplementation((_key, cb) =>
      cb(null, JSON.stringify(["2026-06-01T19:00:00.000Z"])),
    );
    const mod = await importModule();
    const result = await mod.loadPickedSet("match-2");
    expect(result).toEqual(["2026-06-01T19:00:00.000Z"]);
  });

  it("loadPickedSet returns null on DeviceStorage error", async () => {
    mockGetItem.mockImplementation((_key, cb) => cb(new Error("boom")));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importModule();
    const result = await mod.loadPickedSet("match-2");

    expect(result).toBeNull();
    warnSpy.mockRestore();
  });

  it("clearPicked calls DeviceStorage.removeItem", async () => {
    const mod = await importModule();
    await mod.clearPicked("match-2");

    expect(mockRemoveItem).toHaveBeenCalledWith(
      "gennety.calendar.match.match-2",
      expect.any(Function),
    );
  });
});

describe("onboarding visual progress (localStorage fallback)", () => {
  beforeEach(() => {
    (globalThis as any).window = {
      Telegram: undefined,
      localStorage: {
        setItem: vi.fn(),
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
      },
    };
  });

  it("saveOnboardingProgress writes a floored integer string", async () => {
    const mod = await importModule();
    await mod.saveOnboardingProgress(3.9);
    expect((globalThis as any).window.localStorage.setItem).toHaveBeenCalledWith(
      "gennety.onboarding.visual",
      "3",
    );
  });

  it("loadOnboardingProgress parses the stored integer", async () => {
    (globalThis as any).window.localStorage.getItem = vi.fn(() => "2");
    const mod = await importModule();
    expect(await mod.loadOnboardingProgress()).toBe(2);
  });

  it("loadOnboardingProgress returns null when unset", async () => {
    const mod = await importModule();
    expect(await mod.loadOnboardingProgress()).toBeNull();
  });

  it("loadOnboardingProgress returns null for a malformed value", async () => {
    (globalThis as any).window.localStorage.getItem = vi.fn(() => "not-a-number");
    const mod = await importModule();
    expect(await mod.loadOnboardingProgress()).toBeNull();
  });

  it("clearOnboardingProgress removes the key", async () => {
    const mod = await importModule();
    await mod.clearOnboardingProgress();
    expect((globalThis as any).window.localStorage.removeItem).toHaveBeenCalledWith(
      "gennety.onboarding.visual",
    );
  });
});

describe("onboarding visual progress (DeviceStorage)", () => {
  beforeEach(() => {
    (globalThis as any).window = {
      Telegram: {
        WebApp: {
          DeviceStorage: {
            setItem: mockSetItem,
            getItem: mockGetItem,
            removeItem: mockRemoveItem,
          },
        },
      },
    };
  });

  it("saveOnboardingProgress writes via DeviceStorage.setItem", async () => {
    const mod = await importModule();
    await mod.saveOnboardingProgress(4);
    expect(mockSetItem).toHaveBeenCalledWith(
      "gennety.onboarding.visual",
      "4",
      expect.any(Function),
    );
  });

  it("loadOnboardingProgress parses the integer from DeviceStorage", async () => {
    mockGetItem.mockImplementation((_key, cb) => cb(null, "5"));
    const mod = await importModule();
    expect(await mod.loadOnboardingProgress()).toBe(5);
  });
});
