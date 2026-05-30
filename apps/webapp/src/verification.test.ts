/**
 * Unit tests for the Verification Mini App handler functions
 * (`handleComplete` / `handleCancel` / `handleError`).
 *
 * These cover the pure handler surface — the Persona SDK callbacks all
 * land in these three functions, so testing them is equivalent to testing
 * the SDK→backend bridge. The page-bootstrap path (DOMContentLoaded,
 * Persona iframe mount) is exercised manually in dev — see the plan file.
 *
 * We mock the Telegram WebApp surface and the api.ts POST helper so the
 * handlers can be driven deterministically without a real WebView. Test
 * setup follows the same shape as device-storage.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub out the Telegram WebApp + window.Persona BEFORE importing the module
// under test, so the side-effecting `boot()` block doesn't fire on import.
beforeEach(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {};
  (globalThis as unknown as { document: Record<string, unknown> }).document = {};
});

async function importModule() {
  return import("./verification.js");
}

function makeAppStub() {
  const closeFn = vi.fn();
  const notify = vi.fn();
  const mainOnClick = vi.fn();
  const mainSetText = vi.fn();
  const mainShow = vi.fn();
  return {
    app: {
      HapticFeedback: { notificationOccurred: notify },
      close: closeFn,
      MainButton: {
        setText: mainSetText,
        show: mainShow,
        hide: vi.fn(),
        onClick: mainOnClick,
      },
    },
    closeFn,
    notify,
    mainOnClick,
    mainSetText,
    mainShow,
  };
}

describe("handleComplete", () => {
  it("POSTs `complete` with inquiryId, renders finishing, and schedules WebApp.close", async () => {
    vi.useFakeTimers();
    const mod = await importModule();
    const stub = makeAppStub();
    const render = vi.fn();
    const postEvent = vi.fn().mockResolvedValue(undefined);

    await mod.handleComplete(
      { inquiryId: "inq_xyz", status: "approved" },
      {
        initData: "tma-init-data",
        lang: "en",
        app: stub.app,
        render,
        postEvent,
        closeDelayMs: 1000,
      },
    );

    expect(render).toHaveBeenCalledWith("finishing");
    expect(stub.notify).toHaveBeenCalledWith("success");
    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(postEvent).toHaveBeenCalledWith("tma-init-data", {
      kind: "complete",
      inquiryId: "inq_xyz",
      status: "approved",
    });
    expect(stub.closeFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(stub.closeFn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("still closes the WebApp even when the POST fails (DM lands via webhook anyway)", async () => {
    vi.useFakeTimers();
    const mod = await importModule();
    const stub = makeAppStub();
    const render = vi.fn();
    const postEvent = vi.fn().mockRejectedValue(new Error("network down"));

    await mod.handleComplete(
      { inquiryId: "inq_xyz" },
      {
        initData: "tma-init-data",
        lang: "en",
        app: stub.app,
        render,
        postEvent,
        closeDelayMs: 500,
      },
    );

    expect(render).toHaveBeenCalledWith("finishing");
    vi.advanceTimersByTime(500);
    expect(stub.closeFn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("sends null inquiryId when Persona doesn't surface one", async () => {
    vi.useFakeTimers();
    const mod = await importModule();
    const stub = makeAppStub();
    const postEvent = vi.fn().mockResolvedValue(undefined);

    await mod.handleComplete(
      {},
      {
        initData: "tma-init-data",
        lang: "ru",
        app: stub.app,
        render: vi.fn(),
        postEvent,
        closeDelayMs: 0,
      },
    );

    expect(postEvent).toHaveBeenCalledWith("tma-init-data", {
      kind: "complete",
      inquiryId: null,
      status: null,
    });
    vi.useRealTimers();
  });
});

describe("handleCancel", () => {
  it("POSTs `cancel` and immediately closes the WebApp", async () => {
    const mod = await importModule();
    const stub = makeAppStub();
    const postEvent = vi.fn().mockResolvedValue(undefined);

    await mod.handleCancel({
      initData: "tma-init-data",
      lang: "en",
      app: stub.app,
      render: vi.fn(),
      postEvent,
    });

    expect(postEvent).toHaveBeenCalledWith("tma-init-data", { kind: "cancel" });
    expect(stub.closeFn).toHaveBeenCalledTimes(1);
  });

  it("still closes the WebApp when the POST fails (server lifecycle dojuet)", async () => {
    const mod = await importModule();
    const stub = makeAppStub();
    const postEvent = vi.fn().mockRejectedValue(new Error("network down"));

    await mod.handleCancel({
      initData: "tma-init-data",
      lang: "en",
      app: stub.app,
      render: vi.fn(),
      postEvent,
    });

    expect(stub.closeFn).toHaveBeenCalledTimes(1);
  });
});

describe("handleError", () => {
  it("POSTs `error`, renders the error screen, and wires up a Close MainButton", async () => {
    const mod = await importModule();
    const stub = makeAppStub();
    const render = vi.fn();
    const postEvent = vi.fn().mockResolvedValue(undefined);

    await mod.handleError(
      { message: "camera permission denied" },
      {
        initData: "tma-init-data",
        lang: "en",
        app: stub.app,
        render,
        postEvent,
      },
    );

    expect(stub.notify).toHaveBeenCalledWith("error");
    expect(postEvent).toHaveBeenCalledWith("tma-init-data", {
      kind: "error",
      message: "camera permission denied",
    });
    expect(render).toHaveBeenCalledWith("error");
    expect(stub.mainSetText).toHaveBeenCalledWith("Close");
    expect(stub.mainOnClick).toHaveBeenCalledTimes(1);
    expect(stub.mainShow).toHaveBeenCalledTimes(1);
  });

  it("does NOT close the WebApp automatically — user has to tap Close", async () => {
    const mod = await importModule();
    const stub = makeAppStub();
    const postEvent = vi.fn().mockResolvedValue(undefined);

    await mod.handleError(
      {},
      {
        initData: "tma-init-data",
        lang: "en",
        app: stub.app,
        render: vi.fn(),
        postEvent,
      },
    );

    expect(stub.closeFn).not.toHaveBeenCalled();
  });

  it("uses localized Close label when lang is ru", async () => {
    const mod = await importModule();
    const stub = makeAppStub();

    await mod.handleError(
      {},
      {
        initData: "tma-init-data",
        lang: "ru",
        app: stub.app,
        render: vi.fn(),
        postEvent: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(stub.mainSetText).toHaveBeenCalledWith("Закрыть");
  });
});
