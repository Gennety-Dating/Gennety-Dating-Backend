import { prisma } from "@gennety/db";
import { PULSE_ANALYTICS, PULSE_SCREENS, pulseScreen, type PulseScreen } from "@gennety/shared";
import { env } from "../../config.js";
import { loadPayerIndex } from "../../services/purchases.js";
import {
  daysEnding,
  frictionScore,
  funnelDefs,
  funnelTransitions,
  insightWeight,
  isSmallSample,
  recentWindow,
  screenTitle,
  screenWindowStats,
  shiftDay,
  sumByDim,
  type ScreenWindowStats,
} from "../../services/pulse/detectors.js";
import { PULSE_METRICS, PULSE_METRIC_NAMES } from "../../services/pulse/metrics-catalog.js";
import { SERVER_ONBOARDING_STEPS } from "../../services/pulse/rollup.js";
import { detectRageClusters, tapPointsOf, type MetricRow } from "../../services/pulse/rollup-math.js";
import {
  lastClientEventAt,
  lastRollupAt,
  loadClientEvents,
  loadExcludedUserIds,
  loadJourneyBundle,
  loadStuckPeople,
  optInShareNow,
  readMetricDays,
  recentlyActiveUserIds,
  type JourneyBundle,
} from "../../services/pulse/source.js";
import type { StuckPerson } from "../../services/pulse/detectors.js";
import { adminQuery, adminQueryExclusive } from "./db-gate.js";
import { buildJourneyItems } from "./pulse-journey.js";
import type {
  PulseBriefInsight,
  PulseBriefResponse,
  PulseCatalogResponse,
  PulseDataFreshness,
  PulseFunnel,
  PulseFunnelsResponse,
  PulseInsight,
  PulseInsightKind,
  PulseInsightsResponse,
  PulseJourney,
  PulseJourneyResponse,
  PulseJourneysResponse,
  PulseKpi,
  PulsePoint,
  PulseScreenDay,
  PulseScreenDetailResponse,
  PulseScreenSummary,
  PulseScreenWindow,
  PulseScreensResponse,
  PulseSeverity,
} from "./pulse-types.js";

/**
 * `/admin/pulse/*` response builders. The route layer only parses the query
 * and caches; everything a response contains is decided here, from the
 * pre-aggregate (`metric_days`, `insights`) wherever possible. Raw
 * `client_events` are read only for what has no aggregate: tap coordinates of
 * ONE screen and the journeys of named people.
 *
 * Every DB call goes through `adminQuery` — the admin surface shares the bot's
 * pool and must not starve it (`db-gate.ts`).
 */

const A = PULSE_ANALYTICS;
const DAY_MS = 86_400_000;

/** The last complete UTC day. */
export function asOfDay(now: Date): string {
  return shiftDay(now.toISOString().slice(0, 10), -1);
}

function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export async function dataFreshness(now: Date = new Date()): Promise<PulseDataFreshness> {
  const [lastEvent, lastRollup, optIn] = await Promise.all([
    adminQuery(() => lastClientEventAt()),
    adminQuery(() => lastRollupAt()),
    adminQuery(() => optInShareNow()),
  ]);
  const stale =
    lastRollup === null || now.getTime() - lastRollup.getTime() > A.staleAfterHours * 3_600_000;
  return {
    lastEventAt: lastEvent?.toISOString() ?? null,
    lastRollupAt: lastRollup?.toISOString() ?? null,
    rollupStale: stale,
    clientEventsEnabled: env.CLIENT_EVENTS_ENABLED === true,
    optInShare: optIn.share,
    optInN: optIn.n,
  };
}

async function envelope(now: Date): Promise<{ generatedAt: string; dataFreshness: PulseDataFreshness }> {
  return { generatedAt: now.toISOString(), dataFreshness: await dataFreshness(now) };
}

/** `metric_days` for the 35 days ending on `asOf`. */
async function windowRows(asOf: string): Promise<MetricRow[]> {
  return adminQuery(() => readMetricDays(shiftDay(asOf, -(A.rollupWindowDays - 1)), asOf));
}

