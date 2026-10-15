import { PULSE_ANALYTICS, pulseOnboardingSteps, type PulsePlatform } from "@gennety/shared";
import {
  DATE_FUNNEL_STAGES,
  type DateFunnelStage,
  type OnboardingTrack,
  type PulseMetricName,
} from "./metrics-catalog.js";

/**
 * Pulse rollup arithmetic — pure, no Prisma, no clock.
 *
 * `rollup.ts` loads rows for the trailing window and hands them here; what
 * comes back is the exact set of `metric_days` rows to write. Kept apart from
 * the loading for the same reason `activity.ts` / `activity-source.ts` are: the
 * definitions (what a quick back is, what counts as rage, when a person
 * "reached" a step) are the part worth testing with fixtures, and they should
 * not need a database to be tested.
 *
 * Volumes are tiny (tens of people), so everything here is a straight pass in
 * memory. The day boundary is the UTC day of the device clock (`occurredAt`)
 * for client events — the only time the client knows — and of the server
 * clock for everything else.
 */

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of a UTC day. */
export function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** One `client_events` row as the rollup needs it. */
export interface PulseEventRow {
  id: string;
  userId: string | null;
  installId: string;
  type: string;
  props: Record<string, unknown>;
  occurredAt: Date;
  platform: string;
  screen: string | null;
  appVersion: string | null;
}

export interface StepEventRow {
  userId: string;
  step: string;
  kind: string;
  /** `telegram` | `mobile` | null (rows written before the column existed). */
  platform: string | null;
  createdAt: Date;
}

export interface ActivityDayRow {
  day: string;
  userId: string;
  platform: string;
}

export interface SignupRow {
  userId: string;
  createdAt: Date;
  platform: string;
}

/**
 * One `matches` row reduced to the columns the date funnel reads, plus the
 * `match_events` action types recorded for it. Column names, not business
 * labels (AGENTS.md rule 9).
 */
export interface FunnelMatchRow {
  id: string;
  createdAt: Date;
  status: string;
  dispatchedAt: Date | null;
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
  ticketStatus: string;
  agreedTime: Date | null;
  venueName: string | null;
  feedbackByA: string | null;
  feedbackByB: string | null;
  eventTypes: readonly string[];
}

export interface OptInUserRow {
  createdAt: Date;
  analyticsOptIn: boolean;
  analyticsOptInAt: Date | null;
}

export interface MetricRow {
  day: string;
  metric: PulseMetricName;
  dim: string;
  value: number;
  n: number;
}

