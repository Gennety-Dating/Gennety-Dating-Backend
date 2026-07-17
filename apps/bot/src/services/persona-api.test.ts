import { describe, expect, it, vi } from "vitest";
import { fetchInquirySelfie, fetchLatestInquiryByReference } from "./persona-api.js";

const INQUIRY_ID = "inq_abc123";
const PHOTO_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0x42]); // fake JPEG bytes
const SIGNED_PHOTO_URL = "https://files.persona.example/selfie/abc.jpg";
const API_KEY = "persona_sandbox_test_key";

interface MockResponse {
  status: number;
  json?: unknown;
  body?: ArrayBuffer;
  headers?: Record<string, string>;
}

/**
 * Build a tiny mock fetch that responds based on URL prefix:
 *   - `api.withpersona.com` → JSON inquiry response
 *   - signed photo URL → binary bytes
 * Records every call so we can assert on Authorization header etc.
 */
function makeFetch(
  inquiryResponse: MockResponse,
  photoResponse: MockResponse,
): { fetchFn: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({ url: u, init });

    const r = u.startsWith("https://api.withpersona.com") ? inquiryResponse : photoResponse;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
      arrayBuffer: async () => r.body ?? new ArrayBuffer(0),
      headers: { get: (h: string) => r.headers?.[h.toLowerCase()] ?? null },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { fetchFn, calls };
}

describe("fetchInquirySelfie — happy path", () => {
  it("downloads centered-photo-url from the selfie verification", async () => {
    const { fetchFn, calls } = makeFetch(
      {
        status: 200,
        json: {
          data: { type: "inquiry", id: INQUIRY_ID, attributes: { status: "approved" } },
          included: [
            {
              type: "verification/selfie-v2",
              id: "ver_selfie_1",
              attributes: {
                "centered-photo-url": SIGNED_PHOTO_URL,
                "left-photo-url": "https://files.persona.example/selfie/left.jpg",
              },
            },
          ],
        },
      },
      {
        status: 200,
        body: new Uint8Array(PHOTO_BYTES).buffer,
        headers: { "content-type": "image/jpeg" },
      },
    );

    const result = await fetchInquirySelfie(INQUIRY_ID, { fetchFn, apiKey: API_KEY });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selfie.verificationId).toBe("ver_selfie_1");
    expect(result.selfie.mime).toBe("image/jpeg");
    expect(Buffer.compare(result.selfie.buffer, PHOTO_BYTES)).toBe(0);

    // First call: inquiry endpoint with proper auth + version header
    expect(calls[0]!.url).toContain(`/inquiries/${INQUIRY_ID}`);
    expect(calls[0]!.url).toContain("include=verifications");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["Persona-Version"]).toBe("2023-01-05");

    // Second call: photo download — no auth header, that would break the S3 signature
    expect(calls[1]!.url).toBe(SIGNED_PHOTO_URL);
    const photoHeaders = (calls[1]!.init?.headers ?? {}) as Record<string, string>;
    expect(photoHeaders.Authorization).toBeUndefined();
  });

  it("accepts the legacy verification/selfie type in addition to selfie-v2", async () => {
    const { fetchFn } = makeFetch(
      {
        status: 200,
        json: {
          data: { type: "inquiry", id: INQUIRY_ID, attributes: { status: "approved" } },
          included: [
            {
              type: "verification/selfie",
              id: "ver_legacy_1",
              attributes: { "centered-photo-url": SIGNED_PHOTO_URL },
            },
          ],
        },
      },
      {
        status: 200,
        body: new Uint8Array(PHOTO_BYTES).buffer,
        headers: { "content-type": "image/jpeg" },
      },
    );

    const result = await fetchInquirySelfie(INQUIRY_ID, { fetchFn, apiKey: API_KEY });
    expect(result.ok).toBe(true);
  });

  it("falls back to left-photo-url when centered is missing", async () => {
    const { fetchFn, calls } = makeFetch(
      {
        status: 200,
        json: {
          data: { type: "inquiry", id: INQUIRY_ID, attributes: { status: "approved" } },
          included: [
            {
              type: "verification/selfie-v2",
              id: "ver_1",
              attributes: { "left-photo-url": SIGNED_PHOTO_URL },
            },
          ],
        },
      },
      {
        status: 200,
        body: new Uint8Array(PHOTO_BYTES).buffer,
        headers: { "content-type": "image/jpeg" },
      },
    );

    const result = await fetchInquirySelfie(INQUIRY_ID, { fetchFn, apiKey: API_KEY });
    expect(result.ok).toBe(true);
    expect(calls[1]!.url).toBe(SIGNED_PHOTO_URL);
  });
});

