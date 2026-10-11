import { describe, expect, it } from "vitest";
import { sanitizeOriginAddress } from "./venue-intent-v2.js";

/**
 * Audit B-20: the departure address came from the request body verbatim — any
 * type, any length, control and bidi characters included — and was stored on
 * the match and echoed to both clients.
 */
describe("sanitizeOriginAddress", () => {
  it("keeps an ordinary address as typed", () => {
    expect(sanitizeOriginAddress("вул. Хрещатик, 22, Київ")).toBe("вул. Хрещатик, 22, Київ");
  });

  it("drops anything that is not a string", () => {
    expect(sanitizeOriginAddress(undefined)).toBeNull();
    expect(sanitizeOriginAddress(null)).toBeNull();
    expect(sanitizeOriginAddress(42)).toBeNull();
    expect(sanitizeOriginAddress({ street: "x" })).toBeNull();
  });

  it("replaces control, separator and bidi-override characters and trims", () => {
    expect(sanitizeOriginAddress("  Main\u0000 St\n\r\t1 ‮evil⁦  ")).toBe(
      "Main St 1 evil",
    );
  });

  it("caps the length at 256 characters without splitting an emoji", () => {
    const long = "😀".repeat(300);
    const out = sanitizeOriginAddress(long);
    expect(Array.from(out ?? "")).toHaveLength(256);
    expect(out).toBe("😀".repeat(256));
  });

  it("treats an address that cleans to nothing as absent", () => {
    expect(sanitizeOriginAddress(" \u0001‮ ")).toBeNull();
  });
});
