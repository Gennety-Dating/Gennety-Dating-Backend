import { describe, expect, it } from "vitest";
import { probeMp4 } from "./mp4-probe.js";

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

function mvhdV0(timescale: number, duration: number): Buffer {
  const p = Buffer.alloc(100);
  p[0] = 0; // version
  p.writeUInt32BE(timescale, 12);
  p.writeUInt32BE(duration, 16);
  return box("mvhd", p);
}

function mvhdV1(timescale: number, duration: bigint): Buffer {
  const p = Buffer.alloc(112);
  p[0] = 1;
  p.writeUInt32BE(timescale, 20);
  p.writeBigUInt64BE(duration, 24);
  return box("mvhd", p);
}

const ftyp = box("ftyp", Buffer.from("isom\0\0\x02\0isomiso2avc1mp41", "latin1"));

describe("probeMp4", () => {
  it("reads the duration from moov/mvhd (version 0)", () => {
    const file = Buffer.concat([ftyp, box("free", Buffer.alloc(4)), box("moov", mvhdV0(600, 4800))]);
    expect(probeMp4(file)).toEqual({ durationSeconds: 8 });
  });

  it("reads the 64-bit layout (version 1)", () => {
    const file = Buffer.concat([ftyp, box("moov", mvhdV1(90_000, 1_080_000n))]);
    expect(probeMp4(file)).toEqual({ durationSeconds: 12 });
  });

  it("finds moov after a large mdat, as a non-faststart export has it", () => {
    const file = Buffer.concat([ftyp, box("mdat", Buffer.alloc(4096)), box("moov", mvhdV0(1000, 9500))]);
    expect(probeMp4(file)?.durationSeconds).toBe(9.5);
  });

  it("refuses anything that does not open with ftyp", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(40)]);
    expect(probeMp4(jpeg)).toBeNull();
    expect(probeMp4(Buffer.concat([box("moov", mvhdV0(600, 600)), ftyp]))).toBeNull();
  });

  it("refuses a box whose size points past the buffer", () => {
    const lying = Buffer.concat([ftyp, box("moov", mvhdV0(600, 600))]);
    lying.writeUInt32BE(10_000_000, ftyp.length);
    expect(probeMp4(lying)).toBeNull();
  });

  it("refuses a zero timescale instead of dividing by it", () => {
    expect(probeMp4(Buffer.concat([ftyp, box("moov", mvhdV0(0, 600))]))).toBeNull();
  });
});
