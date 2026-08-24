import { describe, it, expect, beforeEach } from "vitest";
import {
  icon,
  categoryIcon,
  getRotatingMapIcon,
  MAP_VARIANTS,
  type IconName,
} from "./icons.js";

describe("icons", () => {
  beforeEach(() => {
    // Lightweight DOM stub for node test environment
    if (typeof globalThis.document === "undefined") {
      const createFakeNode = (tag: string) => {
        const attrs = new Map<string, string>();
        const children: unknown[] = [];
        return {
          tagName: tag.toUpperCase(),
          setAttribute(name: string, value: string) {
            attrs.set(name, value);
          },
          getAttribute(name: string) {
            return attrs.get(name) ?? null;
          },
          appendChild(child: unknown) {
            children.push(child);
          },
          children,
        };
      };

      (globalThis as unknown as { document: unknown }).document = {
        createElementNS(_ns: string, tag: string) {
          return createFakeNode(tag);
        },
      };
    }
  });

  it("renders an SVG element with appropriate attributes for each icon", () => {
    const names: IconName[] = [
      "heart",
      "heart-filled",
      "coffee",
      "restaurant",
      "park",
      "museum",
      "lounge",
      "pin",
      "map",
      "map-nav",
      "map-pin",
      "map-fold",
      "map-route",
      "star",
      "spark",
      "bolt",
      "letter",
      "check",
      "chevron",
      "lock",
      "ticket",
      "close",
    ];

    for (const name of names) {
      const el = icon(name, "custom-icon-class");
      expect(el.tagName.toLowerCase()).toBe("svg");
      expect(el.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(el.getAttribute("class")).toBe("custom-icon-class");
      expect(el.children.length).toBeGreaterThan(0);
    }
  });

  it("cycles candidate map icons evenly via getRotatingMapIcon", () => {
    expect(MAP_VARIANTS).toEqual(["map-nav", "map-pin", "map-fold", "map-route"]);

    expect(getRotatingMapIcon(0)).toBe("map-nav");
    expect(getRotatingMapIcon(1)).toBe("map-pin");
    expect(getRotatingMapIcon(2)).toBe("map-fold");
    expect(getRotatingMapIcon(3)).toBe("map-route");

    // Wraps around
    expect(getRotatingMapIcon(4)).toBe("map-nav");
    expect(getRotatingMapIcon(5)).toBe("map-pin");
    expect(getRotatingMapIcon(6)).toBe("map-fold");
    expect(getRotatingMapIcon(7)).toBe("map-route");

    // Handles negative or non-integer numbers gracefully
    expect(getRotatingMapIcon(-1)).toBe("map-pin");
  });

  it("resolves category fallback icon to pin", () => {
    const cafe = categoryIcon("cafe");
    expect(cafe).toBeDefined();
    expect(cafe.tagName.toLowerCase()).toBe("svg");

    const unknown = categoryIcon("unknown_category");
    expect(unknown).toBeDefined();
    expect(unknown.tagName.toLowerCase()).toBe("svg");
  });
});
