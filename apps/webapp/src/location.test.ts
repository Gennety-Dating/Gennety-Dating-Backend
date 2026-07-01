import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { selectLocationMock } = vi.hoisted(() => ({
  selectLocationMock: vi.fn(),
}));

vi.mock("./api.js", () => ({
  searchLocations: vi.fn(),
  selectLocation: selectLocationMock,
  CalendarApiError: class CalendarApiError extends Error {
    status: number;
    reason: string | undefined;
    constructor(status: number, reason: string | undefined, message: string) {
      super(message);
      this.status = status;
      this.reason = reason;
    }
  },
}));

const MATCH_ID = "11111111-1111-4111-8111-111111111111";

class FakeClassList {
  private names = new Set<string>();
  add(name: string): void {
    this.names.add(name);
  }
  remove(name: string): void {
    this.names.delete(name);
  }
  contains(name: string): boolean {
    return this.names.has(name);
  }
}

class FakeElement {
  className = "";
  classList = new FakeClassList();
  disabled = false;
  innerHTML = "";
  style: Record<string, string> = {};
  textContent = "";
  value = "";
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly id = "") {}

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  append(..._children: FakeElement[]): void {}

  click(): void {
    for (const handler of this.listeners.get("click") ?? []) {
      handler({ target: this });
    }
  }

  contains(target: unknown): boolean {
    return target === this;
  }

  querySelector(): FakeElement | null {
    // The location app only reaches for the `.cta-text` span inside #confirm;
    // returning null is fine — the code guards every ctaTextEl access.
    return null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  readonly attributes = new Map<string, string>();
}

class FakeDocument {
  readonly elements = new Map<string, FakeElement>();

