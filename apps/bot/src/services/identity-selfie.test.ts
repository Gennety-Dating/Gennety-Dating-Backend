import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: userFindUnique } },
}));

vi.mock("./storage.js", () => ({ downloadSelfie: vi.fn() }));

const { capturedSelfieSource, storedSelfieSource } = await import(
  "./identity-selfie.js"
);

const BYTES = Buffer.from([0xff, 0xd8, 0xff]);

beforeEach(() => {
  userFindUnique.mockReset();
});

describe("capturedSelfieSource", () => {
  it("hands back the fresh liveness bytes with no stored path", async () => {
    // No `storedPath` is the signal that the pipeline must upload these bytes:
    // they exist nowhere else, and the AWS session holding them dies in 3 min.
    const source = capturedSelfieSource({ buffer: BYTES, mime: "image/jpeg" });

    await expect(source()).resolves.toEqual({
      ok: true,
      selfie: { buffer: BYTES, mime: "image/jpeg" },
    });
    expect(userFindUnique).not.toHaveBeenCalled();
  });
});

describe("storedSelfieSource", () => {
  it("returns the stored bytes AND the path they came from", async () => {
    // Carrying `storedPath` is what stops a rerun from writing a duplicate
    // object into the selfies bucket on every photo edit.
    userFindUnique.mockResolvedValue({ verifiedSelfiePath: "user-1/selfie.jpg" });
    const download = vi.fn(async () => BYTES);

    const result = await storedSelfieSource("user-1", { download })();

    expect(result).toEqual({
      ok: true,
      selfie: {
        buffer: BYTES,
        mime: "image/jpeg",
        storedPath: "user-1/selfie.jpg",
      },
    });
    expect(download).toHaveBeenCalledWith("user-1/selfie.jpg");
  });

  it("reports reference_expired when the 90-day scrub cleared the path", async () => {
    userFindUnique.mockResolvedValue({ verifiedSelfiePath: null });
    const download = vi.fn(async () => BYTES);

    const result = await storedSelfieSource("user-1", { download })();

    expect(result).toEqual({ ok: false, error: "reference_expired" });
    expect(download).not.toHaveBeenCalled();
  });

  it("reports reference_expired for an unknown user", async () => {
    userFindUnique.mockResolvedValue(null);

    const result = await storedSelfieSource("ghost", { download: vi.fn() })();

    expect(result).toEqual({ ok: false, error: "reference_expired" });
  });

  it("distinguishes a transient storage miss from an expired reference", async () => {
    userFindUnique.mockResolvedValue({ verifiedSelfiePath: "user-1/selfie.jpg" });
    const download = vi.fn(async () => null);

    const result = await storedSelfieSource("user-1", { download })();

    expect(result).toEqual({ ok: false, error: "download_failed" });
  });
});
