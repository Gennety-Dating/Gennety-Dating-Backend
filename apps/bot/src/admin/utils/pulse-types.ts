/**
 * Response shapes of `GET /admin/pulse/*` (docs/product/domains/pulse-analytics.md §6).
 *
 * This file is the contract: the admin dashboard mirrors these types and the
 * agent playbook (`docs/operations/agent-app-audit.md` → "Endpoints") quotes
 * them. Change a field here and both of those must move with it. Additive
 * changes only, unless the dashboard ships in the same deploy.
 *
 * Privacy rule for every shape: people are referenced by user id, platform and
 * signup DAY only. No names, phones, emails, usernames, photos or message
 * text — the rollup never reads them, and these types have nowhere to put them.
 *
 * Times are ISO-8601 strings in UTC; days are `YYYY-MM-DD` UTC.
 */

import type { PulseMetricDef } from "../../services/pulse/metrics-catalog.js";

export type PulseSeverity = 1 | 2 | 3;

export type PulseInsightKind =
  | "stuck_people"
  | "funnel_drop"
  | "screen_friction"
  | "slow_decision"
  | "anomaly"
  | "unseen";

/** How much to trust the numbers before reading them. In every response. */
export interface PulseDataFreshness {
  /** `received_at` of the newest client event (any user), or null if none ever. */
  lastEventAt: string | null;
  /** `computed_at` of the newest `metric_days` row, or null if never rolled up. */
  lastRollupAt: string | null;
  /** True when the rollup is older than `staleAfterHours` (36 h) or never ran. */
  rollupStale: boolean;
  /** `CLIENT_EVENTS_ENABLED` on this server — false means screen data cannot exist. */
  clientEventsEnabled: boolean;
  /** Share of real accounts with analytics consent, 0..1 (null with no accounts). */
  optInShare: number | null;
  /** Real accounts behind `optInShare`. */
  optInN: number;
}

export interface PulseEnvelope {
  generatedAt: string;
  dataFreshness: PulseDataFreshness;
}

export interface PulseInsight {
  id: string;
  key: string;
  kind: PulseInsightKind;
  severity: PulseSeverity;
  /** Screen key, `funnel:step`, `metric:dim` or `screen:item`. */
  scope: string;
  /** Russian, template-rendered. Under the small-sample rule — absolute numbers. */
  title: string;
  value: number | null;
  baseline: number | null;
  n: number;
  smallSample: boolean;
  /** Numbers and user ids only. */
  evidence: Record<string, unknown>;
  /** `ios:<path>` (Gennety-iOS repo) or `backend:<path>` (this repo), or null. */
  codeHint: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  /** Sort key: severity × max(1, n). */
  weight: number;
}

/** The compact form `/brief` lists. Full rows: `/insights`. */
export type PulseBriefInsight = Pick<
  PulseInsight,
  "id" | "kind" | "severity" | "scope" | "title" | "n" | "smallSample" | "codeHint" | "weight"
>;

export interface PulseKpi {
  key: "new_users" | "onboarding_completed" | "dates_scheduled" | "revenue_usd";
  label: string;
  thisWeek: number | null;
  lastWeek: number | null;
  unit: "people" | "matches" | "usd";
  /** n < 30 in either week — compare as a story, not a trend. */
  smallSample: boolean;
}

export interface PulseNextHint {
  /** Path with query, relative to the admin host. */
  endpoint: string;
  why: string;
}

export interface PulseBriefResponse extends PulseEnvelope {
  /** Last complete UTC day the week windows end on. */
  asOf: string;
  thisWeek: { from: string; to: string };
  lastWeek: { from: string; to: string };
  kpis: PulseKpi[];
  insights: PulseBriefInsight[];
  /** Open insights in total (the list above is capped). */
  openInsights: number;
  next: PulseNextHint[];
}

export interface PulseScreenWindow {
  views: number;
  /** Σ of daily distinct viewers. */
  viewerDays: number;
  left: number;
  dwellP50Ms: number | null;
  dwellP90Ms: number | null;
  firstActionP50Ms: number | null;
  quickBack: number;
  deadTaps: number;
  rageTaps: number;
  /** `exit = background` straight from this screen. */
  exits: number;
  /** exits ÷ left, 0..1 — null when nobody left or n < 30 (use the counts). */
  exitShare: number | null;
  /** Friction per 100 views (spec §5.4); null with no views. */
  friction: number | null;
  smallSample: boolean;
}