// ─────────────────────────────────────────────────────────────────────────────
// Insights
// ─────────────────────────────────────────────────────────────────────────────

type InsightRow = Awaited<ReturnType<typeof prisma.insight.findMany>>[number];

function toInsight(r: InsightRow): PulseInsight {
  const evidence =
    r.evidence && typeof r.evidence === "object" && !Array.isArray(r.evidence)
      ? (r.evidence as Record<string, unknown>)
      : {};
  return {
    id: r.id,
    key: r.key,
    kind: r.kind as PulseInsightKind,
    severity: Math.min(3, Math.max(1, r.severity)) as PulseSeverity,
    scope: r.scope,
    title: r.title,
    value: r.value,
    baseline: r.baseline,
    n: r.n,
    smallSample: r.smallSample,
    evidence,
    codeHint: r.codeHint,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    weight: insightWeight(r),
  };
}

function byWeight(a: PulseInsight, b: PulseInsight): number {
  return b.weight - a.weight || b.severity - a.severity || b.lastSeenAt.localeCompare(a.lastSeenAt);
}

async function loadInsights(status: "open" | "all"): Promise<PulseInsight[]> {
  const rows = await adminQuery(() =>
    prisma.insight.findMany({
      where: status === "open" ? { resolvedAt: null } : {},
      orderBy: { lastSeenAt: "desc" },
      take: 200,
    }),
  );
  return rows.map(toInsight).sort(byWeight);
}

export async function buildInsights(
  status: "open" | "all",
  now: Date = new Date(),
): Promise<PulseInsightsResponse> {
  const [env_, insights] = await Promise.all([envelope(now), loadInsights(status)]);
  return { ...env_, status, insights };
}

// ─────────────────────────────────────────────────────────────────────────────
// Brief
// ─────────────────────────────────────────────────────────────────────────────

function sumMetric(rows: readonly MetricRow[], metric: MetricRow["metric"], days: ReadonlySet<string>, dims?: ReadonlySet<string>): number {
  let s = 0;
  for (const [dim, v] of sumByDim(rows, metric, days)) {
    if (dims && !dims.has(dim)) continue;
    s += v.value;
  }
  return s;
}

/**
 * Revenue in USD for `[since, until)`, real payers only. The purchase ledger is
 * the one place the "is this row money" rules live (`services/purchases.ts`),
 * so this reuses its index rather than summing tables. Null on any failure —
 * the brief must not die because a payments table is slow.
 */
