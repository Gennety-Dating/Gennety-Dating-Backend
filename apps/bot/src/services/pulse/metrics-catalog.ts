import { PULSE_ANALYTICS } from "@gennety/shared";

/**
 * Pulse metric catalog (docs/product/domains/pulse-analytics.md §5.2).
 *
 * Every `metric_days.metric` value the rollup writes is declared here, with
 * the Russian description the admin panel and the agent read, its unit, what
 * its `dim` holds and what `n` counts. `GET /admin/pulse/catalog` serves this
 * object as-is, so a reader never has to guess what a number means from its
 * name — and a metric that is not in the catalog is a bug in the rollup.
 *
 * `anomaly: true` marks the daily series the `anomaly` detector watches. Not
 * all of them: a per-screen dwell percentile on a base of thirty people swings
 * by itself, and flagging it every night would bury the real alarms.
 */

export type PulseMetricUnit = "count" | "people" | "ms" | "share" | "matches";

export interface PulseMetricDef {
  name: PulseMetricName;
  /** Russian, one sentence — what the number is, not how it is computed. */
  description: string;
  unit: PulseMetricUnit;
  /** Always `day` today; declared so a weekly metric can be added honestly. */
  grain: "day";
  /** What `dim` holds ("" = the metric has no dimension). */
  dims: string;
  /** What `n` counts for this metric. */
  nMeans: string;
  /** Below this n a reader must not quote it as a share (spec §5.5). */
  minSample: number;
  /** The detector thresholds that read this metric, for the reader's benefit. */
  thresholds?: Record<string, number>;
  /** Watched by the `anomaly` detector. */
  anomaly?: true;
  /** Where the rollup reads it from. */
  source: string;
}

export const PULSE_METRIC_NAMES = [
  "screen_views",
  "screen_viewers",
  "screen_left",
  "screen_dwell_p50",
  "screen_dwell_p90",
  "screen_exit_back_fast",
  "screen_exit_background",
  "screen_taps",
  "screen_dead_taps",
  "screen_rage_taps",
  "screen_first_action_p50",
  "item_seen",
  "onboarding_step_reached",
  "onboarding_completed",
  "date_funnel",
  "dau",
  "signups",
  "money_shown",
  "money_dismissed",
  "analytics_opt_in_share",
] as const;

export type PulseMetricName = (typeof PULSE_METRIC_NAMES)[number];

const SMALL = PULSE_ANALYTICS.smallSampleN;
const CLIENT = "client_events (только с согласием, без синтетических и тестовых аккаунтов)";

/**
 * Stages of the date funnel, in order. Columns, not business labels (AGENTS.md
 * rule 9): each stage is a predicate over a `matches` row — see
 * `dateFunnelStages` in `rollup-math.ts`, which is the only place they are
 * evaluated.
 */
export const DATE_FUNNEL_STAGES = [
  "shown",
  "accepted",
  "mutual",
  "ticket_paid",
  "time_agreed",
  "venue",
  "date_completed",
  "feedback",
] as const;

export type DateFunnelStage = (typeof DATE_FUNNEL_STAGES)[number];

export const DATE_FUNNEL_STAGE_TITLES: Record<DateFunnelStage, string> = {
  shown: "Пара показана",
  accepted: "Хотя бы один «да»",
  mutual: "Оба «да»",
  ticket_paid: "Билеты оплачены",
  time_agreed: "Время согласовано",
  venue: "Место назначено",
  date_completed: "Свидание состоялось",
  feedback: "Отзыв оставлен",
};

/**
 * Onboarding funnel tracks. `ios` / `miniapp` come from client screens (the
 * registry's `onboardingOrder`); `bot` and `ios_server` from the server-side
 * `onboarding_step_events`, split by the column `platform`
 * (`telegram` → `bot`, `mobile` → `ios_server`).
 */
export const ONBOARDING_TRACKS = ["ios", "miniapp", "bot", "ios_server"] as const;
export type OnboardingTrack = (typeof ONBOARDING_TRACKS)[number];

