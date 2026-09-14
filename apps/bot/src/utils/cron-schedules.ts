/**
 * Boot-time validation of every cron expression the process schedules (A13-H8).
 *
 * Almost every schedule is an env override on top of a code default, and a typo
 * in one (`EXPIRY_CRON_SCHEDULE=15m`) used to surface only when `cron.schedule`
 * threw — inside the polling `onStart`, where it took every schedule registered
 * after it and both HTTP servers down with it, on a process PM2 still showed as
 * online. Checking them all before anything is started turns that into a loud
 * boot failure naming the variable.
 *
 * Every schedule is checked, including those of features that are switched off:
 * a malformed override is a configuration error whether or not today's flags
 * happen to register it, and finding out on the day the flag flips is worse.
 *
 * The validator is passed in (`cron.validate` from `index.ts`) rather than
 * imported, so this module stays free of the scheduler and its side effects.
 */
export type CronValidator = (expression: string) => boolean;

export function invalidCronSchedules(
  schedules: Readonly<Record<string, string>>,
  validate: CronValidator,
): string[] {
  return Object.entries(schedules)
    .filter(([, expression]) => !validate(expression))
    .map(([name, expression]) => `${name}="${expression}"`);
}

export function assertValidCronSchedules(
  schedules: Readonly<Record<string, string>>,
  validate: CronValidator,
): void {
  const invalid = invalidCronSchedules(schedules, validate);
  if (invalid.length > 0) {
    throw new Error(
      `Invalid cron schedule(s): ${invalid.join(", ")}. ` +
        "Use a 5- or 6-field cron expression, e.g. \"*/15 * * * *\".",
    );
  }
}