export interface PulseScreenSummary {
  screen: string;
  /** From `pulse-screens.ts`; the raw key when the screen is not registered. */
  title: string;
  platform: "ios" | "miniapp" | null;
  codeHint: string | null;
  /** False for a key the registry does not know (a newer client). */
  known: boolean;
  d7: PulseScreenWindow;
  d28: PulseScreenWindow;
}

export interface PulseScreensResponse extends PulseEnvelope {
  asOf: string;
  /** Sorted by `d7.friction` desc, then `d7.views` desc. */
  screens: PulseScreenSummary[];
}

export interface PulseScreenDay {
  day: string;
  views: number;
  left: number;
  dwellP50Ms: number | null;
  dwellP90Ms: number | null;
  firstActionP50Ms: number | null;
  quickBack: number;
  exits: number;
  taps: number;
  deadTaps: number;
  rageTaps: number;
}

export type PulsePoint = [number, number];

export interface PulseScreenDetailResponse extends PulseEnvelope {
  screen: string;
  title: string;
  platform: "ios" | "miniapp" | null;
  codeHint: string | null;
  tracksTaps: boolean;
  d7: PulseScreenWindow;
  d28: PulseScreenWindow;
  /** The last 28 days, oldest first; days without data are absent. */
  days: PulseScreenDay[];
  /** Normalized 0..1 coordinates over the last 28 days, newest first. */
  taps: {
    /** Taps on elements and dead taps together, at most 2000. */
    points: PulsePoint[];
    dead: PulsePoint[];
    /** Every point of every rage cluster. */
    rage: PulsePoint[];
    total: number;
    truncated: boolean;
  };
  /** Taps per element key (top 30). */
  elements: Array<{ element: string; taps: number }>;
  /** Per app version over 28 days — "did the new build fix it". */
  versions: Array<{ appVersion: string; views: number; quickBack: number; deadTaps: number }>;
  /** Blocks seen ≥1 s on this screen over 7 days. */
  items: Array<{ item: string; seen: number; viewerDays: number }>;
}

export interface PulseJourneyItem {
  at: string;
  kind: "screen" | "tap_cluster" | "server_milestone";
  screen?: string;
  dwellMs?: number;
  /** Russian, from templates — never user content. */
  label: string;
}

export interface PulseJourney {
  userId: string;
  /** `ios` | `miniapp` from client events, else `bot` / `ios` from the account. */
  platform: string;
  /** UTC day only — never a full timestamp. */
  signupDate: string;
  stuck: { since: string; where: string; whereTitle: string; phase: "onboarding" | "date" } | null;
  /** Oldest first, at most 200 (`/journeys/:userId`) or 40 (list) of the latest. */
  items: PulseJourneyItem[];
  truncated: boolean;
}

export interface PulseJourneysResponse extends PulseEnvelope {
  stuckOnly: boolean;
  journeys: PulseJourney[];
}

export interface PulseJourneyResponse extends PulseEnvelope {
  journey: PulseJourney;
}

export interface PulseCatalogResponse extends PulseEnvelope {
  metrics: PulseMetricDef[];
  thresholds: Record<string, unknown>;
  screens: Array<{
    screen: string;
    title: string;
    platform: "ios" | "miniapp";
    codeHint: string;
    tracksTaps: boolean;
    onboardingOrder: number | null;
  }>;
}

export interface PulseFunnelStep {
  step: string;
  title: string;
  d7: number;
  d28: number;
  /** passed ÷ entered from the previous non-bypassed step, 0..1; null under n < 30. */
  conversionD7: number | null;
  conversionD28: number | null;
}

export interface PulseFunnel {
  /** `onboarding_ios` | `onboarding_miniapp` | `onboarding_bot` | `onboarding_ios_server` | `date`. */
  id: string;
  title: string;
  /** People (onboarding) or pairs (date) entering the first step, 7 / 28 days. */
  enteredD7: number;
  enteredD28: number;
  smallSample: boolean;
  steps: PulseFunnelStep[];
}

export interface PulseFunnelsResponse extends PulseEnvelope {
  asOf: string;
  funnels: PulseFunnel[];
  /** Paywall / ticket gate shown and dismissed, 7 days, per `kind:surface`. */
  money: Array<{ dim: string; shown: number; dismissed: number }>;
}

export interface PulseInsightsResponse extends PulseEnvelope {
  status: "open" | "all";
  insights: PulseInsight[];
}
