import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `createChatImageSignedUrls` — one Supabase request per history page instead of
 * one per photo (decision journal 2026-09-30).
 *
 * The request/response shape is Storage's batch route as storage-api defines it
 * (`POST /object/sign/:bucketName`, body `{ expiresIn, paths }`, answer
 * `[{ error, path, signedURL }]`, `signedURL` relative to `/storage/v1`, `null`
 * for a missing object) — the shape supabase-js `createSignedUrls` reads.
 */

vi.mock("../config.js", () => ({
  env: {
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    SUPABASE_CHAT_BUCKET: "chat",
  },
}));

const { createChatImageSignedUrls } = await import("./storage.js");

const A = "11111111-1111-4111-8111-111111111111/1750000000001.jpg";
const B = "11111111-1111-4111-8111-111111111111/1750000000002.png";
const TRAVERSAL = "11111111-1111-4111-8111-111111111111/../22222222-2222-4222-8222-222222222222/1.jpg";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createChatImageSignedUrls", () => {
  it("signs a whole page in ONE request, answering index for index", async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        { error: null, path: A, signedURL: `/object/sign/chat/${A}?token=ta` },
        { error: null, path: B, signedURL: `/object/sign/chat/${B}?token=tb` },
      ]),
    );

    const urls = await createChatImageSignedUrls([B, A, B], 300);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://supabase.test/storage/v1/object/sign/chat");
    expect(init.method).toBe("POST");
    // Duplicates are signed once.
    expect(JSON.parse(String(init.body))).toEqual({ expiresIn: 300, paths: [B, A] });
    expect(urls).toEqual([
      `https://supabase.test/storage/v1/object/sign/chat/${B}?token=tb`,
      `https://supabase.test/storage/v1/object/sign/chat/${A}?token=ta`,
      `https://supabase.test/storage/v1/object/sign/chat/${B}?token=tb`,
    ]);
  });

  it("a missing object is null, like the single route's 4xx", async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        { error: null, path: A, signedURL: `/object/sign/chat/${A}?token=ta` },
        {
          error: "Either the object does not exist or you do not have access to it",
          path: B,
          signedURL: null,
        },
      ]),
    );

    expect(await createChatImageSignedUrls([A, B])).toEqual([
      `https://supabase.test/storage/v1/object/sign/chat/${A}?token=ta`,
      null,
    ]);
  });

  it("never sends a traversing key — the single route's guard, per path", async () => {
    fetchMock.mockResolvedValueOnce(
      json([{ error: null, path: A, signedURL: `/object/sign/chat/${A}?token=ta` }]),
    );

    const urls = await createChatImageSignedUrls([TRAVERSAL, A]);

    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.paths).toEqual([A]);
    expect(urls).toEqual([null, `https://supabase.test/storage/v1/object/sign/chat/${A}?token=ta`]);
  });

  it("makes no request for a page without photos", async () => {
    expect(await createChatImageSignedUrls([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to one request per object when the batch call fails", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ statusCode: "500", error: "internal" }, 500))
      .mockResolvedValueOnce(json({ signedURL: `/object/sign/chat/${A}?token=sa` }))
      .mockResolvedValueOnce(json({ signedURL: `/object/sign/chat/${B}?token=sb` }));

    const urls = await createChatImageSignedUrls([A, B]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toBe(`https://supabase.test/storage/v1/object/sign/chat/${A}`);
    expect(urls).toEqual([
      `https://supabase.test/storage/v1/object/sign/chat/${A}?token=sa`,
      `https://supabase.test/storage/v1/object/sign/chat/${B}?token=sb`,
    ]);
  });

  it("falls back when the answer is not the shape it should be", async () => {
    fetchMock
      // An answer that skips a path is a shape we do not know.
      .mockResolvedValueOnce(json([{ error: null, path: A, signedURL: "/object/sign/chat/x" }]))
      .mockResolvedValueOnce(json({ signedURL: `/object/sign/chat/${A}?token=sa` }))
      .mockResolvedValueOnce(json({ signedURL: `/object/sign/chat/${B}?token=sb` }));

    const urls = await createChatImageSignedUrls([A, B]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urls[1]).toBe(`https://supabase.test/storage/v1/object/sign/chat/${B}?token=sb`);
  });

  it("falls back when the batch request throws, and a throwing fallback is null", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(json({ signedURL: `/object/sign/chat/${A}?token=sa` }))
      .mockRejectedValueOnce(new Error("socket hang up"));

    expect(await createChatImageSignedUrls([A, B])).toEqual([
      `https://supabase.test/storage/v1/object/sign/chat/${A}?token=sa`,
      null,
    ]);
  });
});
