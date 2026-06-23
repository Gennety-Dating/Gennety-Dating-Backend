import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, RawApi } from "grammy";

// Pin env so the Supabase URL / key short-circuit in `downloadProfilePhoto`
// always resolves to "configured" — tests stub global fetch directly.
vi.mock("../config.js", () => ({
  env: {
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    SUPABASE_PHOTO_BUCKET: "photos",
    SUPABASE_SELFIE_BUCKET: "selfies",
    SUPABASE_CHAT_BUCKET: "chat",
  },
}));

const { downloadProfileImage, downloadTelegramFile, uploadSelfie, normalizeImageMime } =
  await import("./storage.js");

const TG_TOKEN = "999:fake-bot-token";
const TG_FILE_ID = "AgACAgIAAxkBAAIClGn6b1_fakeTelegramFileId";
const SUPABASE_PATH = "user-uuid-123/1715000000000.jpg";
const TG_BYTES = Buffer.from([0x01, 0x02, 0x03]);
const SUPABASE_BYTES = Buffer.from([0x10, 0x20, 0x30]);

interface MockApi {
  token: string;
  getFile: ReturnType<typeof vi.fn>;
}

function makeMockApi(overrides: Partial<MockApi> = {}): Api<RawApi> {
  const api: MockApi = {
    token: overrides.token ?? TG_TOKEN,
    getFile:
      overrides.getFile ??
      vi.fn(async (_fileId: string) => ({ file_path: "photos/file_123.jpg" })),
  };
  // grammY's Api is a real class with many members, but downloadProfileImage
  // only touches `token` + `getFile`. Cast-through is fine for unit tests.
  return api as unknown as Api<RawApi>;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("downloadProfileImage — routing", () => {
  it("routes Supabase paths (contain '/') to the photo-bucket fetch and skips Telegram", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => SUPABASE_BYTES.buffer.slice(
        SUPABASE_BYTES.byteOffset,
        SUPABASE_BYTES.byteOffset + SUPABASE_BYTES.byteLength,
      ),
    });
    const api = makeMockApi();

    const buf = await downloadProfileImage(SUPABASE_PATH, api);

    expect(buf).toBeInstanceOf(Buffer);
    expect(buf!.equals(SUPABASE_BYTES)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe(
      `https://supabase.test/storage/v1/object/photos/${SUPABASE_PATH}`,
    );
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      Authorization: "Bearer test-service-role-key",
    });
    expect((api as unknown as MockApi).getFile).not.toHaveBeenCalled();
  });

  it("routes Telegram file_ids (no '/') to api.getFile + the Bot API file URL", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () =>
        TG_BYTES.buffer.slice(
          TG_BYTES.byteOffset,
          TG_BYTES.byteOffset + TG_BYTES.byteLength,
        ),
    });
    const api = makeMockApi();

    const buf = await downloadProfileImage(TG_FILE_ID, api);

    expect(buf).toBeInstanceOf(Buffer);
    expect(buf!.equals(TG_BYTES)).toBe(true);
    expect((api as unknown as MockApi).getFile).toHaveBeenCalledWith(TG_FILE_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `https://api.telegram.org/file/bot${TG_TOKEN}/photos/file_123.jpg`,
    );
  });

  it("returns null when api.getFile rejects (defensive default — no throw)", async () => {
    const api = makeMockApi({
      getFile: vi.fn(async () => {
        throw new Error("Telegram API unreachable");
      }),
    });

    const buf = await downloadProfileImage(TG_FILE_ID, api);

    expect(buf).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when Supabase responds 404 (object missing)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const api = makeMockApi();

    const buf = await downloadProfileImage(SUPABASE_PATH, api);

    expect(buf).toBeNull();
    expect((api as unknown as MockApi).getFile).not.toHaveBeenCalled();
  });

  it("returns null gracefully on empty input (no fetch, no getFile)", async () => {
    const api = makeMockApi();

    const buf = await downloadProfileImage("", api);

    expect(buf).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((api as unknown as MockApi).getFile).not.toHaveBeenCalled();
  });
});

describe("downloadTelegramFile — direct entry point", () => {
  it("returns null when getFile yields no file_path (Telegram quota / expired id)", async () => {
    const api = makeMockApi({
      getFile: vi.fn(async () => ({}) as { file_path?: string }),
    });

    const buf = await downloadTelegramFile(api, TG_FILE_ID);

    expect(buf).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the Bot API file endpoint returns non-2xx", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const api = makeMockApi();

    const buf = await downloadTelegramFile(api, TG_FILE_ID);

    expect(buf).toBeNull();
  });
});

describe("normalizeImageMime — Content-Type safety", () => {
  it("passes through known image MIME types", () => {
    expect(normalizeImageMime("image/jpeg")).toBe("image/jpeg");
    expect(normalizeImageMime("image/png")).toBe("image/png");
    expect(normalizeImageMime("image/webp")).toBe("image/webp");
  });

  it("strips parameters and lower-cases", () => {
    expect(normalizeImageMime("IMAGE/PNG")).toBe("image/png");
    expect(normalizeImageMime("image/jpeg; charset=binary")).toBe("image/jpeg");
  });

  it("maps the image/jpg alias to image/jpeg", () => {
    expect(normalizeImageMime("image/jpg")).toBe("image/jpeg");
  });

  it("falls back to image/jpeg for empty / unknown values", () => {
    expect(normalizeImageMime(null)).toBe("image/jpeg");
    expect(normalizeImageMime("")).toBe("image/jpeg");
    expect(normalizeImageMime("application/octet-stream")).toBe("image/jpeg");
  });

  it("neutralizes a non-Latin1 upstream content-type (the Persona '→' bug)", () => {
    // Mirrors a Persona selfie download whose content-type carried U+2192 (→),
    // which undici rejected as an outgoing header value.
    const poisoned = "application/octet-stream; persona-note=download→selfie";
    const result = normalizeImageMime(poisoned);
    expect(result).toBe("image/jpeg");
    // The result must be a valid HTTP header value (Latin-1 ByteString).
    expect([...result].every((ch) => ch.charCodeAt(0) <= 255)).toBe(true);
  });
});

describe("uploadSelfie — Content-Type is always ByteString-safe", () => {
  it("normalizes a '→'-bearing source MIME so the upload header never throws", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const result = await uploadSelfie(
      "user-uuid-123",
      Buffer.from([0xff, 0xd8, 0xff]),
      "garbage→content-type-that-undici-would-reject",
    );

    expect(result.path).toMatch(/^user-uuid-123\/\d+\.jpg$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("image/jpeg");
    expect(
      [...headers["Content-Type"]!].every((ch) => ch.charCodeAt(0) <= 255),
    ).toBe(true);
  });
});
