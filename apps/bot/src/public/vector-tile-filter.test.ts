import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DRAWN_SOURCE_LAYERS, stripUndrawnLayers } from "./vector-tile-filter.js";

/** Minimal protobuf writer, enough to build a tile by hand. */
function varint(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}
function delimited(field: number, body: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(body.length), body]);
}
/** A Layer submessage: `name` (1), plus filler so byte-identity means something. */
function layer(name: string, filler = "x"): Buffer {
  return Buffer.concat([
    delimited(1, Buffer.from(name, "utf8")),
    delimited(2, Buffer.from(filler, "utf8")),
    Buffer.concat([varint((15 << 3) | 0), varint(4096)]),
  ]);
}
function tile(...layers: Buffer[]): Buffer {
  return Buffer.concat(layers.map((l) => delimited(3, l)));
}

/** Read back the `(name, bytes)` of every top-level layer. */
function parseLayers(buf: Buffer): Array<{ name: string; body: Buffer }> {
  const out: Array<{ name: string; body: Buffer }> = [];
  let pos = 0;
  const readVarint = (b: Buffer, p: number): [number, number] => {
    let r = 0, s = 0, byte: number;
    do { byte = b[p++]!; r += (byte & 0x7f) * 2 ** s; s += 7; } while (byte & 0x80);
    return [r, p];
  };
  while (pos < buf.length) {
    const [key, afterKey] = readVarint(buf, pos);
    const field = key >> 3;
    const wire = key & 7;
    if (wire !== 2) { pos = wire === 0 ? readVarint(buf, afterKey)[1] : buf.length; continue; }
    const [len, afterLen] = readVarint(buf, afterKey);
    const body = buf.subarray(afterLen, afterLen + len);
    pos = afterLen + len;
    if (field !== 3) continue;
    let q = 0;
    let name = "";
    while (q < body.length) {
      const [k2, a2] = readVarint(body, q);
      if ((k2 >> 3) === 1 && (k2 & 7) === 2) {
        const [l2, a3] = readVarint(body, a2);
        name = body.subarray(a3, a3 + l2).toString("utf8");
        break;
      }
      if ((k2 & 7) === 2) { const [l2, a3] = readVarint(body, a2); q = a3 + l2; }
      else if ((k2 & 7) === 0) { q = readVarint(body, a2)[1]; }
      else break;
    }
    out.push({ name, body });
  }
  return out;
}

describe("stripUndrawnLayers", () => {
  it("drops exactly the layers the style never draws", () => {
    const out = stripUndrawnLayers(
      tile(layer("building"), layer("poi"), layer("transportation"), layer("housenumber")),
    );
    expect(parseLayers(out).map((l) => l.name)).toEqual(["building", "transportation"]);
  });

  it("copies kept layers byte for byte", () => {
    // The whole safety argument: a kept layer is never re-encoded, so it cannot
    // be subtly corrupted. Assert it against the bytes, not against a re-parse.
    const input = tile(layer("water", "abc"), layer("poi"), layer("park", "defgh"));
    const before = parseLayers(input).filter((l) => l.name !== "poi");
    const after = parseLayers(stripUndrawnLayers(input));
    expect(after).toHaveLength(2);
    after.forEach((got, i) => expect(got.body.equals(before[i]!.body)).toBe(true));
  });

  it("finds the name even when it is not the layer's first field", () => {
    const odd = Buffer.concat([
      delimited(2, Buffer.from("keys-first", "utf8")),
      delimited(1, Buffer.from("poi", "utf8")),
    ]);
    expect(parseLayers(stripUndrawnLayers(tile(odd, layer("water"))))
      .map((l) => l.name)).toEqual(["water"]);
  });

  it("preserves non-layer top-level fields", () => {
    // A tile is not required to contain only field 3, and anything else in it
    // is not ours to throw away.
    const withExtra = Buffer.concat([
      delimited(9, Buffer.from("unknown", "utf8")),
      delimited(3, layer("poi")),
      delimited(3, layer("building")),
    ]);
    const out = stripUndrawnLayers(withExtra);
    expect(out.includes(Buffer.from("unknown", "utf8"))).toBe(true);
    expect(parseLayers(out).map((l) => l.name)).toEqual(["building"]);
  });

  it("forwards a tile it cannot walk instead of mangling it", () => {
    // A heavier map is a far better failure than a blank one.
    const garbage = Buffer.from([0x1a, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    expect(stripUndrawnLayers(garbage).equals(garbage)).toBe(true);
  });

  it("strips a real CARTO tile losslessly", () => {
    const fixture = fileURLToPath(
      new URL("./__fixtures__/carto-tile-14-9590-5530.mvt", import.meta.url),
    );
    const raw = readFileSync(fixture);
    const before = parseLayers(raw);
    const after = parseLayers(stripUndrawnLayers(raw));
    const drawn = new Set<string>(DRAWN_SOURCE_LAYERS);

    // The fixture is only worth having if it exercises both sides.
    expect(before.filter((l) => drawn.has(l.name)).length).toBeGreaterThan(0);
    expect(before.filter((l) => !drawn.has(l.name)).length).toBeGreaterThan(0);

    expect(after.map((l) => l.name)).toEqual(
      before.filter((l) => drawn.has(l.name)).map((l) => l.name),
    );
    after.forEach((got) => {
      const original = before.find((l) => l.name === got.name)!;
      expect(got.body.equals(original.body)).toBe(true);
    });
    expect(stripUndrawnLayers(raw).length).toBeLessThan(raw.length);
  });
});

describe("the keep-set and the basemap style", () => {
  it("lists exactly the source-layers the style reads", () => {
    // Silent in the direction that matters: a layer added to the style but not
    // here is stripped by the proxy, so the map loses a feature with nothing
    // erroring. The two lists live in different workspaces, so only this pins
    // them together.
    const style = readFileSync(
      fileURLToPath(new URL("../../../webapp/src/map-style.ts", import.meta.url)),
      "utf8",
    );
    const used = [...style.matchAll(/"source-layer"\s*:\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    expect([...new Set(used)].sort()).toEqual([...DRAWN_SOURCE_LAYERS].sort());
  });
});
