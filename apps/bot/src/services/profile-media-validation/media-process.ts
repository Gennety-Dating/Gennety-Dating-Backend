import { spawn } from "node:child_process";

export interface RunMediaCommandOptions {
  input?: Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface MediaCommandResult {
  stdout: Buffer;
  stderr: Buffer;
}

export async function runMediaCommand(
  command: string,
  args: readonly string[],
  options: RunMediaCommandOptions = {},
): Promise<MediaCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} timed out`));
    }, options.timeoutMs ?? 30_000);

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    }

    function collect(target: Buffer[], chunk: Buffer): void {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new Error(`${command} output exceeded limit`));
        return;
      }
      target.push(chunk);
    }

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(
          new Error(
            detail
              ? `${command} failed: ${detail}`
              : `${command} failed with code ${code}`,
          ),
        );
        return;
      }
      finish();
    });

    child.stdin.once("error", (error) => finish(error));
    child.stdin.end(options.input);
  });
}
