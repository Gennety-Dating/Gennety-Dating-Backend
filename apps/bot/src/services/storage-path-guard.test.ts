import { describe, expect, it } from "vitest";
import { isSafeStorageObjectPath } from "./storage.js";

/**
 * The second layer under the chat-image ownership check: a key that traverses
 * must never reach a Supabase URL, whichever caller built it. `fetch` collapses
 * dot segments, so `a/../b` addresses `b` — the guard is what stops that from
 * being a bucket-wide read.
 */
describe("isSafeStorageObjectPath", () => {
  it("accepts the shape every uploader in this module mints", () => {
    expect(isSafeStorageObjectPath("11111111-1111-4111-8111-111111111111/1750000000000.jpg")).toBe(true);
    expect(isSafeStorageObjectPath("user/ts.webp")).toBe(true);
    expect(isSafeStorageObjectPath("a/b/c.png")).toBe(true);
  });

  it("refuses traversal in any position", () => {
    for (const key of [
      "../secrets/x.jpg",
      "a/../b.jpg",
      "a/b/../../c.jpg",
      "a/./b.jpg",
      "..",
      ".",
    ]) {
      expect(isSafeStorageObjectPath(key), key).toBe(false);
    }
  });

  it("refuses empty segments, absolute keys and query/fragment smuggling", () => {
    for (const key of ["", "/a.jpg", "a//b.jpg", "a/b.jpg?x=1", "a/b.jpg#f", "a/b c.jpg", "a\\..\\b.jpg"]) {
      expect(isSafeStorageObjectPath(key), JSON.stringify(key)).toBe(false);
    }
  });

  it("refuses an absurdly long key", () => {
    expect(isSafeStorageObjectPath(`u/${"a".repeat(600)}.jpg`)).toBe(false);
  });
});
