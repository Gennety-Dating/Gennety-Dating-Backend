import { describe, expect, it } from "vitest";
import { doorBootFor } from "./gatekeeper-boot";

/** A13-M32 — no signal at the door must not cost staff their key. */
describe("doorBootFor", () => {
  it("opens the door on a valid key", () => {
    expect(doorBootFor(200)).toBe("door");
  });

  it("forgets the key only when the server rejects it", () => {
    expect(doorBootFor(401)).toBe("forget-key");
    expect(doorBootFor(403)).toBe("forget-key");
  });

  it("keeps the key through every failure that says nothing about it", () => {
    expect(doorBootFor(null)).toBe("offline-door"); // no signal
    expect(doorBootFor(429)).toBe("offline-door");
    expect(doorBootFor(500)).toBe("offline-door");
    expect(doorBootFor(503)).toBe("offline-door");
    expect(doorBootFor(404)).toBe("offline-door");
  });
});
