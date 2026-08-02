import { describe, it, expect, vi, afterEach } from "vitest";

import { apiFetch } from "./api.js";

/**
 * Every Mini App request must have a deadline.
 *
 * The flows here all follow the same shape: set a `saving`/busy flag, disable
 * the button, `await` the request, clear the flag in the settle handlers. A
 * request that never settles therefore never clears the flag — the button stays
 * disabled reading "Saving…", the busy guard swallows every further tap, and the
 * only way out is to kill the Mini App. That is a real dead end on a flaky
 * mobile connection, and it applied to all 44 calls across all 12 pages.
 *
 * The abort deliberately surfaces as a plain `DOMException`, not a
 * `CalendarApiError`, because every caller already routes non-`CalendarApiError`
 * failures to the localized network message and restores its button.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("aborts a request that never settles", async () => {
    vi.useFakeTimers();
    // A fetch that hangs forever, but honours the abort signal — exactly what
    // the platform does with a stalled connection.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      ),
    );

    const pending = apiFetch("https://example.test/v1/thing");
    const assertion = expect(pending).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it("passes an abort signal to fetch on every call", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    await apiFetch("https://example.test/v1/thing", { method: "POST" });

    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // The caller's own init must survive being merged with the signal.
    expect(init.method).toBe("POST");
  });

  it("does not abort a request that settles in time", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );

    const res = await apiFetch("https://example.test/v1/thing");
    expect(res.status).toBe(200);

    // The pending timer must be cleared on the success path too — otherwise
    // every request would hold a live 20s timer, and in the polling screens
    // (calendar and the venue board both poll ~4s) they would pile up.
    expect(vi.getTimerCount()).toBe(0);
  });
});
