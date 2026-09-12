/**
 * Minimal MP4 / QuickTime probe: is this buffer an ISO-BMFF file, and how long
 * is it?
 *
 * Exists for one caller — the announcement media upload (decision 2026-09-13),
 * where a video must be at most `ANNOUNCEMENT_MEDIA.videoMaxSeconds`. The
 * client-supplied Content-Type is attacker-controlled, and pulling in ffprobe
 * for a length check on an admin-only route would add a system dependency to
 * the droplet. The container header answers both questions: the first box is
 * `ftyp`, and `moov/mvhd` carries the movie's timescale and duration.
 *
 * Reads box headers only; never trusts a size that points past the buffer.
 */

export interface Mp4Probe {
  durationSeconds: number;
}

interface Box {
  type: string;
  /** Offset of the box payload (after the header). */
  start: number;
  /** Offset one past the end of the box. */
  end: number;
}

function readBoxes(buf: Buffer, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  let offset = from;
  while (offset + 8 <= to) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > to) break;
      const large = buf.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < header || offset + size > to) break;
    boxes.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  return boxes;
}

export function probeMp4(buf: Buffer): Mp4Probe | null {
  if (buf.length < 16) return null;
  const top = readBoxes(buf, 0, buf.length);
  if (top[0]?.type !== "ftyp") return null;
  const moov = top.find((b) => b.type === "moov");
  if (!moov) return null;
  const mvhd = readBoxes(buf, moov.start, moov.end).find((b) => b.type === "mvhd");
  if (!mvhd) return null;

  const version = buf[mvhd.start];
  // version(1) + flags(3), then creation/modification times, timescale, duration.
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (mvhd.start + 32 > mvhd.end) return null;
    timescale = buf.readUInt32BE(mvhd.start + 20);
    const raw = buf.readBigUInt64BE(mvhd.start + 24);
    if (raw > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    duration = Number(raw);
  } else {
    if (mvhd.start + 20 > mvhd.end) return null;
    timescale = buf.readUInt32BE(mvhd.start + 12);
    duration = buf.readUInt32BE(mvhd.start + 16);
  }
  if (timescale === 0) return null;
  return { durationSeconds: duration / timescale };
}
