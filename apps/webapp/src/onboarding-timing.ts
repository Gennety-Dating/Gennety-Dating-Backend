const LONG_LINE_MIN_CHARS = 50;
const LONG_LINE_HOLD_MS = 2200;

export function typewriterLineHoldMs(
  parts: readonly string[],
  baseHoldMs: number,
): number {
  const lineLength = parts.join("").trim().length;
  return lineLength >= LONG_LINE_MIN_CHARS
    ? Math.max(baseHoldMs, LONG_LINE_HOLD_MS)
    : baseHoldMs;
}
