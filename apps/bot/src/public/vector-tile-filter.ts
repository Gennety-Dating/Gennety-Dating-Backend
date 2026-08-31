/**
 * Strip the vector-tile layers our basemap style never draws.
 *
 * CARTO's `carto.streets` source carries sixteen layers so that ONE tileset can
 * back every style they publish — including the label and POI layers a
 * no-labels dark map has no use for. We pay for all of them and draw nine.
 *
 * Measured on the real central-Kyiv tile (z14/9581/5525): 289 KB raw, of which
 * `poi` alone is 198 KB and the seven never-drawn layers are 226 KB — **78% of
 * the tile**. Over a 390x844 phone screen at z14 that is 1051 KB gzipped, and
 * stripping takes it to 342 KB (-67%). Without this the venue picker, which
 * opens at exactly z14 (`location.ts` DEFAULT_ZOOM), downloads a megabyte of
 * basemap to let someone drop one pin.
 *
 * It is a top-level protobuf edit, and deliberately nothing more. A vector tile
 * is `repeated Layer layers = 3`; each layer is a self-contained submessage
 * whose `name` is its field 1. So a kept layer is COPIED BYTE FOR BYTE — no
 * geometry is parsed, no feature is re-encoded, no key/value table is rewritten,
 * and there is no version of this that can subtly corrupt what it keeps.
 * `vector-tile-filter.test.ts` asserts exactly that against a real tile.
 *
 * The keep-set is the set of `source-layer` values in
 * `apps/webapp/src/map-style.ts`. Those two lists must agree, and the failure is
 * silent in the direction that matters: add a layer to the style without adding
 * it here and the proxy quietly strips it, so the map loses a feature with
 * nothing erroring anywhere. A test reads the style and pins the agreement.
 */
export const DRAWN_SOURCE_LAYERS = [
  "aeroway",
  "boundary",
  "building",
  "landcover",
  "landuse",
  "park",
  "transportation",
  "water",
  "waterway",
] as const;

const KEEP: ReadonlySet<string> = new Set(DRAWN_SOURCE_LAYERS);

/** Read a protobuf varint. Returns the value and the position after it. */
function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    if (pos >= buf.length) throw new RangeError("truncated varint");
    byte = buf[pos++]!;
    // 2**shift rather than <<: a length can exceed the 32-bit range `<<` wraps at.
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new RangeError("varint too long");
  } while (byte & 0x80);
  return [result, pos];
}

/** Skip one field's payload given its wire type. Returns the new position. */
function skipField(buf: Buffer, pos: number, wireType: number): number {
  if (wireType === 0) return readVarint(buf, pos)[1];
  if (wireType === 1) return pos + 8;
  if (wireType === 5) return pos + 4;
  if (wireType === 2) {
    const [len, after] = readVarint(buf, pos);
    return after + len;
  }
  throw new RangeError(`unsupported wire type ${wireType}`);
}

/** A Layer's `name` (field 1), or null if the submessage has none. */
function layerName(body: Buffer): string | null {
  let pos = 0;
  while (pos < body.length) {
    const [key, afterKey] = readVarint(body, pos);
    const field = key >> 3;
    const wireType = key & 7;
    if (field === 1 && wireType === 2) {
      const [len, afterLen] = readVarint(body, afterKey);
      return body.subarray(afterLen, afterLen + len).toString("utf8");
    }
    pos = skipField(body, afterKey, wireType);
  }
  return null;
}

/**
 * Drop every layer the style does not draw.
 *
 * Returns the original buffer unchanged if the tile cannot be walked — a tile
 * we do not understand is forwarded rather than mangled, because a heavier map
 * is a far better failure than a blank one.
 */
export function stripUndrawnLayers(tile: Buffer): Buffer {
  const kept: Buffer[] = [];
  let pos = 0;
  try {
    while (pos < tile.length) {
      const start = pos;
      const [key, afterKey] = readVarint(tile, pos);
      const field = key >> 3;
      const wireType = key & 7;
      pos = skipField(tile, afterKey, wireType);
      if (pos > tile.length) throw new RangeError("field overruns tile");
      if (field === 3 && wireType === 2) {
        const [len, afterLen] = readVarint(tile, afterKey);
        const name = layerName(tile.subarray(afterLen, afterLen + len));
        if (name === null || !KEEP.has(name)) continue;
      }
      kept.push(tile.subarray(start, pos));
    }
  } catch {
    return tile;
  }
  return Buffer.concat(kept);
}
