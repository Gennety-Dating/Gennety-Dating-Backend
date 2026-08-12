import { describe, expect, it } from "vitest";
import {
  CRUMBLE_COLS,
  CRUMBLE_ICON_SHARDS,
  CRUMBLE_ROWS,
  CRUMBLE_TOTAL_MS,
  crumbleShards,
} from "./onboarding-crumble.js";

const ICONS = [0, 1, 2];

describe("crumble tiling", () => {
  it("covers the icon exactly once", () => {
    for (const icon of ICONS) {
      const shards = crumbleShards(icon);
      expect(shards).toHaveLength(CRUMBLE_COLS * CRUMBLE_ROWS);
      const seen = new Set(shards.map((s) => `${s.col}:${s.row}`));
      expect(seen.size).toBe(CRUMBLE_COLS * CRUMBLE_ROWS);
    }
  });

  /**
   * Placing and cropping a tile is CSS's job (it needs the icon's real px size,
   * which is a viewport-dependent clamp), so all this module owes the renderer
   * is the cell. Emitting anything outside the grid would put a tile somewhere
   * the icon is not.
   */
  it("emits cells inside the grid, in reading order", () => {
    const shards = crumbleShards(0);
    shards.forEach((shard, i) => {
      expect(shard.col).toBe(i % CRUMBLE_COLS);
      expect(shard.row).toBe(Math.floor(i / CRUMBLE_COLS));
    });
  });
});

describe("crumble motion", () => {
  /**
   * The whole point of the effect: the icon erodes from its top edge down.
   * Asserted as a hard ordering rather than "the average delay rises", which
   * also pins the constraint the jitter lives under — ROW_JITTER_MS must stay
   * below ROW_STEP_MS, or the wave stops being a wave and the rows blur into
   * each other.
   */
  it("finishes every row before the next one starts", () => {
    for (const icon of ICONS) {
      const shards = crumbleShards(icon);
      for (let row = 0; row < CRUMBLE_ROWS - 1; row += 1) {
        const here = shards.filter((s) => s.row === row).map((s) => s.delayMs);
        const below = shards.filter((s) => s.row === row + 1).map((s) => s.delayMs);
        expect(Math.max(...here)).toBeLessThan(Math.min(...below));
      }
    }
  });

  /** The middle icon sits higher on the arc, so the wave reaches it first. */
  it("starts on the raised middle icon before the sides", () => {
    const earliest = (icon: number) => Math.min(...crumbleShards(icon).map((s) => s.delayMs));
    expect(earliest(1)).toBeLessThan(earliest(0));
    expect(earliest(1)).toBeLessThan(earliest(2));
  });

  /** Gravity, not an explosion: the fall dwarfs the sideways drift. */
  it("falls downward far further than it drifts sideways", () => {
    for (const icon of ICONS) {
      for (const shard of crumbleShards(icon)) {
        expect(shard.dyPx).toBeGreaterThan(0);
        expect(Math.abs(shard.dxPx)).toBeLessThan(shard.dyPx / 4);
      }
    }
  });

  /** The outer columns splay away from the icon, never inward through it. */
  it("throws the outer columns outward", () => {
    for (const icon of ICONS) {
      const shards = crumbleShards(icon);
      for (const shard of shards.filter((s) => s.col === 0)) {
        expect(shard.dxPx).toBeLessThan(0);
      }
      for (const shard of shards.filter((s) => s.col === CRUMBLE_COLS - 1)) {
        expect(shard.dxPx).toBeGreaterThan(0);
      }
    }
  });

  /** Tiles shrink as they dissolve — never grow, never invert. */
  it("keeps the end scale a shrink", () => {
    for (const icon of ICONS) {
      for (const shard of crumbleShards(icon)) {
        expect(shard.endScale).toBeGreaterThan(0);
        expect(shard.endScale).toBeLessThan(1);
      }
    }
  });
});

describe("crumble contract", () => {
  /**
   * `preference-layout.ts` states the rule this follows: a pattern re-rolled
   * per render can never be reviewed twice. Seeded output means the same
   * crumble plays on every replay and a retune shows up in a diff.
   */
  it("is deterministic", () => {
    for (const icon of ICONS) {
      expect(crumbleShards(icon)).toEqual(crumbleShards(icon));
    }
  });

  it("gives each icon its own pattern", () => {
    expect(crumbleShards(0)).not.toEqual(crumbleShards(1));
    expect(crumbleShards(1)).not.toEqual(crumbleShards(2));
  });

  /**
   * The scene holds CRUMBLE_TOTAL_MS before advancing, so this bound is what
   * stops the last crumbs being cut off mid-air by the next screen.
   */
  it("bounds every tile's flight", () => {
    for (const shards of CRUMBLE_ICON_SHARDS) {
      for (const shard of shards) {
        expect(shard.delayMs + shard.durationMs).toBeLessThanOrEqual(CRUMBLE_TOTAL_MS);
      }
    }
    const latest = Math.max(
      ...CRUMBLE_ICON_SHARDS.flat().map((s) => s.delayMs + s.durationMs),
    );
    expect(CRUMBLE_TOTAL_MS).toBe(latest);
  });

  /**
   * The screen is in the onboarding funnel, where added dead time is a real
   * cost (the Type Radar thinking beat is watched for exactly this). Keep the
   * whole crumble inside two seconds.
   */
  it("stays under two seconds", () => {
    expect(CRUMBLE_TOTAL_MS).toBeLessThan(2000);
    expect(CRUMBLE_TOTAL_MS).toBeGreaterThan(1000);
  });
});
