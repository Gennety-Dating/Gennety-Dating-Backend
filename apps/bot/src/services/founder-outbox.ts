/** Durable transport outbox for the founder bot only. No user-flow/schema changes.
 * Accepted Telegram requests are persisted before network I/O; retries are
 * at-least-once (Telegram offers no idempotency key for an ambiguous timeout).
 * Files contain personal information: mode 0600, directory 0700, never logs.
 */
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Api, InputFile, type RawApi } from "grammy";
import { installApiLimits } from "../api-limits.js";

type Encoded = null | boolean | number | string | Encoded[] | { [key: string]: Encoded };
type RecordRow = { method: string; payload: Encoded; attempts: number; retryAt: number; created: number };
type Sender = (method: string, payload: unknown) => Promise<unknown>;
const SUPPORTED = new Set(["sendMessage", "sendPhoto", "sendMediaGroup", "sendDocument"]);

export async function encodePayload(value: unknown): Promise<Encoded> {
  if (value instanceof InputFile) {
    const raw = await value.toRaw();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (raw instanceof Uint8Array) chunks.push(raw);
    else for await (const chunk of raw) {
      length += chunk.length;
      if (length > 50 * 1024 * 1024) throw new Error("Founder upload too large");
      chunks.push(chunk);
    }
    return { __founderUpload: Buffer.concat(chunks).toString("base64"), filename: value.filename ?? "photo.jpg" };
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return Promise.all(value.map(encodePayload));
  if (typeof value === "object") {
    const out: { [key: string]: Encoded } = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = await encodePayload(v);
    return out;
  }
  throw new Error("Unsupported founder payload");
}

export function decodePayload(value: Encoded): unknown {
  if (Array.isArray(value)) return value.map(decodePayload);
  if (value !== null && typeof value === "object") {
    if (typeof value.__founderUpload === "string") {
      return new InputFile(Buffer.from(value.__founderUpload, "base64"), String(value.filename));
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodePayload(v)]));
  }
  return value;
}

export class FounderOutbox {
  private readonly active = new Map<string, Promise<unknown>>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly dir: string, private readonly sender: Sender) {}

  private async save(file: string, row: RecordRow): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = file + ".tmp";
    const handle = await open(tmp, "w", 0o600);
    try { await handle.writeFile(JSON.stringify(row)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(tmp, file);
    const directory = await open(this.dir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  /** Serialize admission so identical simultaneous sends cannot race. */
  async enqueue(method: string, payload: Encoded): Promise<string> {
    const admit = async () => {
      const digest = createHash("sha256").update(JSON.stringify([method, payload])).digest("hex");
      const file = join(this.dir, digest + ".json");
      try { await readFile(file); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        await this.save(file, { method, payload, attempts: 0, retryAt: 0, created: Date.now() });
      }
      return file;
    };
    const next = this.tail.then(admit);
    this.tail = next.catch(() => {});
    return next;
  }

  deliver(file: string): Promise<unknown> {
    const active = this.active.get(file);
    if (active) return active;
    const pending = this.deliverOnce(file).finally(() => { this.active.delete(file); });
    this.active.set(file, pending);
    return pending;
  }

  private async deliverOnce(file: string): Promise<unknown> {
    {
      const row = JSON.parse(await readFile(file, "utf8")) as RecordRow;
      if (row.retryAt > Date.now()) return undefined;
      try {
        const result = await this.sender(row.method, decodePayload(row.payload));
        await unlink(file);
        return result;
      } catch (err) {
        row.attempts++;
        row.retryAt = Date.now() + Math.min(3_600_000, 5_000 * 2 ** Math.min(row.attempts, 10));
        await this.save(file, row);
        // Permanent API errors are retained for operator inspection, not discarded.
        if (row.attempts === 1 || row.attempts % 10 === 0) console.warn("[founder-outbox] send deferred", { attempts: row.attempts });
        throw err;
      }
    }
  }

  async drain(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.dir)).filter(f => /^[a-f0-9]{64}\.json$/.test(f));
    for (const name of files) {
      try { await this.deliver(join(this.dir, name)); }
      catch { /* retained on disk; bounded backoff, no personal data in logs */ }
    }
  }
}

export function installFounderOutbox(api: Api<RawApi>, token: string, testTransport?: Api<RawApi>): () => void {
  if (process.env.NODE_ENV === "test") return () => {};
  const transport = testTransport ?? new Api(token, { timeoutSeconds: 60 });
  installApiLimits(transport);
  const send = transport.raw as unknown as Record<string, (payload: unknown) => Promise<unknown>>;
  const box = new FounderOutbox(process.env.FOUNDER_OUTBOX_DIR ?? "/var/lib/gennety-founder-outbox",
    (method, payload) => send[method]!(payload));
  // Outermost transformer: persist once, retries use a separate transport.
  api.config.use(async (prev, method, payload, signal) => {
    if (!SUPPORTED.has(method)) return prev(method, payload, signal);
    const encoded = await encodePayload(payload);
    const file = await box.enqueue(method, encoded);
    // The result is not consumed by founder-notify; preserve raw API's type at this boundary.
    const result = await box.deliver(file);
    return { ok: true, result: result ?? true } as Awaited<ReturnType<typeof prev>>;
  });
  const timer = setInterval(() => { void box.drain().catch(() => console.warn("[founder-outbox] drain unavailable")); }, 15_000);
  timer.unref();
  void box.drain().catch(() => console.warn("[founder-outbox] startup drain unavailable"));
  return () => clearInterval(timer);
}
