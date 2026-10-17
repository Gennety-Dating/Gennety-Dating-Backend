import { PULSE_ANALYTICS } from "@gennety/shared";
import { screenTitle, plural } from "../../services/pulse/detectors.js";
import { detectRageClusters, tapPointsOf, type PulseEventRow } from "../../services/pulse/rollup-math.js";
import type { PulseJourneyItem } from "./pulse-types.js";

/**
 * One person's path, compressed for a reader with a token budget
 * (`/admin/pulse/journeys*`). Pure: the route loads, this shapes.
 *
 * What is kept and why:
 *   - a screen visit is ONE item (`screen_view` + its `screen_left`), with the
 *     foreground time — "sat on «Город» for 4 minutes" is the whole point;
 *   - a run of taps on one screen is ONE `tap_cluster`, labelled with the
 *     element keys (closed client list, never user content), dead taps and rage;
 *   - server facts the client cannot see (sign-up, onboarding answers by step
 *     key, pair shown / accepted / date happened) are `server_milestone`s, as
 *     are the legacy client funnel events (paywall / ticket gate shown, etc.).
 * What is never here: names, message text, answers, venue names — the loaders
 * do not select them, and every label below is a template over keys.
 */

export interface JourneyStepEvent {
  step: string;
  kind: string;
  createdAt: Date;
}

export interface JourneyMatchEvent {
  actionType: string;
  createdAt: Date;
}

export interface JourneySources {
  events: readonly PulseEventRow[];
  steps: readonly JourneyStepEvent[];
  matchEvents: readonly JourneyMatchEvent[];
  signupAt: Date;
  verifiedAt: Date | null;
}

const MATCH_LABELS: Record<string, string> = {
  PROPOSAL_SHOWN: "Показана пара",
  ACCEPTED: "Ответ на пару: да",
  DECLINED: "Ответ на пару: нет",
  DATE_COMPLETED: "Свидание состоялось",
  CHEMISTRY_POSITIVE: "Отзыв: искра есть",
  CHEMISTRY_NEGATIVE: "Отзыв: искры нет",
  EXPIRED_SILENT: "Не ответил(а) на пару в срок",
  EXPIRED_PEER_IGNORED: "Пара не ответила в срок",
};

const LEGACY_LABELS: Record<string, string> = {
  onboarding_step_left: "Ушёл(ла) с шага онбординга",
  permission_prompted: "Запрос разрешения",
  permission_denied: "Разрешение не дано",
  liveness_finished: "Проверка лица завершена",
  paywall_shown: "Показан пейвол",
  paywall_dismissed: "Пейвол закрыт",
  ticket_gate_shown: "Показан билет на свидание",
  ticket_gate_dismissed: "Билет на свидание закрыт",
  fatal_client_error: "Ошибка приложения",
  tempo_sync: "Tempo Sync",
};

