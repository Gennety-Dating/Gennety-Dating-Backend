import { describe, expect, it } from "vitest";
import {
  readResponseBuffer,
  ResponseBodyTooLargeError,
} from "./bounded-response.js";

describe("readResponseBuffer", () => {
  it("returns a response body below the limit", async () => {
    const result = await readResponseBuffer(new Response("hello"), 5);
    expect(result.toString()).toBe("hello");
  });

  it("rejects a declared body that is too large", async () => {
    const response = new Response("x", {
      headers: { "content-length": "999" },
    });
    await expect(readResponseBuffer(response, 10)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
  });

  it("rejects a streamed body that exceeds a false small Content-Length", async () => {
    const response = new Response("0123456789", {
      headers: { "content-length": "1" },
    });
    await expect(readResponseBuffer(response, 5)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
  });
});
