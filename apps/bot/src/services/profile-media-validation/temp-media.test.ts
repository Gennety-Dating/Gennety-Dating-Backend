import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  withTempMediaDirectory,
  writePrivateMediaFile,
} from "./temp-media.js";

describe("withTempMediaDirectory", () => {
  it("removes private media after success", async () => {
    let directory = "";
    await withTempMediaDirectory(async (path) => {
      directory = path;
      await writePrivateMediaFile(join(path, "media"), Buffer.from("x"));
      await expect(access(join(path, "media"))).resolves.toBeUndefined();
    });
    await expect(access(directory)).rejects.toThrow();
  });

  it("removes private media after an exception", async () => {
    let directory = "";
    await expect(
      withTempMediaDirectory(async (path) => {
        directory = path;
        await writePrivateMediaFile(join(path, "media"), Buffer.from("x"));
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    await expect(access(directory)).rejects.toThrow();
  });
});
