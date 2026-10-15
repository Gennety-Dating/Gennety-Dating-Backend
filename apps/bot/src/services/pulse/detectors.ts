import { PULSE_ANALYTICS, pulseScreen } from "@gennety/shared";
import {
  DATE_FUNNEL_STAGES,
  DATE_FUNNEL_STAGE_TITLES,
  ONBOARDING_TRACKS,
  PULSE_METRICS,
  PULSE_METRIC_TITLES,
  type DateFunnelStage,
  type OnboardingTrack,
  type PulseMetricName,
} from "./metrics-catalog.js";
import { onboardingTrackSteps, type MetricRow } from "./rollup-math.js";

/**
 * Pulse detectors (docs/product/domains/pulse-analytics.md §5.4) — pure
 * functions from `metric_days` rows (plus the stuck-people list, which is
 * per-person and has no metric form) to insight drafts.
 *
 * No LLM anywhere: every title is a Russian template filled with numbers, so
 * the same data always produces the same sentence, and the agent that reads
 * `/admin/pulse/brief` spends its tokens on the "why", not on arithmetic.
 *
 * The small-sample rule (§5.5) is applied in ONE place — `shareText` — so no
 * detector can quote "55%" about eleven people: below `smallSampleN` the title
 * says "6 из 11" and the draft carries `smallSample: true`.
 *
 * Windows: `asOf` is the last COMPLETE UTC day (the rollup runs after
 * midnight). "Recent" is the 7 days ending on it; the baseline is the 28 days
 * before those — exactly the 35-day rollup window, so a detector never asks
 * for a day the rollup did not recompute.
 */

const DAY_MS = 86_400_000;
const A = PULSE_ANALYTICS;

export type InsightKind =
  | "stuck_people"
  | "funnel_drop"
  | "screen_friction"
  | "slow_decision"
  | "anomaly"
  | "unseen";

export interface InsightDraft {
  /** `kind:scope` — unique; a recurring finding is one row. */
  key: string;
  kind: InsightKind;
  severity: 1 | 2 | 3;
  scope: string;
  title: string;
  value: number | null;
  baseline: number | null;
  n: number;
  smallSample: boolean;
  /** Numbers and user ids only — never names, phones or message text. */
  evidence: Record<string, unknown>;
  codeHint: string | null;
}

/** A person with no movement past `stuckAfterMs` (loaded by `pulse/source.ts`). */
export interface StuckPerson {
  userId: string;
  phase: "onboarding" | "date";
  /**
   * Where they stopped: a screen key (from their last client event), else
   * `step:<onboarding step>` or `match:<match status>`.
   */
  where: string;
  lastMovementAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows and aggregation (shared with the admin routes)
// ─────────────────────────────────────────────────────────────────────────────

export function shiftDay(day: string, deltaDays: number): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + deltaDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** `count` day keys ending `endOffset` days before `asOf` (0 = ending on it). */
export function daysEnding(asOf: string, count: number, endOffset = 0): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < count; i++) out.add(shiftDay(asOf, -(endOffset + i)));
  return out;
}

export function recentWindow(asOf: string): Set<string> {
  return daysEnding(asOf, A.recentDays);
}

export function baselineWindow(asOf: string): Set<string> {
  return daysEnding(asOf, A.baselineDays, A.recentDays);
}

/** Σ value and Σ n of one metric per dim over a set of days. */
export function sumByDim(
  rows: readonly MetricRow[],
  metric: PulseMetricName,
  days: ReadonlySet<string>,
): Map<string, { value: number; n: number }> {
  const out = new Map<string, { value: number; n: number }>();
  for (const r of rows) {
    if (r.metric !== metric || !days.has(r.day)) continue;
    const acc = out.get(r.dim) ?? { value: 0, n: 0 };
    acc.value += r.value;
    acc.n += r.n;
    out.set(r.dim, acc);
  }
  return out;
}

/**
 * Median of daily values weighted by each day's n — the window "median" of a
 * metric stored as daily percentiles. Not the exact window percentile (that
 * needs the raw events), but it cannot be dragged by one quiet day, which an
 * average of daily medians can.
 */