export interface RollupInput {
  /** Inclusive UTC day keys to produce rows for. */
  days: readonly string[];
  events: readonly PulseEventRow[];
  stepEvents: readonly StepEventRow[];
  /** Server-side conversational step order (the collector's question list). */
  serverSteps: readonly string[];
  activity: readonly ActivityDayRow[];
  signups: readonly SignupRow[];
  matches: readonly FunnelMatchRow[];
  optInUsers: readonly OptInUserRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Linear-interpolated percentile over an ascending array (same as `buckets.ts`). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (p <= 0) return sorted[0]!;
  if (p >= 1) return sorted[sorted.length - 1]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function bump<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function addToSet<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Rage taps
// ─────────────────────────────────────────────────────────────────────────────

export interface TapPoint {
  installId: string;
  screen: string;
  at: Date;
  x: number;
  y: number;
}

export interface RageCluster {
  installId: string;
  screen: string;
  at: Date;
  points: Array<[number, number]>;
}

/**
 * Rage clusters: at least `rageMinTaps` taps (elements or dead) by the SAME
 * install on the SAME screen within `rageWindowMs` of the first one, each
 * within `rageRadius` (normalized coordinates) of it. A tap belongs to at most
 * one cluster: once a cluster is found the scan resumes after its last tap, so
 * a frantic five-tap burst is one rage, not three overlapping ones.
 *
 * Done in TS rather than SQL deliberately — a self-join over a time window
 * plus a distance predicate is unreadable in SQL, and at this volume (one
 * day's taps of tens of people) a sorted pass costs nothing.
 */
export function detectRageClusters(
  taps: readonly TapPoint[],
  cfg: { minTaps: number; windowMs: number; radius: number } = {
    minTaps: PULSE_ANALYTICS.rageMinTaps,
    windowMs: PULSE_ANALYTICS.rageWindowMs,
    radius: PULSE_ANALYTICS.rageRadius,
  },
): RageCluster[] {
  const byKey = new Map<string, TapPoint[]>();
  for (const tap of taps) push(byKey, `${tap.installId}\u0000${tap.screen}`, tap);

  const out: RageCluster[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    let i = 0;
    while (i < list.length) {
      const first = list[i]!;
      const members = [first];
      let last = i;
      for (let j = i + 1; j < list.length; j++) {
        const t = list[j]!;
        if (t.at.getTime() - first.at.getTime() > cfg.windowMs) break;
        if (Math.hypot(t.x - first.x, t.y - first.y) <= cfg.radius) {
          members.push(t);
          last = j;
        }
      }
      if (members.length >= cfg.minTaps) {
        out.push({
          installId: first.installId,
          screen: first.screen,
          at: first.at,
          points: members.map((m) => [m.x, m.y]),
        });
        i = last + 1;
      } else {
        i += 1;
      }
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Tap / dead-tap rows → points (drops a row without numeric coordinates). */
export function tapPointsOf(events: readonly PulseEventRow[]): TapPoint[] {
  const out: TapPoint[] = [];
  for (const e of events) {
    if (e.type !== "tap" && e.type !== "dead_tap") continue;
    const screen = e.screen ?? str(e.props["screen"]);
    const x = num(e.props["x"]);
    const y = num(e.props["y"]);
    if (!screen || x === null || y === null) continue;
    out.push({ installId: e.installId, screen, at: e.occurredAt, x, y });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen metrics
// ─────────────────────────────────────────────────────────────────────────────

interface ScreenDayAcc {
  views: number;
  viewers: Set<string>;
  left: number;
  dwell: number[];
  firstAction: number[];
  quickBack: number;
  background: number;
  taps: number;
  dead: number;
  rage: number;
}

function emptyScreenAcc(): ScreenDayAcc {
  return {
    views: 0,
    viewers: new Set(),
    left: 0,
    dwell: [],
    firstAction: [],
    quickBack: 0,
    background: 0,
    taps: 0,
    dead: 0,
    rage: 0,
  };
}

/** Whether a `screen_left` is a quick back (spec §5.4). */
export function isQuickBack(exit: unknown, dwellMs: number | null): boolean {
  return exit === "back" && dwellMs !== null && dwellMs < PULSE_ANALYTICS.quickBackMs;
}

export function computeScreenRows(
  events: readonly PulseEventRow[],
  days: ReadonlySet<string>,
): MetricRow[] {
  const acc = new Map<string, ScreenDayAcc>();
  const accFor = (day: string, screen: string): ScreenDayAcc => {
    const key = `${day}|${screen}`;
    let a = acc.get(key);
    if (!a) {
      a = emptyScreenAcc();
      acc.set(key, a);
    }
    return a;
  };
  // `seen`: distinct installs per (day, screen, item).
  const seenBy = new Map<string, Set<string>>();

  for (const e of events) {
    const day = dayKey(e.occurredAt);
    if (!days.has(day)) continue;
    const screen = e.screen ?? str(e.props["screen"]);
    if (!screen) continue;
    switch (e.type) {
      case "screen_view": {
        const a = accFor(day, screen);
        a.views += 1;
        a.viewers.add(e.installId);
        break;
      }
      case "screen_left": {
        const a = accFor(day, screen);
        a.left += 1;
        const dwell = num(e.props["dwell_ms"]);
        if (dwell !== null) a.dwell.push(dwell);
        const firstAction = num(e.props["first_action_ms"]);
        if (firstAction !== null) a.firstAction.push(firstAction);
        if (isQuickBack(e.props["exit"], dwell)) a.quickBack += 1;
        if (e.props["exit"] === "background") a.background += 1;
        break;
      }
      case "tap":
        accFor(day, screen).taps += 1;
        break;
      case "dead_tap":
        accFor(day, screen).dead += 1;
        break;
      case "seen": {
        const item = str(e.props["item"]);
        const visible = num(e.props["visible_ms"]);
        // The client only sends `seen` after ≥1 s, but the server checks shape,
        // not semantics (spec §3.6) — a shorter one is not "seen".
        if (!item || visible === null || visible < 1_000) break;
        addToSet(seenBy, `${day}|${screen}|${item}`, e.installId);
        break;
      }
      default:
        break;
    }
  }

  for (const cluster of detectRageClusters(tapPointsOf(events))) {
    const day = dayKey(cluster.at);
    if (!days.has(day)) continue;
    accFor(day, cluster.screen).rage += 1;
  }

  const rows: MetricRow[] = [];
  for (const [key, a] of acc) {
    const [day, screen] = key.split("|") as [string, string];
    const views = a.views;
    rows.push(
      { day, metric: "screen_views", dim: screen, value: views, n: views },
      { day, metric: "screen_viewers", dim: screen, value: a.viewers.size, n: a.viewers.size },
      { day, metric: "screen_left", dim: screen, value: a.left, n: a.left },
      { day, metric: "screen_exit_back_fast", dim: screen, value: a.quickBack, n: a.left },
      { day, metric: "screen_exit_background", dim: screen, value: a.background, n: a.left },
      { day, metric: "screen_taps", dim: screen, value: a.taps, n: views },
      { day, metric: "screen_dead_taps", dim: screen, value: a.dead, n: views },
      { day, metric: "screen_rage_taps", dim: screen, value: a.rage, n: views },
    );
    if (a.dwell.length > 0) {
      const sorted = [...a.dwell].sort((x, y) => x - y);
      rows.push(
        { day, metric: "screen_dwell_p50", dim: screen, value: Math.round(percentile(sorted, 0.5)!), n: sorted.length },
        { day, metric: "screen_dwell_p90", dim: screen, value: Math.round(percentile(sorted, 0.9)!), n: sorted.length },
      );
    }
    if (a.firstAction.length > 0) {
      const sorted = [...a.firstAction].sort((x, y) => x - y);
      rows.push({
        day,
        metric: "screen_first_action_p50",
        dim: screen,
        value: Math.round(percentile(sorted, 0.5)!),
        n: sorted.length,
      });
    }
  }

  for (const [key, installs] of seenBy) {
    const [day, screen, item] = key.split("|") as [string, string, string];
    // Denominator: installs that opened the screen that day. A `seen` without a
    // `screen_view` (the view landed the day before midnight) still counts its
    // own viewer, so the share can never exceed 1.
    const viewers = acc.get(`${day}|${screen}`)?.viewers ?? new Set<string>();
    const denominator = new Set([...viewers, ...installs]).size;
    rows.push({ day, metric: "item_seen", dim: `${screen}:${item}`, value: installs.size, n: denominator });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding
// ─────────────────────────────────────────────────────────────────────────────

/** Server `onboarding_step_events.platform` → Pulse track. */
export function serverTrackOf(platform: string | null): OnboardingTrack {
  return platform === "mobile" ? "ios_server" : "bot";
}

/** The ordered steps of a track. */
export function onboardingTrackSteps(
  track: OnboardingTrack,
  serverSteps: readonly string[],
): string[] {
  if (track === "ios" || track === "miniapp") return pulseOnboardingSteps(track as PulsePlatform);
  return [...serverSteps];
}

/**
 * `onboarding_step_reached{track:step}` and `onboarding_completed{track}`.
 *
 * A person counts ONCE per step — on the day they first reached it inside the
 * window. Without that, summing a week of daily rows would count someone who
 * reopened the city screen on three days three times, and every conversion
 * computed from the sums would be wrong in a way invisible at n = 11.
 *
 * Person = install for client tracks (most onboarding happens before login, so
 * there is no user id yet) and user id for the server tracks. Completion is
 * reaching the track's last step — for a server track, RESOLVING it
 * (answered/skipped), because the collector records nothing for `complete`.
 */
export function computeOnboardingRows(
  events: readonly PulseEventRow[],
  stepEvents: readonly StepEventRow[],
  serverSteps: readonly string[],
  days: ReadonlySet<string>,
): MetricRow[] {
  // track|step|person → first time
  const firstReach = new Map<string, Date>();
  const note = (key: string, at: Date): void => {
    const prev = firstReach.get(key);
    if (!prev || at < prev) firstReach.set(key, at);
  };
  const completedFirst = new Map<string, Date>();
  const noteDone = (key: string, at: Date): void => {
    const prev = completedFirst.get(key);
    if (!prev || at < prev) completedFirst.set(key, at);
  };

  for (const platform of ["ios", "miniapp"] as const) {
    const steps = pulseOnboardingSteps(platform);
    const stepSet = new Set(steps);
    const last = steps[steps.length - 1];
    for (const e of events) {
      if (e.type !== "screen_view" || e.platform !== platform) continue;
      const screen = e.screen ?? str(e.props["screen"]);
      if (!screen || !stepSet.has(screen)) continue;
      note(`${platform}|${screen}|${e.installId}`, e.occurredAt);
      if (screen === last) noteDone(`${platform}|${e.installId}`, e.occurredAt);
    }
  }

  const lastServer = serverSteps[serverSteps.length - 1];
  for (const s of stepEvents) {
    const track = serverTrackOf(s.platform);
    note(`${track}|${s.step}|${s.userId}`, s.createdAt);
    if (s.step === lastServer && (s.kind === "answered" || s.kind === "skipped")) {
      noteDone(`${track}|${s.userId}`, s.createdAt);
    }
  }

  const reached = new Map<string, number>();
  for (const [key, at] of firstReach) {
    const day = dayKey(at);
    if (!days.has(day)) continue;
    const [track, step] = key.split("|") as [string, string];
    bump(reached, `${day}|${track}:${step}`);
  }
  const completed = new Map<string, number>();
  for (const [key, at] of completedFirst) {
    const day = dayKey(at);
    if (!days.has(day)) continue;
    const [track] = key.split("|") as [string];
    bump(completed, `${day}|${track}`);
  }

  const rows: MetricRow[] = [];
  for (const [key, count] of reached) {
    const [day, dim] = key.split("|") as [string, string];
    rows.push({ day, metric: "onboarding_step_reached", dim, value: count, n: count });
  }
  for (const [key, count] of completed) {
    const [day, dim] = key.split("|") as [string, string];
    rows.push({ day, metric: "onboarding_completed", dim, value: count, n: count });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date funnel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which stages one pair reached. Every predicate reads a stored column:
 *   - shown          — dispatched (`dispatchedAt`) or a `PROPOSAL_SHOWN` event;
 *   - accepted       — either side `acceptedBy* = true` or an `ACCEPTED` event;
 *   - mutual         — both `acceptedBy* = true`;
 *   - ticket_paid    — `ticketStatus = completed` (both sides paid). A pair
 *                      whose gate opened for free (`refunded` / `expired`) or
 *                      that never had a gate skips this stage and still reaches
 *                      the next ones — `funnel_drop` treats such a stage as
 *                      bypassable rather than as a loss;
 *   - time_agreed    — `agreedTime` set;
 *   - venue          — `venueName` set or the row reached `scheduled`/`completed`;
 *   - date_completed — `status = completed` or a `DATE_COMPLETED` event;
 *   - feedback       — either `feedbackBy*` set.
 */
export function dateFunnelStages(m: FunnelMatchRow): Set<DateFunnelStage> {
  const ev = new Set(m.eventTypes);
  const out = new Set<DateFunnelStage>();
  if (m.dispatchedAt !== null || ev.has("PROPOSAL_SHOWN")) out.add("shown");
  if (m.acceptedByA === true || m.acceptedByB === true || ev.has("ACCEPTED")) out.add("accepted");
  if (m.acceptedByA === true && m.acceptedByB === true) out.add("mutual");
  if (m.ticketStatus === "completed") out.add("ticket_paid");
  if (m.agreedTime !== null) out.add("time_agreed");
  if (m.venueName !== null || m.status === "scheduled" || m.status === "completed") out.add("venue");
  if (m.status === "completed" || ev.has("DATE_COMPLETED")) out.add("date_completed");
  if (m.feedbackByA !== null || m.feedbackByB !== null) out.add("feedback");
  return out;
}

export function computeDateFunnelRows(
  matches: readonly FunnelMatchRow[],
  days: ReadonlySet<string>,
): MetricRow[] {
  const total = new Map<string, number>();
  const stageCount = new Map<string, number>();
  for (const m of matches) {
    const day = dayKey(m.createdAt);
    if (!days.has(day)) continue;
    bump(total, day);
    for (const stage of dateFunnelStages(m)) bump(stageCount, `${day}|${stage}`);
  }
  const rows: MetricRow[] = [];
  for (const [day, n] of total) {
    for (const stage of DATE_FUNNEL_STAGES) {
      rows.push({ day, metric: "date_funnel", dim: stage, value: stageCount.get(`${day}|${stage}`) ?? 0, n });
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// DAU, signups, money, consent share
// ─────────────────────────────────────────────────────────────────────────────

export function computeDauRows(activity: readonly ActivityDayRow[], days: ReadonlySet<string>): MetricRow[] {
  const people = new Map<string, Set<string>>();
  for (const a of activity) {
    if (!days.has(a.day)) continue;
    addToSet(people, `${a.day}|${a.platform}`, a.userId);
  }
  return [...people].map(([key, set]) => {
    const [day, platform] = key.split("|") as [string, string];
    return { day, metric: "dau" as const, dim: platform, value: set.size, n: set.size };
  });
}

export function computeSignupRows(signups: readonly SignupRow[], days: ReadonlySet<string>): MetricRow[] {
  const count = new Map<string, number>();
  for (const s of signups) {
    const day = dayKey(s.createdAt);
    if (!days.has(day)) continue;
    bump(count, `${day}|${s.platform}`);
  }
  return [...count].map(([key, value]) => {
    const [day, platform] = key.split("|") as [string, string];
    return { day, metric: "signups" as const, dim: platform, value, n: value };
  });
}

const MONEY_TYPES: Record<string, { kind: string; shown: boolean }> = {
  paywall_shown: { kind: "paywall", shown: true },
  paywall_dismissed: { kind: "paywall", shown: false },
  ticket_gate_shown: { kind: "ticket_gate", shown: true },
  ticket_gate_dismissed: { kind: "ticket_gate", shown: false },
};

export function computeMoneyRows(events: readonly PulseEventRow[], days: ReadonlySet<string>): MetricRow[] {
  const shown = new Map<string, number>();
  const dismissed = new Map<string, number>();
  for (const e of events) {
    const spec = MONEY_TYPES[e.type];
    if (!spec) continue;
    const day = dayKey(e.occurredAt);
    if (!days.has(day)) continue;
    const dim = `${spec.kind}:${str(e.props["surface"]) ?? "unknown"}`;
    bump(spec.shown ? shown : dismissed, `${day}|${dim}`);
  }
  const rows: MetricRow[] = [];
  for (const key of new Set([...shown.keys(), ...dismissed.keys()])) {
    const [day, dim] = key.split("|") as [string, string];
    const s = shown.get(key) ?? 0;
    rows.push({ day, metric: "money_shown", dim, value: s, n: s });
    rows.push({ day, metric: "money_dismissed", dim, value: dismissed.get(key) ?? 0, n: s });
  }
  return rows;
}

/**
 * Share of real accounts that existed at the end of the day and had analytics
 * consent at that moment. History is reconstructed from `analyticsOptInAt`,
 * which records only the LAST change — so a person who opted in and later out
 * disappears from earlier days too. Accepted: the share is a representativeness
 * gauge, not a ledger, and withdrawals are rare.
 */
export function computeOptInRows(users: readonly OptInUserRow[], days: readonly string[]): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const day of days) {
    const end = new Date(`${day}T00:00:00.000Z`).getTime() + DAY_MS;
    let total = 0;
    let opted = 0;
    for (const u of users) {
      if (u.createdAt.getTime() >= end) continue;
      total += 1;
      if (u.analyticsOptIn && u.analyticsOptInAt && u.analyticsOptInAt.getTime() < end) opted += 1;
    }
    if (total === 0) continue;
    rows.push({ day, metric: "analytics_opt_in_share", dim: "", value: +(opted / total).toFixed(4), n: total });
  }
  return rows;
}

/** Every `metric_days` row for the window. */
export function computeMetricRows(input: RollupInput): MetricRow[] {
  const days = new Set(input.days);
  return [
    ...computeScreenRows(input.events, days),
    ...computeOnboardingRows(input.events, input.stepEvents, input.serverSteps, days),
    ...computeDateFunnelRows(input.matches, days),
    ...computeDauRows(input.activity, days),
    ...computeSignupRows(input.signups, days),
    ...computeMoneyRows(input.events, days),
    ...computeOptInRows(input.optInUsers, input.days),
  ];
}
