import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempMediaDirectory<T>(
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "gennety-media-"));
  await chmod(directory, 0o700);
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function writePrivateMediaFile(
  path: string,
  buffer: Buffer,
): Promise<void> {
  await writeFile(path, buffer, { mode: 0o600 });
}
