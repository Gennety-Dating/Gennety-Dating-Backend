import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { assertValidCronSchedules, invalidCronSchedules } from "./cron-schedules.js";

// The real node-cron validator, loaded through Node's own resolver: the ESM
// entry node-cron advertises is CommonJS inside, which Vite refuses to transform.
const { validate } = createRequire(import.meta.url)("node-cron") as {
  validate: (expression: string) => boolean;
};

// A13-H8: a malformed `*_CRON_SCHEDULE` override used to throw from inside the
// polling `onStart`, leaving a process with no crons and no HTTP servers that
// PM2 still showed as online.
describe("cron schedule validation", () => {
  it("accepts the shapes the process actually schedules", () => {
    expect(
      invalidCronSchedules({
        MATCH_CRON_SCHEDULE: "0 18 * * 4",
        EXPIRY_CRON_SCHEDULE: "*/15 * * * *",
        STATUS_TIMER_CRON_SCHEDULE: "* * * * *",
        VENUE_CONCENTRATION_ALERT_CRON_SCHEDULE: "0 10 * * 5",
      }, validate),
    ).toEqual([]);
  });

  it("names every broken schedule, not just the first", () => {
    expect(
      invalidCronSchedules({
        EXPIRY_CRON_SCHEDULE: "15m",
        RETENTION_CRON_SCHEDULE: "45 3 * * *",
        PROFILER_CRON_SCHEDULE: "61 * * * *",
      }, validate),
    ).toEqual(['EXPIRY_CRON_SCHEDULE="15m"', 'PROFILER_CRON_SCHEDULE="61 * * * *"']);
  });

  it("fails the boot with a message that says which variable to fix", () => {
    expect(() => assertValidCronSchedules({ DROP: "every thursday" }, validate)).toThrow(
      /Invalid cron schedule\(s\): DROP="every thursday"/,
    );
  });
});