  constructor() {
    for (const id of [
      "search",
      "results",
      "share-current",
      "confirm",
      "addr-label",
      "selected",
      "no-context",
    ]) {
      this.elements.set(id, new FakeElement(id));
    }
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  createElement(): FakeElement {
    return new FakeElement();
  }

  addEventListener(): void {}
}

type GeolocationCallbacks = {
  success?: PositionCallback;
  error?: PositionErrorCallback | null;
  options?: PositionOptions;
};

function makePosition(latitude: number, longitude: number): GeolocationPosition {
  return {
    coords: {
      latitude,
      longitude,
      accuracy: 25,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON: () => ({}),
    },
    timestamp: Date.now(),
    toJSON: () => ({}),
  };
}

function makeGeoError(code: number): GeolocationPositionError {
  return {
    code,
    message: "geo failed",
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function loadLocationApp(options: {
  geolocation?: Geolocation | undefined;
  isSecureContext?: boolean;
} = {}) {
  vi.resetModules();
  vi.useFakeTimers();
  selectLocationMock.mockReset();
  selectLocationMock.mockResolvedValue(undefined);

  const document = new FakeDocument();
  const mainButton = {
    text: "",
    isVisible: false,
    isActive: true,
    show: vi.fn(),
    hide: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    showProgress: vi.fn(),
    hideProgress: vi.fn(),
    setText: vi.fn(),
    onClick: vi.fn(),
    offClick: vi.fn(),
  };
  const app = {
    initData: "init-data",
    initDataUnsafe: {},
    ready: vi.fn(),
    expand: vi.fn(),
    close: vi.fn(),
    showAlert: vi.fn(),
    MainButton: mainButton,
    HapticFeedback: {
      selectionChanged: vi.fn(),
      notificationOccurred: vi.fn(),
    },
  };
  const fakeMap = {
    touchZoomRotate: { disableRotation: vi.fn() },
    on: vi.fn(),
    getCenter: vi.fn(() => ({ lng: 30.5234, lat: 50.4501 })),
    jumpTo: vi.fn(),
    setCenter: vi.fn(),
    resize: vi.fn(),
    remove: vi.fn(),
  };
  // `new window.maplibregl.Map(opts)` — a constructor returning an object hands
  // back that object, so the fake map instance is returned from `new`. Uses a
  // real class (not an arrow) so it's actually constructable.
  class FakeMaplibreMap {
    constructor() {
      return fakeMap;
    }
  }
  const maplibregl = { Map: FakeMaplibreMap };

  vi.stubGlobal("document", document);
  vi.stubGlobal("Node", FakeElement);
  vi.stubGlobal("location", { search: `?match=${MATCH_ID}&lang=en` });
  vi.stubGlobal("window", {
    Telegram: { WebApp: app },
    maplibregl,
    isSecureContext: options.isSecureContext ?? true,
  });
  vi.stubGlobal("navigator", {
    geolocation: options.geolocation,
  });

  await import("./location.js");

  return {
    app,
    document,
    fakeMap,
    mainButton,
    shareButton: document.getElementById("share-current")!,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Location Mini App geolocation quick-action", () => {
  it("saves current browser coordinates and closes the Mini App", async () => {
    const callbacks: GeolocationCallbacks = {};
    const geolocation = {
      getCurrentPosition: vi.fn((success, error, options) => {
        callbacks.success = success;
        callbacks.error = error;
        callbacks.options = options;
      }),
    } as unknown as Geolocation;
    const { app, fakeMap, shareButton } = await loadLocationApp({
      geolocation,
    });

    shareButton.click();

    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(callbacks.options).toEqual({
      enableHighAccuracy: true,
      timeout: 10_000,
      maximumAge: 60_000,
    });
    expect(shareButton.disabled).toBe(true);
    expect(shareButton.classList.contains("loading")).toBe(true);

    callbacks.success?.(makePosition(50.46, 30.51));
    await flushPromises();

    // Center-pin picker: recenter under the fixed pin via MapLibre jumpTo.
    // MapLibre uses [lng, lat] order (GeoJSON), the opposite of Leaflet.
    expect(fakeMap.jumpTo).toHaveBeenCalledWith({
      center: [30.51, 50.46],
      zoom: 16,
    });
    expect(selectLocationMock).toHaveBeenCalledWith(
      "init-data",
      MATCH_ID,
      50.46,
      30.51,
      "My current location",
    );
    vi.advanceTimersByTime(350);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it("keeps manual input available when the user denies location permission", async () => {
    const callbacks: GeolocationCallbacks = {};
    const geolocation = {
      getCurrentPosition: vi.fn((success, error) => {
        callbacks.success = success;
        callbacks.error = error;
      }),
    } as unknown as Geolocation;
    const { app, shareButton } = await loadLocationApp({ geolocation });

    shareButton.click();
    callbacks.error?.(makeGeoError(1));

    expect(selectLocationMock).not.toHaveBeenCalled();
    expect(app.showAlert).toHaveBeenCalledWith(
      "Location permission was denied. You can still type an address or tap the map.",
    );
    expect(shareButton.disabled).toBe(false);
    expect(shareButton.classList.contains("loading")).toBe(false);
  });

  it.each([
    [2, "Couldn't read your current location. Try typing an address or tapping the map."],
    [3, "Location lookup timed out. Try again, or type an address."],
  ])("shows a fallback alert for geolocation error code %s", async (code, message) => {
    const callbacks: GeolocationCallbacks = {};
    const geolocation = {
      getCurrentPosition: vi.fn((success, error) => {
        callbacks.success = success;
        callbacks.error = error;
      }),
    } as unknown as Geolocation;
    const { app, shareButton } = await loadLocationApp({ geolocation });

    shareButton.click();
    callbacks.error?.(makeGeoError(code));

    expect(selectLocationMock).not.toHaveBeenCalled();
    expect(app.showAlert).toHaveBeenCalledWith(message);
    expect(shareButton.disabled).toBe(false);
  });

  it("shows a fallback alert when geolocation is unavailable in the WebView", async () => {
    const { app, shareButton } = await loadLocationApp({
      geolocation: undefined,
      isSecureContext: false,
    });

    shareButton.click();

    expect(selectLocationMock).not.toHaveBeenCalled();
    expect(app.showAlert).toHaveBeenCalledWith(
      "Location sharing isn't available in this browser. You can still type an address or tap the map.",
    );
    expect(shareButton.disabled).toBe(false);
  });

  it("does not submit twice while the permission prompt is in flight", async () => {
    const callbacks: GeolocationCallbacks = {};
    const geolocation = {
      getCurrentPosition: vi.fn((success, error) => {
        callbacks.success = success;
        callbacks.error = error;
      }),
    } as unknown as Geolocation;
    const { shareButton } = await loadLocationApp({ geolocation });

    shareButton.click();
    shareButton.click();

    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    callbacks.success?.(makePosition(50.46, 30.51));
    await flushPromises();
    expect(selectLocationMock).toHaveBeenCalledTimes(1);
  });
});
