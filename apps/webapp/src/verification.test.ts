/**
 * Unit tests for the Verification Mini App handler functions
 * (`handleComplete` / `handleCancel` / `handleError`).
 *
 * These cover the pure handler surface — every detector callback lands in one
 * of these three functions, so testing them is equivalent to testing the
 * detector→backend bridge. The page-bootstrap path (DOMContentLoaded, mounting
 * the React island) is exercised manually in dev.
 *
 * The behaviour that matters most here is new to Face Liveness: `complete` is
 * no longer fire-and-forget. The AWS session expires 3 minutes after /init, so
 * the server reads the verdict inside that POST — which means the handler must
 * wait for the response and branch on it, and must NOT show a success tick it
 * cannot back up.
 *
 * We mock the Telegram WebApp surface and the api.ts POST helper so the
 * handlers can be driven deterministically without a real WebView. Test
 * setup follows the same shape as device-storage.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

// Stub out the Telegram WebApp BEFORE importing the module under test, so the
// side-effecting `boot()` block doesn't fire on import.
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

type Deps = Parameters<
  Awaited<ReturnType<typeof importModule>>["handleCancel"]
>[0];

function baseDeps(
  stub: ReturnType<typeof makeAppStub>,
  overrides: Partial<{
    lang: Deps["lang"];
    render: Deps["render"];
    postEvent: Deps["postEvent"];
    closeDelayMs: number;
    sessionId: string | null;
  }> = {},
): Deps {
  return {
    initData: "tma-init-data",
    lang: overrides.lang ?? "en",
    sessionId: overrides.sessionId === undefined ? SESSION_ID : overrides.sessionId,
    app: stub.app,
    render: overrides.render ?? vi.fn(),
    postEvent: overrides.postEvent ?? vi.fn().mockResolvedValue({ ok: true }),
    ...(overrides.closeDelayMs !== undefined
      ? { closeDelayMs: overrides.closeDelayMs }
      : {}),
  };
}

describe("handleComplete", () => {
  it("POSTs the sessionId, renders finishing, and schedules WebApp.close", async () => {
    vi.useFakeTimers();
    const mod = await importModule();
    const stub = makeAppStub();
    const render = vi.fn();
    const postEvent = vi
      .fn()
      .mockResolvedValue({ ok: true, outcome: "processing" });

    await mod.handleComplete(baseDeps(stub, { render, postEvent, closeDelayMs: 1000 }));

    expect(render).toHaveBeenCalledWith("finishing");
    expect(stub.notify).toHaveBeenCalledWith("success");
    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(postEvent).toHaveBeenCalledWith("tma-init-data", {
      kind: "complete",
      sessionId: SESSION_ID,
    });
    expect(stub.closeFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(stub.closeFn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("shows the retry screen and stays open when liveness wasn't confirmed", async () => {
    vi.useFakeTimers();
    const mod = await importModule();
    const stub = makeAppStub();
    const render = vi.fn();
    const postEvent = vi.fn().mockResolvedValue({ ok: true, outcome: "retry" });

    await mod.handleComplete(baseDeps(stub, { render, postEvent, closeDelayMs: 10 }));

    expect(render).toHaveBeenLastCalledWith("retry");
    expect(stub.notify).toHaveBeenCalledWith("error");
    // Must not auto-close on a retry: the user needs to read why nothing
    // happened before the WebView disappears.
    vi.advanceTimersByTime(1000);
    expect(stub.closeFn).not.toHaveBeenCalled();
    expect(stub.mainShow).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("shows an error rather than a success tick when the POST fails", async () => {
    vi.useFakeTimers();
    const mod = await importModule();
    const stub = makeAppStub();
    const render = vi.fn();
    const postEvent = vi.fn().mockRejectedValue(new Error("network down"));

    await mod.handleComplete(baseDeps(stub, { render, postEvent, closeDelayMs: 500 }));

    // The check may well have passed, but we couldn't tell the server — and
    // there is no webhook to settle it later, so claiming success would lie.
    expect(render).toHaveBeenLastCalledWith("error");
    vi.advanceTimersByTime(1000);
    expect(stub.closeFn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("handleCancel", () => {
  it("POSTs `cancel` and immediately closes the WebApp", async () => {
    const mod = await importModule();
    const stub = makeAppStub();
    const postEvent = vi.fn().mockResolvedValue({ ok: true });

    await mod.handleCancel(baseDeps(stub, { postEvent }));

    expect(postEvent).toHaveBeenCalledWith("tma-init-data", { kind: "cancel" });
    expect(stub.closeFn).toHaveBeenCalledTimes(1);
  });

  it("still closes the WebApp when the POST fails", async () => {
    const mod = await importModule();
    const stub = makeAppStub();
    const postEvent = vi.fn().mockRejectedValue(new Error("network down"));

    await mod.handleCancel(baseDeps(stub, { postEvent }));

    expect(stub.closeFn).toHaveBeenCalledTimes(1);
  });
});

describe("handleError", () => {
  it("POSTs `error`, renders the error screen, and wires up a Close MainButton", async () => {
    const mod = await importModule();
    const stub = makeAppStub();
    const render = vi.fn();
    const postEvent = vi.fn().mockResolvedValue({ ok: true });

    await mod.handleError(
      { message: "camera permission denied" },
      baseDeps(stub, { render, postEvent }),
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

    await mod.handleError({}, baseDeps(stub));

    expect(stub.closeFn).not.toHaveBeenCalled();
  });

  it("uses localized Close label when lang is ru", async () => {
    const mod = await importModule();
    const stub = makeAppStub();

    await mod.handleError({}, baseDeps(stub, { lang: "ru" }));

    expect(stub.mainSetText).toHaveBeenCalledWith("Закрыть");
  });
});
