import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A worker that dies mid-job (OOM on a large card) or hangs used to leave its
 * caller waiting forever: `retire` dropped the slot but never settled the job
 * it was running, nor woke the callers queued behind it. On production there
 * is one worker, so after the first death every card hung.
 */

const workers: FakeWorker[] = [];

class FakeWorker extends EventEmitter {
  posted: Array<{ id: number }> = [];
  terminated = false;
  constructor() {
    super();
    workers.push(this);
    setImmediate(() => this.emit("message", { ready: true }));
  }
  postMessage(message: { id: number }): void {
    this.posted.push(message);
  }
  ref(): void {}
  unref(): void {}
  async terminate(): Promise<number> {
    this.terminated = true;
    this.emit("exit", 1);
    return 1;
  }
}

vi.mock("node:worker_threads", () => ({ Worker: FakeWorker }));
vi.mock("node:os", () => ({ cpus: () => [{}] }));
const runJobInline = vi.hoisted(() => vi.fn());
vi.mock("./jobs.js", () => ({ runJobInline }));

const { runRenderJob, shutdownRenderPool } = await import("./pool.js");

const JOB = { kind: "svg-to-png" as const, svg: "<svg/>" };
const tickOnce = () => new Promise((resolve) => setImmediate(resolve));

describe("render pool failure paths", () => {
  beforeEach(() => {
    workers.length = 0;
    runJobInline.mockReset();
    runJobInline.mockResolvedValue(Buffer.from("inline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.useRealTimers();
    await shutdownRenderPool();
  });

  it("settles the job in flight and the queued one when the worker dies", async () => {
    const first = runRenderJob(JOB);
    await tickOnce();
    await tickOnce();
    const second = runRenderJob(JOB); // queued behind the busy single worker
    await tickOnce();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toHaveLength(1);

    workers[0]!.emit("exit", 1);

    // The crashed job falls back inline; the queued one re-enters the pool,
    // which respawns a worker for it.
    await expect(first).resolves.toEqual(Buffer.from("inline"));
    await tickOnce();
    await tickOnce();
    expect(workers).toHaveLength(2);
    const respawned = workers[1]!;
    const { id } = respawned.posted[0]!;
    respawned.emit("message", { id, ok: true, value: new Uint8Array([7]) });
    await expect(second).resolves.toEqual(Buffer.from([7]));
  });

  it("kills a worker whose job never answers and does not retry it inline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const job = runRenderJob(JOB);
    await tickOnce();
    await tickOnce();
    expect(workers[0]!.posted).toHaveLength(1);
    const outcome = job.then(
      () => "resolved",
      (err: Error) => err.message,
    );
    vi.advanceTimersByTime(3 * 60 * 1000);
    expect(await outcome).toMatch(/timed out/);
    expect(workers[0]!.terminated).toBe(true);
    expect(runJobInline).not.toHaveBeenCalled();
  });
});