export function weightedMedian(points: ReadonlyArray<{ value: number; n: number }>): number | null {
  const pts = points.filter((p) => p.n > 0).sort((a, b) => a.value - b.value);
  const total = pts.reduce((s, p) => s + p.n, 0);
  if (total === 0) return null;
  let acc = 0;
  for (const p of pts) {
    acc += p.n;
    if (acc >= total / 2) return p.value;
  }
  return pts[pts.length - 1]!.value;
}

function weightedMedianByDim(
  rows: readonly MetricRow[],
  metric: PulseMetricName,
  days: ReadonlySet<string>,
): Map<string, { value: number | null; n: number }> {
  const pts = new Map<string, Array<{ value: number; n: number }>>();
  for (const r of rows) {
    if (r.metric !== metric || !days.has(r.day)) continue;
    const list = pts.get(r.dim) ?? [];
    list.push({ value: r.value, n: r.n });
    pts.set(r.dim, list);
  }
  const out = new Map<string, { value: number | null; n: number }>();
  for (const [dim, list] of pts) {
    out.set(dim, { value: weightedMedian(list), n: list.reduce((s, p) => s + p.n, 0) });
  }
  return out;
}

export interface ScreenWindowStats {
  views: number;
  /** Σ of daily distinct viewers — a person on two days counts twice. */
  viewerDays: number;
  left: number;
  quickBack: number;
  background: number;
  taps: number;
  deadTaps: number;
  rageTaps: number;
  dwellP50Ms: number | null;
  dwellP90Ms: number | null;
  dwellN: number;
  firstActionP50Ms: number | null;
  firstActionN: number;
}

/** Per-screen totals over a set of days. */
export function screenWindowStats(
  rows: readonly MetricRow[],
  days: ReadonlySet<string>,
): Map<string, ScreenWindowStats> {
  const sum = (m: PulseMetricName) => sumByDim(rows, m, days);
  const views = sum("screen_views");
  const viewers = sum("screen_viewers");
  const left = sum("screen_left");
  const qb = sum("screen_exit_back_fast");
  const bg = sum("screen_exit_background");
  const taps = sum("screen_taps");
  const dead = sum("screen_dead_taps");
  const rage = sum("screen_rage_taps");
  const p50 = weightedMedianByDim(rows, "screen_dwell_p50", days);
  const p90 = weightedMedianByDim(rows, "screen_dwell_p90", days);
  const fa = weightedMedianByDim(rows, "screen_first_action_p50", days);

  const screens = new Set([...views.keys(), ...left.keys(), ...taps.keys(), ...dead.keys()]);
  const out = new Map<string, ScreenWindowStats>();
  for (const s of screens) {
    out.set(s, {
      views: views.get(s)?.value ?? 0,
      viewerDays: viewers.get(s)?.value ?? 0,
      left: left.get(s)?.value ?? 0,
      quickBack: qb.get(s)?.value ?? 0,
      background: bg.get(s)?.value ?? 0,
      taps: taps.get(s)?.value ?? 0,
      deadTaps: dead.get(s)?.value ?? 0,
      rageTaps: rage.get(s)?.value ?? 0,
      dwellP50Ms: p50.get(s)?.value ?? null,
      dwellP90Ms: p90.get(s)?.value ?? null,
      dwellN: p50.get(s)?.n ?? 0,
      firstActionP50Ms: fa.get(s)?.value ?? null,
      firstActionN: fa.get(s)?.n ?? 0,
    });
  }
  return out;
}

/**
 * `0.35·rage + 0.25·dead + 0.2·quick_back + 0.2·exit`, each term per 100
 * views (spec §5.4). `exit` = the app was backgrounded straight from this
 * screen — the closest the client can come to "gave up here". Null when the
 * screen was never shown (a score over zero views is not zero friction).
 */
