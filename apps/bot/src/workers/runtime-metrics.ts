import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  EVENT_LOOP_DELAY_RESOLUTION_MS,
  EVENT_LOOP_DELAY_WARN_MS,
  RUNTIME_METRICS_INTERVAL_MS,
} from "@gennety/shared";
import type { ChatQueueStats } from "../chat-queue.js";

/**
 * One log line a minute describing how loaded the process is (Phase-2 perf
 * work, 2026-10-13). One process runs the long poll, both HTTP servers and
 * every cron on a single vCPU, so the first questions about a slow bot are
 * "was the event loop blocked?" and "were updates queueing?" — and until now
 * nothing recorded either. Counts and timings only: no ids, no user data.
 */

export interface RuntimeMetricSources {
  chatQueue: () => ChatQueueStats;
  /** Where card rasterisation runs (`renderPoolStatus`). */
  renderPool: () => string;
  /** Guarded cron ticks in flight right now. */
  runningTicks: () => number;
}

export interface RuntimeMetrics {
  loopP50Ms: number;
  loopP99Ms: number;
  loopMaxMs: number;
  chatPending: number;
  chatActive: number;
  chatWaitingForSlot: number;
  ticksRunning: number;
  renderPool: string;
  rssMb: number;
  heapUsedMb: number;
}

/** The slice of an event-loop delay histogram this reads (nanoseconds). */
export interface LoopDelaySample {
  percentile(p: number): number;
  readonly max: number;
}

const NS_PER_MS = 1e6;
const BYTES_PER_MB = 1024 * 1024;

function ms(nanoseconds: number): number {
  return Math.round((nanoseconds / NS_PER_MS) * 10) / 10;
}

export function collectRuntimeMetrics(
  loop: LoopDelaySample,
  sources: RuntimeMetricSources,
  memory: Pick<NodeJS.MemoryUsage, "rss" | "heapUsed"> = process.memoryUsage(),
): RuntimeMetrics {
  const queue = sources.chatQueue();
  return {
    loopP50Ms: ms(loop.percentile(50)),
    loopP99Ms: ms(loop.percentile(99)),
    loopMaxMs: ms(loop.max),
    chatPending: queue.pending,
    chatActive: queue.active,
    chatWaitingForSlot: queue.waitingForSlot,
    ticksRunning: sources.runningTicks(),
    renderPool: sources.renderPool(),
    rssMb: Math.round(memory.rss / BYTES_PER_MB),
    heapUsedMb: Math.round(memory.heapUsed / BYTES_PER_MB),
  };
}

/** Logged as a warning once the event loop's p99 delay reaches the threshold. */
export function logRuntimeMetrics(metrics: RuntimeMetrics): void {
  const line = `[runtime] ${JSON.stringify(metrics)}`;
  if (metrics.loopP99Ms >= EVENT_LOOP_DELAY_WARN_MS) console.warn(line);
  else console.log(line);
}

/** Start the histogram and the once-a-minute line; the handle is for shutdown. */
export function startRuntimeMetrics(sources: RuntimeMetricSources): NodeJS.Timeout {
  const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_DELAY_RESOLUTION_MS });
  histogram.enable();
  const timer = setInterval(() => {
    logRuntimeMetrics(collectRuntimeMetrics(histogram, sources));
    histogram.reset();
  }, RUNTIME_METRICS_INTERVAL_MS);
  timer.unref();
  return timer;
}
