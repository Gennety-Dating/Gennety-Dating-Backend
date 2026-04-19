import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Telegram WebApp global before importing
const mockSetItem = vi.fn((_key: string, _val: string, cb: (err: any) => void) => cb(null));
const mockGetItem = vi.fn((_key: string, cb: (err: any, val?: string) => void) => cb(null, undefined));
const mockRemoveItem = vi.fn((_key: string, cb: () => void) => cb());

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the global to undefined before each test
  (globalThis as any).window = {
    Telegram: undefined,
    localStorage: {
      setItem: vi.fn(),
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
    },
  };
});

// Re-import for each test to get fresh module state
async function importModule() {
  // Use dynamic import with cache bust to get fresh module
  return import("./device-storage.js");
}

describe("device-storage (no Telegram, falls back to localStorage)", () => {
  it("savePickedIso stores in localStorage when no DeviceStorage", async () => {
    const mod = await importModule();
    await mod.savePickedIso("match-1", "2026-05-01T19:00:00.000Z");

    expect((globalThis as any).window.localStorage.setItem).toHaveBeenCalledWith(
      "gennety.calendar.match.match-1",
      "2026-05-01T19:00:00.000Z",
    );
  });

  it("loadPickedIso reads from localStorage when no DeviceStorage", async () => {
    (globalThis as any).window.localStorage.getItem = vi.fn(() => "2026-05-01T19:00:00.000Z");
    const mod = await importModule();
    const result = await mod.loadPickedIso("match-1");

    expect(result).toBe("2026-05-01T19:00:00.000Z");
    expect((globalThis as any).window.localStorage.getItem).toHaveBeenCalledWith(
      "gennety.calendar.match.match-1",
    );
  });

  it("loadPickedIso returns null when key does not exist", async () => {
    const mod = await importModule();
    const result = await mod.loadPickedIso("nonexistent");
    expect(result).toBeNull();
  });

  it("clearPicked removes from localStorage when no DeviceStorage", async () => {
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

  it("savePickedIso calls DeviceStorage.setItem", async () => {
    const mod = await importModule();
    await mod.savePickedIso("match-2", "2026-06-01T19:00:00.000Z");

    expect(mockSetItem).toHaveBeenCalledWith(
      "gennety.calendar.match.match-2",
      "2026-06-01T19:00:00.000Z",
      expect.any(Function),
    );
  });

  it("loadPickedIso calls DeviceStorage.getItem and returns value", async () => {
    mockGetItem.mockImplementation((_key, cb) => cb(null, "2026-06-01T19:00:00.000Z"));
    const mod = await importModule();
    const result = await mod.loadPickedIso("match-2");

    expect(result).toBe("2026-06-01T19:00:00.000Z");
  });

  it("loadPickedIso returns null on DeviceStorage error", async () => {
    mockGetItem.mockImplementation((_key, cb) => cb(new Error("boom")));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importModule();
    const result = await mod.loadPickedIso("match-2");

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