describe("fetchInquirySelfie — error paths", () => {
  it("returns not_configured when API key is empty", async () => {
    const { fetchFn } = makeFetch({ status: 200 }, { status: 200 });
    const result = await fetchInquirySelfie(INQUIRY_ID, { fetchFn, apiKey: "" });
    expect(result).toEqual({ ok: false, error: "not_configured" });
  });

  it("returns inquiry_not_found on 404 from Persona", async () => {
    const { fetchFn } = makeFetch({ status: 404 }, { status: 200 });
    const result = await fetchInquirySelfie(INQUIRY_ID, { fetchFn, apiKey: API_KEY });
    expect(result).toEqual({ ok: false, error: "inquiry_not_found" });
  });

  it("returns api on 500 from Persona", async () => {
    const { fetchFn } = makeFetch({ status: 500 }, { status: 200 });
    const result = await fetchInquirySelfie(INQUIRY_ID, { fetchFn, apiKey: API_KEY });
    expect(result).toEqual({ ok: false, error: "api" });
  });

  it("returns no_selfie when included has no selfie verification", async () => {
    const { fetchFn } = makeFetch(
      {
        status: 200,
        json: {
          data: { type: "inquiry", id: INQUIRY_ID, attributes: { status: "approved" } },
          included: [
            {
              type: "verification/government-id",
              id: "ver_gid",
              attributes: { "front-photo-url": "https://x" },
            },
          ],
        },
      },
      { status: 200 },
    );
    const result = await fetchInquirySelfie(INQUIRY_ID, { fetchFn, apiKey: API_KEY });
    expect(result).toEqual({ ok: false, error: "no_selfie" });
  });

  it("returns no_selfie when the selfie verification has no photo URL fields", async () => {
    const { fetchFn } = makeFetch(
      {
        status: 200,
        json: {
          data: { type: "inquiry", id: INQUIRY_ID, attributes: { status: "approved" } },
          included: [
            {
              type: "verification/selfie-v2",
              id: "ver_1",
              attributes: { status: "passed" }, // no *-photo-url
            },
          ],
        },
      },
      { status: 200 },
    );
    const result = await fetchInquirySelfie(INQUIRY_ID, { fetchFn, apiKey: API_KEY });
    expect(result).toEqual({ ok: false, error: "no_selfie" });
  });

  it("returns download_failed when the signed photo URL responds non-200", async () => {
    const { fetchFn } = makeFetch(
      {
        status: 200,
        json: {
          data: { type: "inquiry", id: INQUIRY_ID, attributes: { status: "approved" } },
          included: [
            {
              type: "verification/selfie-v2",
              id: "ver_1",
              attributes: { "centered-photo-url": SIGNED_PHOTO_URL },
            },
          ],
        },
      },
      { status: 403 }, // S3 signature expired
    );
    const result = await fetchInquirySelfie(INQUIRY_ID, { fetchFn, apiKey: API_KEY });
    expect(result).toEqual({ ok: false, error: "download_failed" });
  });

  it("returns download_failed without buffering an oversized selfie", async () => {
    const { fetchFn } = makeFetch(
      {
        status: 200,
        json: {
          data: { type: "inquiry", id: INQUIRY_ID, attributes: { status: "approved" } },
          included: [
            {
              type: "verification/selfie-v2",
              id: "ver_1",
              attributes: { "centered-photo-url": SIGNED_PHOTO_URL },
            },
          ],
        },
      },
      {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(10 * 1024 * 1024 + 1),
        },
      },
    );

    await expect(
      fetchInquirySelfie(INQUIRY_ID, { fetchFn, apiKey: API_KEY }),
    ).resolves.toEqual({ ok: false, error: "download_failed" });
  });

  it("returns timeout when fetch is aborted", async () => {
    const fetchFn = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const result = await fetchInquirySelfie(INQUIRY_ID, { fetchFn, apiKey: API_KEY });
    expect(result).toEqual({ ok: false, error: "timeout" });
  });
});

function listResponse(data: unknown[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

function inquiry(id: string, status: string, createdAt: string) {
  return {
    type: "inquiry",
    id,
    attributes: {
      status,
      "created-at": createdAt,
    },
  };
}

describe("fetchLatestInquiryByReference", () => {
  it("prefers a newer actionable approved inquiry over a latest abandoned created row", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      listResponse([
        inquiry("inq_created", "created", "2026-05-29T03:35:39.000Z"),
        inquiry("inq_approved", "approved", "2026-05-29T03:32:13.000Z"),
      ]),
    );

    const result = await fetchLatestInquiryByReference("user-1", {
      fetchFn: fetchFn as unknown as typeof fetch,
      apiKey: API_KEY,
    });

    expect(result).toEqual({
      ok: true,
      inquiryId: "inq_approved",
      status: "approved",
      createdAt: "2026-05-29T03:32:13.000Z",
    });
  });

  it("falls back to the newest non-actionable inquiry when nothing terminal exists", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      listResponse([
        inquiry("inq_created", "created", "2026-05-29T03:35:39.000Z"),
        inquiry("inq_pending", "pending", "2026-05-29T03:32:13.000Z"),
      ]),
    );

    const result = await fetchLatestInquiryByReference("user-1", {
      fetchFn: fetchFn as unknown as typeof fetch,
      apiKey: API_KEY,
    });

    expect(result).toEqual({
      ok: true,
      inquiryId: "inq_created",
      status: "created",
      createdAt: "2026-05-29T03:35:39.000Z",
    });
  });
});