function seconds(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} с`;
  return `${Math.round(ms / 60_000)} мин`;
}

function legacyDetail(e: PulseEventRow): string {
  const value = Object.values(e.props).find((v) => typeof v === "string");
  return typeof value === "string" ? ` (${value})` : "";
}

/** Client events → screen visits and tap clusters, in order. */
function clientItems(events: readonly PulseEventRow[]): Array<PulseJourneyItem & { _t: number }> {
  const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const out: Array<PulseJourneyItem & { _t: number }> = [];
  let open: (PulseJourneyItem & { _t: number }) | null = null;
  let taps: PulseEventRow[] = [];

  const flushTaps = (): void => {
    if (taps.length === 0) return;
    const first = taps[0]!;
    const screen = first.screen ?? String(first.props["screen"] ?? "");
    const dead = taps.filter((t) => t.type === "dead_tap").length;
    const elements = [
      ...new Set(
        taps
          .filter((t) => t.type === "tap")
          .map((t) => t.props["element"])
          .filter((v): v is string => typeof v === "string"),
      ),
    ];
    const rage = detectRageClusters(tapPointsOf(taps)).length;
    const parts = [`${taps.length} ${plural(taps.length, "касание", "касания", "касаний")}`];
    if (elements.length > 0) parts.push(`по ${elements.slice(0, 5).join(", ")}`);
    if (dead > 0) parts.push(`мимо: ${dead}`);
    if (rage > 0) parts.push(`ярость: ${rage}`);
    out.push({
      at: first.occurredAt.toISOString(),
      _t: first.occurredAt.getTime(),
      kind: "tap_cluster",
      screen,
      label: parts.join(", "),
    });
    taps = [];
  };

  const closeOpen = (): void => {
    if (open) out.push(open);
    open = null;
  };

  for (const e of sorted) {
    const screen = e.screen ?? (typeof e.props["screen"] === "string" ? e.props["screen"] : null);
    if (e.type === "tap" || e.type === "dead_tap") {
      if (taps.length > 0 && (taps[0]!.screen ?? taps[0]!.props["screen"]) !== screen) flushTaps();
      taps.push(e);
      continue;
    }
    if (e.type === "seen") continue;
    flushTaps();
    if (e.type === "screen_view" && screen) {
      closeOpen();
      open = {
        at: e.occurredAt.toISOString(),
        _t: e.occurredAt.getTime(),
        kind: "screen",
        screen,
        label: screenTitle(screen),
      };
      continue;
    }
    if (e.type === "screen_left" && screen) {
      const dwell = typeof e.props["dwell_ms"] === "number" ? e.props["dwell_ms"] : undefined;
      const exit = typeof e.props["exit"] === "string" ? e.props["exit"] : null;
      const current = open as (PulseJourneyItem & { _t: number }) | null;
      const item: PulseJourneyItem & { _t: number } =
        current && current.screen === screen
          ? current
          : {
              at: e.occurredAt.toISOString(),
              _t: e.occurredAt.getTime(),
              kind: "screen",
              screen,
              label: screenTitle(screen),
            };
      if (dwell !== undefined) item.dwellMs = dwell;
      item.label = `${screenTitle(screen)}${dwell !== undefined ? ` — ${seconds(dwell)}` : ""}${exit ? `, выход: ${exit}` : ""}`;
      if (item !== current) closeOpen();
      out.push(item);
      open = null;
      continue;
    }
    if (LEGACY_LABELS[e.type]) {
      out.push({
        at: e.occurredAt.toISOString(),
        _t: e.occurredAt.getTime(),
        kind: "server_milestone",
        label: `${LEGACY_LABELS[e.type]}${legacyDetail(e)}`,
      });
    }
  }
  flushTaps();
  closeOpen();
  return out;
}

export function buildJourneyItems(
  src: JourneySources,
  maxItems: number = PULSE_ANALYTICS.journeyMaxItems,
): { items: PulseJourneyItem[]; truncated: boolean } {
  // Sign-up is stated as a DAY (spec: a person is id + platform + signup date),
  // so the marker sits at that day's UTC midnight rather than the exact moment.
  const signupDay = new Date(`${src.signupAt.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const all: Array<PulseJourneyItem & { _t: number }> = [
    { at: signupDay.toISOString(), _t: signupDay.getTime(), kind: "server_milestone", label: "Регистрация (день)" },
    ...clientItems(src.events),
  ];
  if (src.verifiedAt) {
    all.push({ at: src.verifiedAt.toISOString(), _t: src.verifiedAt.getTime(), kind: "server_milestone", label: "Проверка пройдена" });
  }
  for (const s of src.steps) {
    if (s.kind !== "answered" && s.kind !== "skipped") continue;
    all.push({
      at: s.createdAt.toISOString(),
      _t: s.createdAt.getTime(),
      kind: "server_milestone",
      label: `Анкета: ${s.step} — ${s.kind === "answered" ? "ответ" : "пропуск"}`,
    });
  }
  for (const m of src.matchEvents) {
    all.push({
      at: m.createdAt.toISOString(),
      _t: m.createdAt.getTime(),
      kind: "server_milestone",
      label: MATCH_LABELS[m.actionType] ?? m.actionType,
    });
  }
  all.sort((a, b) => a._t - b._t);
  const truncated = all.length > maxItems;
  const kept = truncated ? all.slice(all.length - maxItems) : all;
  return { items: kept.map(stripSortKey), truncated };
}

function stripSortKey(x: PulseJourneyItem & { _t: number }): PulseJourneyItem {
  const item: PulseJourneyItem = { at: x.at, kind: x.kind, label: x.label };
  if (x.screen !== undefined) item.screen = x.screen;
  if (x.dwellMs !== undefined) item.dwellMs = x.dwellMs;
  return item;
}