export function frictionScore(s: Pick<ScreenWindowStats, "views" | "rageTaps" | "deadTaps" | "quickBack" | "background">): number | null {
  if (s.views <= 0) return null;
  const w = A.frictionWeights;
  const per100 = (x: number) => (x / s.views) * 100;
  const score =
    w.rage * per100(s.rageTaps) +
    w.dead * per100(s.deadTaps) +
    w.quickBack * per100(s.quickBack) +
    w.exit * per100(s.background);
  return Math.round(score * 10) / 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// Russian templates
// ─────────────────────────────────────────────────────────────────────────────

/** Russian plural: 1 человек, 2 человека, 5 человек. */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function isSmallSample(n: number): boolean {
  return n < A.smallSampleN;
}

/** "6 из 11" under the small-sample rule, else "55% (6 из 11)". */
export function shareText(part: number, whole: number): string {
  if (whole <= 0) return `${part} из ${whole}`;
  if (isSmallSample(whole)) return `${part} из ${whole}`;
  return `${Math.round((part / whole) * 100)}% (${part} из ${whole})`;
}

function seconds(ms: number): string {
  const s = ms / 1000;
  return s >= 10 ? String(Math.round(s)) : s.toFixed(1).replace(".", ",");
}

export function screenTitle(key: string): string {
  return pulseScreen(key)?.title ?? key;
}

function codeHintOf(screen: string | null | undefined): string | null {
  return screen ? (pulseScreen(screen)?.codeHint ?? null) : null;
}

const SERVER_ONBOARDING_HINT = "backend:apps/bot/src/services/onboarding-collector.ts";

const TRACK_TITLES: Record<OnboardingTrack, string> = {
  ios: "Онбординг iOS",
  miniapp: "Онбординг Mini App",
  bot: "Онбординг в боте",
  ios_server: "Анкета iOS (сервер)",
};

/** The screen on which a date-funnel stage is ACHIEVED — where its loss lives. */
const DATE_STAGE_SCREEN: Partial<Record<DateFunnelStage, string>> = {
  accepted: "today_pitch",
  mutual: "today_pitch",
  ticket_paid: "today_ticket_gate",
  time_agreed: "today_calendar",
  venue: "today_venue_intent",
  date_completed: "today_scheduled",
  feedback: "feedback",
};

// ─────────────────────────────────────────────────────────────────────────────
// stuck_people
// ─────────────────────────────────────────────────────────────────────────────

function whereLabel(where: string): string {
  if (where.startsWith("step:")) return `шаг анкеты «${where.slice(5)}»`;
  if (where.startsWith("match:")) return `пара в статусе ${where.slice(6)}`;
  return `«${screenTitle(where)}»`;
}

export function detectStuckPeople(stuck: readonly StuckPerson[]): InsightDraft[] {
  const groups = new Map<string, StuckPerson[]>();
  for (const p of stuck) {
    const list = groups.get(p.where) ?? [];
    list.push(p);
    groups.set(p.where, list);
  }
  const hours = Math.round(A.stuckAfterMs / 3_600_000);
  const out: InsightDraft[] = [];
  for (const [where, people] of groups) {
    const n = people.length;
    people.sort((a, b) => a.lastMovementAt.getTime() - b.lastMovementAt.getTime());
    const phases = [...new Set(people.map((p) => p.phase))];
    out.push({
      key: `stuck_people:${where}`,
      kind: "stuck_people",
      severity: n >= A.stuckSevereCount ? 3 : n >= 2 ? 2 : 1,
      scope: where,
      title: `${n} ${plural(n, "человек", "человека", "человек")} без движения больше ${hours} ч: ${whereLabel(where)}`,
      value: n,
      baseline: null,
      n,
      smallSample: isSmallSample(n),
      evidence: {
        people: n,
        phases,
        oldestSince: people[0]!.lastMovementAt.toISOString(),
        userIds: people.slice(0, A.evidenceMaxUserIds).map((p) => p.userId),
      },
      codeHint: where.startsWith("step:")
        ? SERVER_ONBOARDING_HINT
        : where.startsWith("match:")
          ? null
          : codeHintOf(where),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// funnel_drop
// ─────────────────────────────────────────────────────────────────────────────

export interface FunnelDef {
  /** `onboarding_<track>` | `date`. */
  id: string;
  title: string;
  metric: PulseMetricName;
  /** Ordered steps and the `dim` each one is stored under. */
  steps: Array<{ step: string; dim: string; title: string; screen: string | null }>;
  /** Whose screen a loss between steps i → k is attributed to. */
  lossAt: "from" | "to";
}

export function funnelDefs(serverSteps: readonly string[]): FunnelDef[] {
  const onboarding = ONBOARDING_TRACKS.map<FunnelDef>((track) => ({
    id: `onboarding_${track}`,
    title: TRACK_TITLES[track],
    metric: "onboarding_step_reached",
    steps: onboardingTrackSteps(track, serverSteps).map((step) => ({
      step,
      dim: `${track}:${step}`,
      title: track === "ios" || track === "miniapp" ? screenTitle(step) : step,
      screen: track === "ios" || track === "miniapp" ? step : null,
    })),
    // Onboarding: the person left the step they were ON.
    lossAt: "from",
  }));
  const date: FunnelDef = {
    id: "date",
    title: "Путь свидания",
    metric: "date_funnel",
    steps: DATE_FUNNEL_STAGES.map((stage) => ({
      step: stage,
      dim: stage,
      title: DATE_FUNNEL_STAGE_TITLES[stage],
      screen: DATE_STAGE_SCREEN[stage] ?? null,
    })),
    // Date path: the pair failed to achieve the NEXT stage, on its screen.
    lossAt: "to",
  };
  return [...onboarding, date];
}

export interface FunnelTransition {
  from: string;
  to: string;
  entered: number;
  passed: number;
  /** Share lost, 0..1. */
  loss: number;
}

/**
 * Step-to-step transitions over one window. A step whose count is BELOW its
 * successor's is bypassable (a pair whose ticket gate opened for free never
 * "pays" but still agrees a time; an onboarding step the client skipped), so
 * it is compared through rather than reported as a 100% loss.
 */
export function funnelTransitions(
  counts: ReadonlyArray<{ step: string; count: number }>,
): FunnelTransition[] {
  const bypass = new Set<number>();
  for (let i = 0; i < counts.length - 1; i++) {
    if (counts[i + 1]!.count > counts[i]!.count) bypass.add(i);
  }
  const out: FunnelTransition[] = [];
  for (let i = 0; i < counts.length - 1; i++) {
    if (bypass.has(i)) continue;
    let k = i + 1;
    while (k < counts.length - 1 && bypass.has(k)) k++;
    const entered = counts[i]!.count;
    const passed = counts[k]!.count;
    if (entered <= 0 || passed > entered) continue;
    out.push({ from: counts[i]!.step, to: counts[k]!.step, entered, passed, loss: (entered - passed) / entered });
  }
  return out;
}

function funnelCounts(rows: readonly MetricRow[], def: FunnelDef, days: ReadonlySet<string>) {
  const sums = sumByDim(rows, def.metric, days);
  return def.steps.map((s) => ({ step: s.step, count: sums.get(s.dim)?.value ?? 0 }));
}

export function detectFunnelDrops(
  rows: readonly MetricRow[],
  asOf: string,
  serverSteps: readonly string[],
): InsightDraft[] {
  const recent = recentWindow(asOf);
  const base = baselineWindow(asOf);
  const out: InsightDraft[] = [];
  for (const def of funnelDefs(serverSteps)) {
    const transitions = funnelTransitions(funnelCounts(rows, def, recent)).filter(
      (t) => t.entered >= A.funnelMinEntered && t.loss > 0,
    );
    if (transitions.length === 0) continue;
    const worst = transitions.sort((a, b) => b.loss - a.loss || b.entered - b.passed - (a.entered - a.passed))[0]!;
    const baseT = funnelTransitions(funnelCounts(rows, def, base)).find(
      (t) => t.from === worst.from && t.to === worst.to && t.entered >= A.funnelMinEntered,
    );
    const baseline = baseT ? baseT.loss : null;
    const fromStep = def.steps.find((s) => s.step === worst.from)!;
    const toStep = def.steps.find((s) => s.step === worst.to)!;
    const blame = def.lossAt === "from" ? fromStep : toStep;
    const small = isSmallSample(worst.entered);
    const severity: 1 | 2 | 3 =
      baseline !== null && worst.loss - baseline >= A.funnelWorsenedBy ? 3 : worst.loss >= 0.5 ? 2 : 1;

    const was = baseT
      ? small || isSmallSample(baseT.entered)
        ? `; за 4 недели до этого — ${baseT.passed} из ${baseT.entered}`
        : `; за 4 недели до этого теряли ${Math.round(baseT.loss * 100)}%`
      : "";
    const title = small
      ? `${def.title}: после «${fromStep.title}» до «${toStep.title}» дошли ${worst.passed} из ${worst.entered} за 7 дней${was}`
      : `${def.title}: между «${fromStep.title}» и «${toStep.title}» теряется ${Math.round(worst.loss * 100)}% (${worst.entered - worst.passed} из ${worst.entered}) за 7 дней${was}`;

    out.push({
      key: `funnel_drop:${def.id}:${worst.from}`,
      kind: "funnel_drop",
      severity,
      scope: `${def.id}:${worst.from}`,
      title,
      value: +worst.loss.toFixed(4),
      baseline: baseline === null ? null : +baseline.toFixed(4),
      n: worst.entered,
      smallSample: small,
      evidence: {
        funnel: def.id,
        from: worst.from,
        to: worst.to,
        entered: worst.entered,
        passed: worst.passed,
        baselineEntered: baseT?.entered ?? null,
        baselinePassed: baseT?.passed ?? null,
      },
      codeHint: blame.screen ? codeHintOf(blame.screen) : def.id.startsWith("onboarding_") ? SERVER_ONBOARDING_HINT : null,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// screen_friction
// ─────────────────────────────────────────────────────────────────────────────

export function detectScreenFriction(rows: readonly MetricRow[], asOf: string): InsightDraft[] {
  const recent = screenWindowStats(rows, recentWindow(asOf));
  const base = screenWindowStats(rows, baselineWindow(asOf));
  const scored: Array<{ screen: string; s: ScreenWindowStats; score: number }> = [];
  for (const [screen, s] of recent) {
    if (s.views < A.frictionMinViews) continue;
    const score = frictionScore(s);
    if (score === null || score < A.frictionThreshold) continue;
    scored.push({ screen, s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, A.frictionTopN).map(({ screen, s, score }) => {
    const small = isSmallSample(s.views);
    const b = base.get(screen);
    const baseline = b && b.views >= A.frictionMinViews ? frictionScore(b) : null;
    const parts = `${s.rageTaps} ${plural(s.rageTaps, "вспышка", "вспышки", "вспышек")} ярости, ${s.deadTaps} ${plural(s.deadTaps, "касание", "касания", "касаний")} мимо, ${s.quickBack} ${plural(s.quickBack, "быстрый уход", "быстрых ухода", "быстрых уходов")} назад, ${s.background} ${plural(s.background, "сворачивание", "сворачивания", "сворачиваний")}`;
    const title = small
      ? `«${screenTitle(screen)}»: ${parts} на ${s.views} ${plural(s.views, "показ", "показа", "показов")} за 7 дней`
      : `«${screenTitle(screen)}»: трение ${score} на 100 показов — ${parts} на ${s.views} показов за 7 дней`;
    return {
      key: `screen_friction:${screen}`,
      kind: "screen_friction" as const,
      severity: (score >= A.frictionSevereThreshold ? 3 : 2) as 2 | 3,
      scope: screen,
      title,
      value: score,
      baseline,
      n: s.views,
      smallSample: small,
      evidence: {
        views: s.views,
        rageTaps: s.rageTaps,
        deadTaps: s.deadTaps,
        quickBack: s.quickBack,
        background: s.background,
        weights: A.frictionWeights,
      },
      codeHint: codeHintOf(screen),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// slow_decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The screen's median time to first action in the week vs its own previous
 * four weeks. Before a screen has a baseline of its own (the first month of
 * data) it is compared with the median across all screens this week, and the
 * evidence says so — a new screen being slow is worth knowing, but it must not
 * read as "got slower".
 */
export function detectSlowDecisions(rows: readonly MetricRow[], asOf: string): InsightDraft[] {
  const recent = weightedMedianByDim(rows, "screen_first_action_p50", recentWindow(asOf));
  const base = weightedMedianByDim(rows, "screen_first_action_p50", baselineWindow(asOf));
  const eligible = [...recent].filter(([, r]) => r.value !== null && r.n >= A.slowDecisionMinN);
  const allScreens = weightedMedian(eligible.map(([, r]) => ({ value: r.value!, n: r.n })));
  const out: InsightDraft[] = [];
  for (const [screen, r] of eligible) {
    const own = base.get(screen);
    const hasOwn = own !== undefined && own.value !== null && own.n >= A.slowDecisionMinN;
    // Comparing a screen with a median it dominates proves nothing.
    const baseline = hasOwn ? own.value! : eligible.length >= 3 ? allScreens : null;
    if (baseline === null || baseline <= 0) continue;
    if (r.value! < baseline * A.slowDecisionFactor) continue;
    const ratio = r.value! / baseline;
    out.push({
      key: `slow_decision:${screen}`,
      kind: "slow_decision",
      severity: 2,
      scope: screen,
      title: `«${screenTitle(screen)}»: до первого действия ${seconds(r.value!)} с — в ${ratio.toFixed(1).replace(".", ",")} раза дольше ${hasOwn ? "обычного для этого экрана" : "медианы по всем экранам"} (${seconds(baseline)} с; ${r.n} ${plural(r.n, "замер", "замера", "замеров")})`,
      value: r.value,
      baseline,
      n: r.n,
      smallSample: isSmallSample(r.n),
      evidence: { medianMs: r.value, baselineMs: baseline, baselineKind: hasOwn ? "own_4w" : "all_screens_7d", n: r.n },
      codeHint: codeHintOf(screen),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// anomaly
// ─────────────────────────────────────────────────────────────────────────────

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface AnomalyCheck {
  value: number;
  median: number;
  mad: number;
  lo: number;
  hi: number;
  points: number;
  sameWeekday: boolean;
  outside: boolean;
}

/**
 * median ± k·MAD over the baseline (spec §5.4), weekday-aware: when the
 * baseline holds at least `anomalyMinSameWeekday` points on the same weekday
 * as the day checked, only those are used — Saturday signups are not Monday's.
 *
 * MAD is floored at 1 unit. A flat series (seven quiet days of exactly 2) has
 * MAD = 0, and a literal ± 0 band would call 3 an anomaly — the same blind
 * spot the virality detector closed with its Poisson floor.
 */
export function checkAnomaly(
  value: number,
  baseline: ReadonlyArray<{ day: string; value: number }>,
  day: string,
): AnomalyCheck | null {
  if (baseline.length < A.anomalyMinPoints) return null;
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  const same = baseline.filter((b) => new Date(`${b.day}T00:00:00.000Z`).getUTCDay() === weekday);
  const useSame = same.length >= A.anomalyMinSameWeekday;
  const values = (useSame ? same : baseline).map((b) => b.value);
  const med = median(values)!;
  const mad = median(values.map((v) => Math.abs(v - med)))!;
  const band = A.anomalyMadK * Math.max(mad, 1);
  const lo = med - band;
  const hi = med + band;
  return { value, median: med, mad, lo, hi, points: values.length, sameWeekday: useSame, outside: value < lo || value > hi };
}

function dimLabel(metric: PulseMetricName, dim: string): string {
  if (!dim) return "";
  if (metric.startsWith("screen_")) return ` «${screenTitle(dim)}»`;
  return ` (${dim})`;
}

export function detectAnomalies(rows: readonly MetricRow[], asOf: string): InsightDraft[] {
  const watched = new Set(
    (Object.keys(PULSE_METRICS) as PulseMetricName[]).filter((m) => PULSE_METRICS[m].anomaly),
  );
  const series = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!watched.has(r.metric)) continue;
    const key = `${r.metric}|${r.dim}`;
    const m = series.get(key) ?? new Map<string, number>();
    m.set(r.day, r.value);
    series.set(key, m);
  }
  const baseDays = [...daysEnding(asOf, A.baselineDays, 1)].sort();
  const out: InsightDraft[] = [];
  for (const [key, byDay] of series) {
    const [metric, dim] = key.split("|") as [PulseMetricName, string];
    const firstDay = [...byDay.keys()].sort()[0]!;
    // A missing day is a zero (no views, no signups) — but only after the
    // series existed at all; before its first row there is nothing to compare.
    const baseline = baseDays.filter((d) => d >= firstDay).map((d) => ({ day: d, value: byDay.get(d) ?? 0 }));
    const value = asOf >= firstDay ? (byDay.get(asOf) ?? 0) : null;
    if (value === null) continue;
    const check = checkAnomaly(value, baseline, asOf);
    if (!check || !check.outside) continue;
    const band = check.hi - check.median;
    const severe = Math.abs(value - check.median) > 2 * band;
    const lo = Math.max(0, Math.round(check.lo));
    const hi = Math.round(check.hi);
    out.push({
      key: `anomaly:${metric}:${dim}`,
      kind: "anomaly",
      severity: severe ? 3 : 2,
      scope: `${metric}:${dim}`,
      title: `${PULSE_METRIC_TITLES[metric]}${dimLabel(metric, dim)}: ${value} за ${asOf} при обычных ${lo}–${hi}${check.sameWeekday ? " (тот же день недели)" : ""}`,
      value,
      baseline: check.median,
      n: check.points,
      smallSample: isSmallSample(Math.max(value, check.median)),
      evidence: { day: asOf, value, median: check.median, mad: check.mad, points: check.points, sameWeekday: check.sameWeekday },
      codeHint: metric.startsWith("screen_") ? codeHintOf(dim) : null,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// unseen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A block shown on a screen but seen ≥1 s by at most 30% of the installs that
 * opened it (= more than 70% gave it under a second). Items nobody ever saw
 * produce no `seen` row at all and cannot be detected here — the client sends
 * no "block rendered" event, by design (spec §3.4).
 */
export function detectUnseen(rows: readonly MetricRow[], asOf: string): InsightDraft[] {
  const sums = sumByDim(rows, "item_seen", recentWindow(asOf));
  const out: InsightDraft[] = [];
  for (const [dim, { value, n }] of sums) {
    if (n < A.unseenMinViewers) continue;
    const share = value / n;
    if (share > A.unseenMaxSeenShare) continue;
    const sep = dim.indexOf(":");
    const screen = dim.slice(0, sep);
    const item = dim.slice(sep + 1);
    out.push({
      key: `unseen:${dim}`,
      kind: "unseen",
      severity: 1,
      scope: dim,
      title: `Блок «${item}» на «${screenTitle(screen)}» дольше секунды увидели ${shareText(value, n)} открывших экран за 7 дней`,
      value: +share.toFixed(4),
      baseline: null,
      n,
      smallSample: isSmallSample(n),
      evidence: { screen, item, seen: value, viewerDays: n },
      codeHint: codeHintOf(screen),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// All of them
// ─────────────────────────────────────────────────────────────────────────────

export function runDetectors(input: {
  rows: readonly MetricRow[];
  asOf: string;
  stuck: readonly StuckPerson[];
  serverSteps: readonly string[];
}): InsightDraft[] {
  const drafts = [
    ...detectStuckPeople(input.stuck),
    ...detectFunnelDrops(input.rows, input.asOf, input.serverSteps),
    ...detectScreenFriction(input.rows, input.asOf),
    ...detectSlowDecisions(input.rows, input.asOf),
    ...detectAnomalies(input.rows, input.asOf),
    ...detectUnseen(input.rows, input.asOf),
  ];
  // Keys are unique by construction; this guards a future detector that is not.
  const byKey = new Map<string, InsightDraft>();
  for (const d of drafts) if (!byKey.has(d.key)) byKey.set(d.key, d);
  return [...byKey.values()];
}

/** Ordering of `/brief` and `/insights`: severity × people affected. */
export function insightWeight(i: { severity: number; n: number }): number {
  return i.severity * Math.max(1, i.n);
}
