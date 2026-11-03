import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The screenshot upload URL (audit B-4): one key per item, and the signed PUT
 * does not upsert, so bytes cannot be replaced after commit has checked them.
 */

vi.mock("../config.js", () => ({
  env: {
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    SUPABASE_SCREENSHOT_BUCKET: "screenshots",
  },
}));

const { createScreenshotSignedUpload } = await import("./storage.js");

const PATH = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ url: "/object/upload/sign/screenshots/x?token=t" }) }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createScreenshotSignedUpload", () => {
  it("asks for an upload URL that cannot overwrite the object", async () => {
    const url = await createScreenshotSignedUpload(PATH);
    expect(url).toBe("https://supabase.test/storage/v1/object/upload/sign/screenshots/x?token=t");
    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe(`https://supabase.test/storage/v1/object/upload/sign/screenshots/${PATH}`);
    expect((init.headers as Record<string, string>)["x-upsert"]).toBe("false");
  });

  it("refuses a path that leaves the person's folder", async () => {
    expect(await createScreenshotSignedUpload("11111111-1111-4111-8111-111111111111/../x.jpg")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
