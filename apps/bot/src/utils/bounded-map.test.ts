import { describe, it, expect } from "vitest";
import { BoundedMap } from "./bounded-map.js";

describe("BoundedMap", () => {
  it("never grows past its cap", () => {
    const map = new BoundedMap<string, number>(3);
    for (let i = 0; i < 100; i += 1) map.set(`k${i}`, i);
    expect(map.size).toBe(3);
    expect([...map.keys()]).toEqual(["k97", "k98", "k99"]);
  });

  it("evicts the least recently written key, not the oldest one", () => {
    const map = new BoundedMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    // "a" is touched again, so "b" is now the coldest.
    map.set("a", 10);
    map.set("d", 4);
    expect([...map.keys()]).toEqual(["c", "a", "d"]);
    expect(map.get("a")).toBe(10);
    expect(map.has("b")).toBe(false);
  });

  it("re-writing an existing key does not evict anything", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("b", 3);
    expect(map.size).toBe(2);
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(3);
  });

  it("keeps working as a plain Map for delete and clear", () => {
    const map = new BoundedMap<string, number>(5);
    map.set("a", 1).set("b", 2);
    expect(map.delete("a")).toBe(true);
    expect(map.size).toBe(1);
    map.clear();
    expect(map.size).toBe(0);
  });

  it("a cap below one still holds the newest entry", () => {
    const map = new BoundedMap<string, number>(0);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.size).toBe(1);
    expect(map.get("b")).toBe(2);
  });
});
