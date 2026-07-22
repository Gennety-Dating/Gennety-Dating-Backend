import { describe, it, expect, vi } from "vitest";
import { tagAndPersistAppearance, type TagAppearanceDeps } from "./appearance-tags.js";
import { validateTags } from "./vision/tag-appearance.js";

function deps(overrides: Partial<TagAppearanceDeps> = {}): TagAppearanceDeps {
  return {
    downloadProfileImage: vi.fn().mockResolvedValue(Buffer.from("img")),
    tagAppearance: vi
      .fn()
      .mockResolvedValue({ ok: true, tags: { hairColor: "dark", build: "athletic" }, model: "m" }),
    persist: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("validateTags", () => {
  it("keeps only in-schema keys with allowed values (female)", () => {
    const out = validateTags(
      { hairColor: "blonde", build: "curvy", tattoos: "no", bogusKey: "x", beard: "beard" },
      "female",
    );
    // beard is a male-only key; bogusKey is off-schema — both dropped.
    expect(out).toEqual({ hairColor: "blonde", build: "curvy", tattoos: "no" });
  });

  it("drops values outside the allowed vocabulary", () => {
    const out = validateTags({ hairColor: "purple", build: "athletic" }, "male");
    expect(out).toEqual({ build: "athletic" }); // "purple" not allowed for male hairColor
  });

  it("returns {} for missing/non-object input", () => {
    expect(validateTags(undefined, "male")).toEqual({});
  });
});

describe("tagAndPersistAppearance", () => {
  it("skips when gender is missing", async () => {
    const d = deps();
    expect(await tagAndPersistAppearance("u1", ["p1"], null, d)).toBe("no_gender");
    expect(d.tagAppearance).not.toHaveBeenCalled();
  });

  it("skips when there are no photos", async () => {
    expect(await tagAndPersistAppearance("u1", [], "male", deps())).toBe("no_photos");
  });

  it("reports a download failure without calling the vision pass", async () => {
    const d = deps({ downloadProfileImage: vi.fn().mockResolvedValue(null) });
    expect(await tagAndPersistAppearance("u1", ["p1"], "male", d)).toBe("download_failed");
    expect(d.tagAppearance).not.toHaveBeenCalled();
  });

  it("passes the gender-derived set to the vision pass and persists", async () => {
    const d = deps();
    const out = await tagAndPersistAppearance("u1", ["p1", "p2"], "female", d);
    expect(out).toBe("persisted");
    expect(d.tagAppearance).toHaveBeenCalledWith(expect.any(Array), "female");
    expect(d.persist).toHaveBeenCalledWith("u1", ["p1", "p2"], {
      hairColor: "dark",
      build: "athletic",
    });
  });

  it("reports vision_failed when the pass returns not-ok", async () => {
    const d = deps({ tagAppearance: vi.fn().mockResolvedValue({ ok: false, error: "api" }) });
    expect(await tagAndPersistAppearance("u1", ["p1"], "male", d)).toBe("vision_failed");
    expect(d.persist).not.toHaveBeenCalled();
  });

  it("reports photos_changed when the guarded persist writes nothing", async () => {
    const d = deps({ persist: vi.fn().mockResolvedValue(false) });
    expect(await tagAndPersistAppearance("u1", ["p1"], "male", d)).toBe("photos_changed");
  });
});
