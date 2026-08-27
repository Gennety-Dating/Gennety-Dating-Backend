import { Router, type Request, type Response } from "express";
import { getOrCompute } from "../utils/cache.js";
import {
  MAU_WINDOW_DAYS,
  WAU_WINDOW_DAYS,
  dailySeries,
  parseDayKey,
  parseMonthKey,
  stickiness,
  summarizeActivity,
  toDayKey,
  uniqueUsers,
  windowEndingOn,
  byPlatform,
} from "../utils/activity.js";
import { loadActivityRows, countExcludedActive } from "../utils/activity-source.js";

/**
 * DAU / WAU / MAU.
 *
 * Definitions and their reasoning live in `admin/utils/activity.ts`; the
 * storage rationale is on the `UserActivityDay` model. This file is only the
 * HTTP surface: parse, load, hand to the pure functions, cache.
 *
 * Two things every endpoint here does the same way:
 *
 *   • **Days are UTC**, `YYYY-MM-DD`, in and out. The reader converts for
 *     display; nothing here takes a timezone parameter, because a metric whose
 *     bucket depends on who is asking cannot be compared across two answers.
 *   • **Test and synthetic accounts are excluded by default** and the number
 *     excluded is reported, so the endpoint never quietly disagrees with a
 *     row count someone runs by hand. `?includeTest=1` turns the filter off.
 */
export const activityRouter: Router = Router();

/** Longest window any endpoint here can be asked for. */
const MAX_RANGE_DAYS = 400;

const CACHE_TTL_SECONDS = 600;

function wantsTestAccounts(req: Request): boolean {
  return String(req.query["includeTest"] ?? "") === "1";
}

/**
 * The day a metric defaults to.
 *
 * YESTERDAY, not today, and this is the one default worth arguing about: today
 * is still filling, so a dashboard defaulting to it shows a number that climbs
 * all day and is lowest right after UTC midnight — which reads as a crash every
 * single morning. Today is one query parameter away when someone genuinely
 * wants the partial figure.
 */
function defaultDay(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
}

function badRequest(res: Response, error: string): void {
  res.status(400).json({ error });
}