export const PULSE_METRICS: Record<PulseMetricName, PulseMetricDef> = {
  screen_views: {
    name: "screen_views",
    description: "Сколько раз экран был показан (события screen_view).",
    unit: "count",
    grain: "day",
    dims: "screen — ключ экрана из pulse-screens.ts",
    nMeans: "показы",
    minSample: SMALL,
    anomaly: true,
    source: CLIENT,
  },
  screen_viewers: {
    name: "screen_viewers",
    description: "Сколько разных установок открыли экран за день.",
    unit: "people",
    grain: "day",
    dims: "screen",
    nMeans: "установки",
    minSample: SMALL,
    source: CLIENT,
  },
  screen_left: {
    name: "screen_left",
    description: "Сколько раз с экрана ушли (события screen_left) — знаменатель долей выхода.",
    unit: "count",
    grain: "day",
    dims: "screen",
    nMeans: "уходы",
    minSample: SMALL,
    source: CLIENT,
  },
  screen_dwell_p50: {
    name: "screen_dwell_p50",
    description: "Медиана времени на экране (только передний план).",
    unit: "ms",
    grain: "day",
    dims: "screen",
    nMeans: "уходы с измеренным временем",
    minSample: SMALL,
    source: CLIENT,
  },
  screen_dwell_p90: {
    name: "screen_dwell_p90",
    description: "90-й перцентиль времени на экране.",
    unit: "ms",
    grain: "day",
    dims: "screen",
    nMeans: "уходы с измеренным временем",
    minSample: SMALL,
    source: CLIENT,
  },
  screen_exit_back_fast: {
    name: "screen_exit_back_fast",
    description: "Быстрые уходы назад: exit = back быстрее порога.",
    unit: "count",
    grain: "day",
    dims: "screen",
    nMeans: "уходы",
    minSample: SMALL,
    thresholds: { quickBackMs: PULSE_ANALYTICS.quickBackMs },
    source: CLIENT,
  },
  screen_exit_background: {
    name: "screen_exit_background",
    description: "Сколько раз человек свернул приложение прямо с этого экрана (exit = background).",
    unit: "count",
    grain: "day",
    dims: "screen",
    nMeans: "уходы",
    minSample: SMALL,
    source: CLIENT,
  },
  screen_taps: {
    name: "screen_taps",
    description: "Касания по элементам (tap) на ключевых экранах.",
    unit: "count",
    grain: "day",
    dims: "screen",
    nMeans: "показы",
    minSample: SMALL,
    source: CLIENT,
  },
  screen_dead_taps: {
    name: "screen_dead_taps",
    description: "Касания мимо интерактивных элементов (dead_tap).",
    unit: "count",
    grain: "day",
    dims: "screen",
    nMeans: "показы",
    minSample: SMALL,
    source: CLIENT,
  },
  screen_rage_taps: {
    name: "screen_rage_taps",
    description: "Вспышки ярости: серии касаний одной установки подряд в одном месте.",
    unit: "count",
    grain: "day",
    dims: "screen",
    nMeans: "показы",
    minSample: SMALL,
    thresholds: {
      rageMinTaps: PULSE_ANALYTICS.rageMinTaps,
      rageWindowMs: PULSE_ANALYTICS.rageWindowMs,
      rageRadius: PULSE_ANALYTICS.rageRadius,
    },
    source: CLIENT,
  },
  screen_first_action_p50: {
    name: "screen_first_action_p50",
    description: "Медиана времени от появления экрана до первого касания — «сколько думает».",
    unit: "ms",
    grain: "day",
    dims: "screen",
    nMeans: "уходы с first_action_ms",
    minSample: SMALL,
    thresholds: { slowDecisionFactor: PULSE_ANALYTICS.slowDecisionFactor },
    source: CLIENT,
  },
  item_seen: {
    name: "item_seen",
    description: "Сколько установок видели блок ≥1 с при ≥50% площади (события seen).",
    unit: "people",
    grain: "day",
    dims: "screen:item",
    nMeans: "установки, открывшие экран в тот день",
    minSample: SMALL,
    thresholds: { unseenMaxSeenShare: PULSE_ANALYTICS.unseenMaxSeenShare },
    source: CLIENT,
  },
  onboarding_step_reached: {
    name: "onboarding_step_reached",
    description:
      "Сколько людей впервые дошли до шага онбординга в этот день (человек учитывается один раз — в день первого достижения).",
    unit: "people",
    grain: "day",
    dims: "track:step — track ∈ ios | miniapp | bot | ios_server",
    nMeans: "люди",
    minSample: SMALL,
    source: "client_events screen_view (ios, miniapp) + onboarding_step_events asked (bot, ios_server)",
  },
  onboarding_completed: {
    name: "onboarding_completed",
    description: "Сколько людей впервые дошли до последнего шага онбординга своей платформы.",
    unit: "people",
    grain: "day",
    dims: "track",
    nMeans: "люди",
    minSample: SMALL,
    anomaly: true,
    source: "последний шаг онбординга трека (см. onboarding_step_reached)",
  },
  date_funnel: {
    name: "date_funnel",
    description:
      "Сколько пар, созданных в этот день, дошли до стадии пути свидания (когорта по дню создания пары; молодые когорты ещё дозревают).",
    unit: "matches",
    grain: "day",
    dims: `stage ∈ ${DATE_FUNNEL_STAGES.join(" | ")}`,
    nMeans: "пары, созданные в этот день",
    minSample: SMALL,
    source: "matches + match_events",
  },
  dau: {
    name: "dau",
    description: "Активные люди за день по поверхности.",
    unit: "people",
    grain: "day",
    dims: "platform ∈ telegram | ios",
    nMeans: "люди",
    minSample: SMALL,
    anomaly: true,
    source: "user_activity_days",
  },
  signups: {
    name: "signups",
    description: "Новые аккаунты за день.",
    unit: "people",
    grain: "day",
    dims: "platform ∈ telegram | mobile | both",
    nMeans: "люди",
    minSample: SMALL,
    anomaly: true,
    source: "users.created_at",
  },
  money_shown: {
    name: "money_shown",
    description: "Показы платных экранов: пейвол и билет на свидание.",
    unit: "count",
    grain: "day",
    dims: "kind:surface — kind ∈ paywall | ticket_gate",
    nMeans: "показы",
    minSample: SMALL,
    source: "client_events paywall_shown / ticket_gate_shown",
  },
  money_dismissed: {
    name: "money_dismissed",
    description: "Закрытия платных экранов без покупки.",
    unit: "count",
    grain: "day",
    dims: "kind:surface",
    nMeans: "показы того же kind:surface",
    minSample: SMALL,
    source: "client_events paywall_dismissed / ticket_gate_dismissed",
  },
  analytics_opt_in_share: {
    name: "analytics_opt_in_share",
    description:
      "Доля настоящих аккаунтов (на конец дня) с согласием на аналитику — насколько выборка Pulse представляет всех.",
    unit: "share",
    grain: "day",
    dims: "",
    nMeans: "настоящие аккаунты на конец дня",
    minSample: SMALL,
    source: "users.analytics_opt_in / analytics_opt_in_at",
  },
};

/** Russian label of a metric for titles ("Показы экрана"). */
export const PULSE_METRIC_TITLES: Record<PulseMetricName, string> = {
  screen_views: "Показы экрана",
  screen_viewers: "Открывшие экран",
  screen_left: "Уходы с экрана",
  screen_dwell_p50: "Медиана времени на экране",
  screen_dwell_p90: "p90 времени на экране",
  screen_exit_back_fast: "Быстрые уходы назад",
  screen_exit_background: "Сворачивания с экрана",
  screen_taps: "Касания",
  screen_dead_taps: "Касания мимо",
  screen_rage_taps: "Вспышки ярости",
  screen_first_action_p50: "Время до первого действия",
  item_seen: "Увидели блок",
  onboarding_step_reached: "Дошли до шага",
  onboarding_completed: "Завершили онбординг",
  date_funnel: "Путь свидания",
  dau: "Активные за день",
  signups: "Регистрации",
  money_shown: "Показы платных экранов",
  money_dismissed: "Закрытия платных экранов",
  analytics_opt_in_share: "Доля с согласием на аналитику",
};
