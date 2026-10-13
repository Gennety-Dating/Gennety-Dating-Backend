import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENT_LOOP_DELAY_WARN_MS } from "@gennety/shared";
import {
  collectRuntimeMetrics,
  logRuntimeMetrics,
  type RuntimeMetrics,
} from "./runtime-metrics.js";

const sources = {
  chatQueue: () => ({ pending: 7, active: 4, waitingForSlot: 2 }),
  renderPool: () => "worker",
  runningTicks: () => 3,
};

describe("collectRuntimeMetrics", () => {
  it("reports the loop delay in milliseconds next to the queue and memory counts", () => {
    const loop = {
      percentile: (p: number) => (p === 50 ? 10_400_000 : 151_260_000),
      max: 812_000_000,
    };

    expect(
      collectRuntimeMetrics(loop, sources, { rss: 512 * 1024 * 1024, heapUsed: 200.4 * 1024 * 1024 }),
    ).toEqual({
      loopP50Ms: 10.4,
      loopP99Ms: 151.3,
      loopMaxMs: 812,
      chatPending: 7,
      chatActive: 4,
      chatWaitingForSlot: 2,
      ticksRunning: 3,
      renderPool: "worker",
      rssMb: 512,
      heapUsedMb: 200,
    });
  });
});

describe("logRuntimeMetrics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const base: RuntimeMetrics = {
    loopP50Ms: 1,
    loopP99Ms: 5,
    loopMaxMs: 9,
    chatPending: 0,
    chatActive: 0,
    chatWaitingForSlot: 0,
    ticksRunning: 0,
    renderPool: "cold",
    rssMb: 300,
    heapUsedMb: 120,
  };

  it("logs one structured line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logRuntimeMetrics(base);

    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line.startsWith("[runtime] ")).toBe(true);
    expect(JSON.parse(line.slice("[runtime] ".length))).toEqual(base);
  });

  it("warns once the p99 delay reaches the threshold", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logRuntimeMetrics({ ...base, loopP99Ms: EVENT_LOOP_DELAY_WARN_MS });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });
});
