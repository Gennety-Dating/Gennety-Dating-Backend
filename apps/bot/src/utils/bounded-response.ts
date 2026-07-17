/**
 * Read an HTTP response body without trusting the upstream Content-Length.
 * Node's `Response.arrayBuffer()` is otherwise unbounded and can exhaust the
 * bot process when an upstream proxy/provider returns an unexpectedly large
 * payload.
 */
export async function readResponseBuffer(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }

  const rawContentLength = response.headers?.get?.("content-length");
  if (rawContentLength !== null && rawContentLength !== undefined) {
    const declaredBytes = Number(rawContentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await response.body?.cancel();
      throw new ResponseBodyTooLargeError(maxBytes);
    }
  }

  // Real fetch Responses expose a ReadableStream. The fallback keeps the
  // helper compatible with small test/provider shims while still validating
  // the final byte count.
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new ResponseBodyTooLargeError(maxBytes);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ResponseBodyTooLargeError(maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

export class ResponseBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`HTTP response body exceeds ${maxBytes} bytes`);
    this.name = "ResponseBodyTooLargeError";
  }
}