async function revenueUsd(since: Date, until: Date, excluded: ReadonlySet<string>): Promise<number | null> {
  try {
    const index = await adminQueryExclusive(() => loadPayerIndex({ since, until }));
    let cents = 0;
    for (const [userId, entry] of index.byUser) {
      if (!excluded.has(userId)) cents += entry.usdCents;
    }
    return Math.round(cents) / 100;
  } catch (err) {
    console.warn("[admin] pulse brief: revenue unavailable:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function buildBrief(now: Date = new Date()): Promise<PulseBriefResponse> {
  const asOf = asOfDay(now);
  const thisWeek = daysEnding(asOf, 7);
  const lastWeek = daysEnding(asOf, 7, 7);
  const tw = { from: shiftDay(asOf, -6), to: asOf };
  const lw = { from: shiftDay(asOf, -13), to: shiftDay(asOf, -7) };

  const excluded = await adminQuery(() => loadExcludedUserIds());
  const [env_, rows, insights, revThis, revLast] = await Promise.all([
    envelope(now),
    windowRows(asOf),
    loadInsights("open"),
    revenueUsd(dayStart(tw.from), dayStart(shiftDay(tw.to, 1)), excluded),
    revenueUsd(dayStart(lw.from), dayStart(shiftDay(lw.to, 1)), excluded),
  ]);

  // Server tracks only: they are complete (no consent gate), and counting the
  // iOS client track too would count one iOS person twice.
  const serverTracks = new Set(["bot", "ios_server"]);
  const kpi = (
    key: PulseKpi["key"],
    label: string,
    unit: PulseKpi["unit"],
    a: number | null,
    b: number | null,
  ): PulseKpi => ({
    key,
    label,
    thisWeek: a,
    lastWeek: b,
    unit,
    smallSample: unit === "usd" ? false : isSmallSample(Math.min(a ?? 0, b ?? 0)),
  });
  const kpis: PulseKpi[] = [
    kpi("new_users", "Новые аккаунты", "people", sumMetric(rows, "signups", thisWeek), sumMetric(rows, "signups", lastWeek)),
    kpi(
      "onboarding_completed",
      "Закончили анкету (сервер: бот + iOS)",
      "people",
      sumMetric(rows, "onboarding_completed", thisWeek, serverTracks),
      sumMetric(rows, "onboarding_completed", lastWeek, serverTracks),
    ),
    kpi(
      "dates_scheduled",
      "Пары, согласовавшие время (по дню создания пары)",
      "matches",
      sumMetric(rows, "date_funnel", thisWeek, new Set(["time_agreed"])),
      sumMetric(rows, "date_funnel", lastWeek, new Set(["time_agreed"])),
    ),
    kpi("revenue_usd", "Выручка, $ (оценка, Stars по курсу)", "usd", revThis, revLast),
  ];

  const top = insights.slice(0, A.briefMaxInsights);
  const compact: PulseBriefInsight[] = top.map((i) => ({
    id: i.id,
    kind: i.kind,
    severity: i.severity,
    scope: i.scope,
    title: i.title,
    n: i.n,
    smallSample: i.smallSample,
    codeHint: i.codeHint,
    weight: i.weight,
  }));

  const next = [
    ...(env_.dataFreshness.rollupStale
      ? [{ endpoint: "/admin/pulse/catalog", why: "Ночной пересчёт устарел или не запускался — сначала проверь крон, числа ниже вчерашние или пустые" }]
      : []),
    { endpoint: "/admin/pulse/funnels", why: "Онбординг по платформам и путь свидания — где теряем людей" },
    { endpoint: "/admin/pulse/screens", why: "Все экраны с трением, временем и выходами за 7/28 дней" },
    ...top
      .filter((i) => pulseScreen(i.scope) !== null)
      .slice(0, 3)
      .map((i) => ({ endpoint: `/admin/pulse/screens/${i.scope}`, why: `Касания и дни экрана из находки «${i.title.slice(0, 60)}»` })),
    ...(insights.some((i) => i.kind === "stuck_people")
      ? [{ endpoint: "/admin/pulse/journeys?stuck=1&limit=5", why: "Пути застрявших людей — общий паттерн" }]
      : []),
    { endpoint: "/admin/pulse/insights?status=all", why: "Все находки с доказательствами, включая закрытые" },
  ];

  return {
    ...env_,
    asOf,
    thisWeek: tw,
    lastWeek: lw,
    kpis,
    insights: compact,
    openInsights: insights.length,
    next,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Screens
// ─────────────────────────────────────────────────────────────────────────────

function toWindow(s: ScreenWindowStats | undefined): PulseScreenWindow {
  const v = s ?? {
    views: 0,
    viewerDays: 0,
    left: 0,
    quickBack: 0,
    background: 0,
    taps: 0,
    deadTaps: 0,
    rageTaps: 0,
    dwellP50Ms: null,
    dwellP90Ms: null,
    dwellN: 0,
    firstActionP50Ms: null,
    firstActionN: 0,
  };
  const small = isSmallSample(v.views);
  return {
    views: v.views,
    viewerDays: v.viewerDays,
    left: v.left,
    dwellP50Ms: v.dwellP50Ms,
    dwellP90Ms: v.dwellP90Ms,
    firstActionP50Ms: v.firstActionP50Ms,
    quickBack: v.quickBack,
    deadTaps: v.deadTaps,
    rageTaps: v.rageTaps,
    exits: v.background,
    exitShare: v.left > 0 && !isSmallSample(v.left) ? +(v.background / v.left).toFixed(4) : null,
    friction: frictionScore(v),
    smallSample: small,
  };
}

function screenMeta(screen: string): Pick<PulseScreenSummary, "title" | "platform" | "codeHint" | "known"> {
  const meta = pulseScreen(screen);
  return {
    title: screenTitle(screen),
    platform: meta?.platform ?? null,
    codeHint: meta?.codeHint ?? null,
    known: meta !== null,
  };
}

export async function buildScreens(now: Date = new Date()): Promise<PulseScreensResponse> {
  const asOf = asOfDay(now);
  const [env_, rows] = await Promise.all([envelope(now), windowRows(asOf)]);
  const d7 = screenWindowStats(rows, recentWindow(asOf));
  const d28 = screenWindowStats(rows, daysEnding(asOf, 28));
  const screens: PulseScreenSummary[] = [...d28.keys()].map((screen) => ({
    screen,
    ...screenMeta(screen),
    d7: toWindow(d7.get(screen)),
    d28: toWindow(d28.get(screen)),
  }));
  screens.sort(
    (a, b) => (b.d7.friction ?? -1) - (a.d7.friction ?? -1) || b.d7.views - a.d7.views || a.screen.localeCompare(b.screen),
  );
  return { ...env_, asOf, screens };
}

/** Screen keys are the client's closed snake_case list (spec §3, §4). */
export function isScreenKey(raw: string): boolean {
  return /^[a-z0-9_]{1,32}$/.test(raw);
}

export async function buildScreenDetail(screen: string, now: Date = new Date()): Promise<PulseScreenDetailResponse> {
  const asOf = asOfDay(now);
  const from28 = dayStart(shiftDay(asOf, -27));
  const toEnd = dayStart(shiftDay(asOf, 1));
  const excluded = await adminQuery(() => loadExcludedUserIds());
  const [env_, rows, raw] = await Promise.all([
    envelope(now),
    windowRows(asOf),
    adminQuery(() =>
      loadClientEvents(from28, toEnd, excluded, {
        screen,
        types: ["screen_view", "screen_left", "tap", "dead_tap"],
      }),
    ),
  ]);

  const mine = rows.filter((r) => r.dim === screen);
  const d7 = screenWindowStats(mine, recentWindow(asOf)).get(screen);
  const d28 = screenWindowStats(mine, daysEnding(asOf, 28)).get(screen);

  const dayKeys = [...daysEnding(asOf, 28)].sort();
  const days: PulseScreenDay[] = [];
  for (const day of dayKeys) {
    const s = screenWindowStats(mine, new Set([day])).get(screen);
    if (!s) continue;
    days.push({
      day,
      views: s.views,
      left: s.left,
      dwellP50Ms: s.dwellP50Ms,
      dwellP90Ms: s.dwellP90Ms,
      firstActionP50Ms: s.firstActionP50Ms,
      quickBack: s.quickBack,
      exits: s.background,
      taps: s.taps,
      deadTaps: s.deadTaps,
      rageTaps: s.rageTaps,
    });
  }

  const tapEvents = raw.rows.filter((e) => e.type === "tap" || e.type === "dead_tap");
  const points = tapPointsOf(tapEvents);
  const newestFirst = [...points].sort((a, b) => b.at.getTime() - a.at.getTime());
  const deadSet = new Set(tapEvents.filter((e) => e.type === "dead_tap").map((e) => e.id));
  const deadPoints: PulsePoint[] = tapEvents
    .filter((e) => deadSet.has(e.id))
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, A.tapPointsMax)
    .map((e) => [Number(e.props["x"]), Number(e.props["y"])]);
  const rage: PulsePoint[] = detectRageClusters(points)
    .flatMap((c) => c.points)
    .slice(0, A.tapPointsMax);

  const elements = new Map<string, number>();
  for (const e of tapEvents) {
    const el = e.props["element"];
    if (e.type === "tap" && typeof el === "string") elements.set(el, (elements.get(el) ?? 0) + 1);
  }

  const versions = new Map<string, { views: number; quickBack: number; deadTaps: number }>();
  for (const e of raw.rows) {
    const key = e.appVersion ?? "unknown";
    const v = versions.get(key) ?? { views: 0, quickBack: 0, deadTaps: 0 };
    if (e.type === "screen_view") v.views += 1;
    if (e.type === "dead_tap") v.deadTaps += 1;
    if (
      e.type === "screen_left" &&
      e.props["exit"] === "back" &&
      typeof e.props["dwell_ms"] === "number" &&
      e.props["dwell_ms"] < A.quickBackMs
    ) {
      v.quickBack += 1;
    }
    versions.set(key, v);
  }

  const items = [...sumByDim(rows, "item_seen", recentWindow(asOf))]
    .filter(([dim]) => dim.startsWith(`${screen}:`))
    .map(([dim, v]) => ({ item: dim.slice(screen.length + 1), seen: v.value, viewerDays: v.n }))
    .sort((a, b) => a.seen / Math.max(1, a.viewerDays) - b.seen / Math.max(1, b.viewerDays));

  const meta = pulseScreen(screen);
  return {
    ...env_,
    screen,
    title: screenTitle(screen),
    platform: meta?.platform ?? null,
    codeHint: meta?.codeHint ?? null,
    tracksTaps: meta?.tracksTaps === true,
    d7: toWindow(d7),
    d28: toWindow(d28),
    days,
    taps: {
      points: newestFirst.slice(0, A.tapPointsMax).map((p) => [p.x, p.y] as PulsePoint),
      dead: deadPoints,
      rage,
      total: points.length,
      truncated: points.length > A.tapPointsMax || raw.truncated,
    },
    elements: [...elements]
      .map(([element, taps]) => ({ element, taps }))
      .sort((a, b) => b.taps - a.taps)
      .slice(0, 30),
    versions: [...versions]
      .map(([appVersion, v]) => ({ appVersion, ...v }))
      .sort((a, b) => b.views - a.views),
    items,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Journeys
// ─────────────────────────────────────────────────────────────────────────────

function journeyPlatform(bundle: JourneyBundle, userId: string, accountPlatform: string): string {
  const events = bundle.events.get(userId) ?? [];
  const last = events[events.length - 1];
  if (last) return last.platform;
  return accountPlatform === "telegram" ? "bot" : "ios";
}

function whereTitle(where: string): string {
  if (where.startsWith("step:")) return `шаг анкеты ${where.slice(5)}`;
  if (where.startsWith("match:")) return `пара: ${where.slice(6)}`;
  return screenTitle(where);
}

function assembleJourneys(
  bundle: JourneyBundle,
  order: readonly string[],
  stuck: ReadonlyMap<string, StuckPerson>,
  maxItems: number,
): PulseJourney[] {
  const users = new Map(bundle.users.map((u) => [u.id, u]));
  const out: PulseJourney[] = [];
  for (const userId of order) {
    const u = users.get(userId);
    if (!u) continue;
    const { items, truncated } = buildJourneyItems(
      {
        events: bundle.events.get(userId) ?? [],
        steps: bundle.steps.get(userId) ?? [],
        matchEvents: bundle.matchEvents.get(userId) ?? [],
        signupAt: u.createdAt,
        verifiedAt: u.verifiedAt,
      },
      maxItems,
    );
    const s = stuck.get(userId);
    out.push({
      userId,
      platform: journeyPlatform(bundle, userId, u.platform),
      signupDate: u.createdAt.toISOString().slice(0, 10),
      stuck: s
        ? { since: s.lastMovementAt.toISOString(), where: s.where, whereTitle: whereTitle(s.where), phase: s.phase }
        : null,
      items,
      truncated,
    });
  }
  return out;
}

export async function buildJourneys(
  opts: { stuckOnly: boolean; limit: number },
  now: Date = new Date(),
): Promise<PulseJourneysResponse> {
  const from = new Date(now.getTime() - A.journeyDays * DAY_MS);
  const stuckList = await adminQuery(() => loadStuckPeople(now));
  const stuckMap = new Map(stuckList.map((p) => [p.userId, p]));
  let order: string[];
  if (opts.stuckOnly) {
    order = [...stuckList]
      .sort((a, b) => b.lastMovementAt.getTime() - a.lastMovementAt.getTime())
      .slice(0, opts.limit)
      .map((p) => p.userId);
  } else {
    const excluded = await adminQuery(() => loadExcludedUserIds());
    order = await adminQuery(() => recentlyActiveUserIds(from, opts.limit, excluded));
  }
  const [env_, bundle] = await Promise.all([
    envelope(now),
    adminQuery(() => loadJourneyBundle(order, from)),
  ]);
  return {
    ...env_,
    stuckOnly: opts.stuckOnly,
    journeys: assembleJourneys(bundle, order, stuckMap, A.journeyListItems),
  };
}

/** Null when the user does not exist or is a synthetic / test account. */
export async function buildJourney(userId: string, now: Date = new Date()): Promise<PulseJourneyResponse | null> {
  const from = new Date(now.getTime() - A.journeyDays * DAY_MS);
  const [env_, bundle, stuckList] = await Promise.all([
    envelope(now),
    adminQuery(() => loadJourneyBundle([userId], from)),
    adminQuery(() => loadStuckPeople(now)),
  ]);
  const stuck = new Map(stuckList.filter((p) => p.userId === userId).map((p) => [p.userId, p]));
  const [journey] = assembleJourneys(bundle, [userId], stuck, A.journeyMaxItems);
  return journey ? { ...env_, journey } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog and funnels
// ─────────────────────────────────────────────────────────────────────────────

export async function buildCatalog(now: Date = new Date()): Promise<PulseCatalogResponse> {
  const env_ = await envelope(now);
  return {
    ...env_,
    metrics: PULSE_METRIC_NAMES.map((name) => PULSE_METRICS[name]),
    thresholds: { ...A },
    screens: Object.entries(PULSE_SCREENS as Record<string, PulseScreen>).map(([screen, s]) => ({
      screen,
      title: s.title,
      platform: s.platform,
      codeHint: s.codeHint,
      tracksTaps: s.tracksTaps === true,
      onboardingOrder: s.onboardingOrder ?? null,
    })),
  };
}

function conversionMap(counts: Array<{ step: string; count: number }>): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const t of funnelTransitions(counts)) {
    out.set(t.to, isSmallSample(t.entered) ? null : +(t.passed / t.entered).toFixed(4));
  }
  return out;
}

export async function buildFunnels(now: Date = new Date()): Promise<PulseFunnelsResponse> {
  const asOf = asOfDay(now);
  const [env_, rows] = await Promise.all([envelope(now), windowRows(asOf)]);
  const d7Days = recentWindow(asOf);
  const d28Days = daysEnding(asOf, 28);

  const funnels: PulseFunnel[] = funnelDefs(SERVER_ONBOARDING_STEPS).map((def) => {
    const s7 = sumByDim(rows, def.metric, d7Days);
    const s28 = sumByDim(rows, def.metric, d28Days);
    const c7 = def.steps.map((s) => ({ step: s.step, count: s7.get(s.dim)?.value ?? 0 }));
    const c28 = def.steps.map((s) => ({ step: s.step, count: s28.get(s.dim)?.value ?? 0 }));
    const conv7 = conversionMap(c7);
    const conv28 = conversionMap(c28);
    const entered7 = c7[0]?.count ?? 0;
    const entered28 = c28[0]?.count ?? 0;
    return {
      id: def.id,
      title: def.title,
      enteredD7: entered7,
      enteredD28: entered28,
      smallSample: isSmallSample(entered28),
      steps: def.steps.map((s, i) => ({
        step: s.step,
        title: s.title,
        d7: c7[i]!.count,
        d28: c28[i]!.count,
        conversionD7: conv7.get(s.step) ?? null,
        conversionD28: conv28.get(s.step) ?? null,
      })),
    };
  });

  const shown = sumByDim(rows, "money_shown", d7Days);
  const dismissed = sumByDim(rows, "money_dismissed", d7Days);
  const money = [...new Set([...shown.keys(), ...dismissed.keys()])]
    .map((dim) => ({ dim, shown: shown.get(dim)?.value ?? 0, dismissed: dismissed.get(dim)?.value ?? 0 }))
    .sort((a, b) => b.shown - a.shown);

  return { ...env_, asOf, funnels, money };
}