// ---------------------------------------------------------------------------
// GET /admin/analytics/dau?date=YYYY-MM-DD
// One day, plus the WAU/MAU windows ending on it so the number has a scale.
// ---------------------------------------------------------------------------
activityRouter.get(
  "/admin/analytics/dau",
  async (req: Request, res: Response) => {
    const raw = req.query["date"];
    const day = raw === undefined ? defaultDay() : parseDayKey(String(raw));
    if (!day) return badRequest(res, "date must be YYYY-MM-DD");

    const includeTest = wantsTestAccounts(req);

    try {
      const data = await getOrCompute(
        `activity_dau:v1:${toDayKey(day)}:${includeTest ? "all" : "real"}`,
        CACHE_TTL_SECONDS,
        async () => {
          // One load covering the widest window (MAU); DAU and WAU are slices
          // of it. Three round trips for three overlapping ranges of the same
          // table would be three chances for them to disagree.
          const mauWindow = windowEndingOn(day, MAU_WINDOW_DAYS);
          const rows = await loadActivityRows(mauWindow.from, mauWindow.to, {
            includeTest,
          });
          const summary = summarizeActivity(rows, day);
          return {
            generatedAt: new Date().toISOString(),
            timezone: "UTC",
            includeTest,
            excludedTestUsers: includeTest
              ? 0
              : await countExcludedActive(mauWindow.from, mauWindow.to),
            ...summary,
          };
        },
        { req, res },
      );
      res.json(data);
    } catch (err) {
      console.error("[admin] dau error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/analytics/mau?month=YYYY-MM | ?days=30&end=YYYY-MM-DD
// ---------------------------------------------------------------------------
activityRouter.get(
  "/admin/analytics/mau",
  async (req: Request, res: Response) => {
    const monthRaw = req.query["month"];
    const daysRaw = req.query["days"];
    const endRaw = req.query["end"];
    const includeTest = wantsTestAccounts(req);

    let from: Date;
    let to: Date;
    let mode: "calendar_month" | "rolling";

    if (monthRaw !== undefined) {
      // A calendar month is offered because reporting asks for one, but it is
      // NOT the default — see MAU_WINDOW_DAYS for why a rolling window is the
      // comparable number at this product's weekly cadence.
      const parsed = parseMonthKey(String(monthRaw));
      if (!parsed) return badRequest(res, "month must be YYYY-MM");
      ({ from, to } = parsed);
      mode = "calendar_month";
    } else {
      const end = endRaw === undefined ? defaultDay() : parseDayKey(String(endRaw));
      if (!end) return badRequest(res, "end must be YYYY-MM-DD");
      const days = daysRaw === undefined ? MAU_WINDOW_DAYS : Number(daysRaw);
      if (!Number.isInteger(days) || days < 1 || days > MAX_RANGE_DAYS) {
        return badRequest(res, `days must be an integer 1..${MAX_RANGE_DAYS}`);
      }
      ({ from, to } = windowEndingOn(end, days));
      mode = "rolling";
    }

    try {
      const key = `activity_mau:v1:${mode}:${toDayKey(from)}:${toDayKey(to)}:${
        includeTest ? "all" : "real"
      }`;
      const data = await getOrCompute(
        key,
        CACHE_TTL_SECONDS,
        async () => {
          const rows = await loadActivityRows(from, to, { includeTest });
          const mau = uniqueUsers(rows);
          const series = dailySeries(rows, from, to);
          const lastDau = series[series.length - 1]?.dau ?? 0;
          return {
            generatedAt: new Date().toISOString(),
            timezone: "UTC",
            mode,
            from: toDayKey(from),
            to: toDayKey(to),
            days: series.length,
            mau,
            byPlatform: byPlatform(rows),
            // Averaged over the window rather than summed: summing DAU counts
            // a loyal user once per day they showed up, which is not a user
            // count at all.
            avgDau: series.length
              ? +(series.reduce((a, d) => a + d.dau, 0) / series.length).toFixed(2)
              : 0,
            stickinessPct: stickiness(lastDau, mau),
            includeTest,
            excludedTestUsers: includeTest ? 0 : await countExcludedActive(from, to),
          };
        },
        { req, res },
      );
      res.json(data);
    } catch (err) {
      console.error("[admin] mau error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/analytics/active?from=YYYY-MM-DD&to=YYYY-MM-DD
// The trend view: a zero-filled DAU series plus the headline block.
// ---------------------------------------------------------------------------
activityRouter.get(
  "/admin/analytics/active",
  async (req: Request, res: Response) => {
    const toRaw = req.query["to"];
    const fromRaw = req.query["from"];
    const includeTest = wantsTestAccounts(req);

    const to = toRaw === undefined ? defaultDay() : parseDayKey(String(toRaw));
    if (!to) return badRequest(res, "to must be YYYY-MM-DD");
    const from =
      fromRaw === undefined
        ? windowEndingOn(to, MAU_WINDOW_DAYS).from
        : parseDayKey(String(fromRaw));
    if (!from) return badRequest(res, "from must be YYYY-MM-DD");
    if (from > to) return badRequest(res, "from must not be after to");

    const spanDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (spanDays > MAX_RANGE_DAYS) {
      return badRequest(res, `range must be at most ${MAX_RANGE_DAYS} days`);
    }

    try {
      const key = `activity_series:v1:${toDayKey(from)}:${toDayKey(to)}:${
        includeTest ? "all" : "real"
      }`;
      const data = await getOrCompute(
        key,
        CACHE_TTL_SECONDS,
        async () => {
          // The headline block needs the MAU window ending on `to`, which can
          // start before `from` — load whichever reaches back further, then
          // slice, so the series and the summary come from one read.
          const mauFrom = windowEndingOn(to, MAU_WINDOW_DAYS).from;
          const loadFrom = mauFrom < from ? mauFrom : from;
          const rows = await loadActivityRows(loadFrom, to, { includeTest });

          const fromKey = toDayKey(from);
          const seriesRows = rows.filter((r) => r.day >= fromKey);

          return {
            generatedAt: new Date().toISOString(),
            timezone: "UTC",
            from: fromKey,
            to: toDayKey(to),
            includeTest,
            summary: summarizeActivity(rows, to),
            series: dailySeries(seriesRows, from, to),
          };
        },
        { req, res },
      );
      res.json(data);
    } catch (err) {
      console.error("[admin] active-series error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/analytics/active.csv?from=&to=
// Same series, as CSV — a spreadsheet is where a trend usually gets read.
// ---------------------------------------------------------------------------
activityRouter.get(
  "/admin/analytics/active.csv",
  async (req: Request, res: Response) => {
    const toRaw = req.query["to"];
    const fromRaw = req.query["from"];
    const to = toRaw === undefined ? defaultDay() : parseDayKey(String(toRaw));
    if (!to) return badRequest(res, "to must be YYYY-MM-DD");
    const from =
      fromRaw === undefined
        ? windowEndingOn(to, MAU_WINDOW_DAYS).from
        : parseDayKey(String(fromRaw));
    if (!from) return badRequest(res, "from must be YYYY-MM-DD");
    if (from > to) return badRequest(res, "from must not be after to");

    const spanDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (spanDays > MAX_RANGE_DAYS) {
      return badRequest(res, `range must be at most ${MAX_RANGE_DAYS} days`);
    }

    try {
      // Deliberately uncached: an export is asked for when someone wants the
      // real numbers right now, and handing them a ten-minute-old file is the
      // one place staleness is indefensible. It is also rare and bounded.
      const rows = await loadActivityRows(from, to, {
        includeTest: wantsTestAccounts(req),
      });
      const series = dailySeries(rows, from, to);
      const body = ["date,dau", ...series.map((d) => `${d.date},${d.dau}`)].join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="gennety-dau-${toDayKey(from)}_${toDayKey(to)}.csv"`,
      );
      res.send(`${body}\n`);
    } catch (err) {
      console.error("[admin] active-csv error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export { WAU_WINDOW_DAYS, MAU_WINDOW_DAYS };
