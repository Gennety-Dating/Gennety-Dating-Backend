/**
 * The stand on a Telegram phone — everything the vendored `ceremony-stand.js`
 * does not know, kept OUT of it so the copy stays byte-for-byte the stand's.
 *
 *   - **The screen.** The stand plans against its `DEVICES` table (four
 *     measured phones). A Mini App knows only its viewport in CSS px, so
 *     `ownDevice` describes it in the stand's terms and `planFor` registers it
 *     for the one `plan` call. The frame math is untouched; the parity test
 *     proves this path reproduces the stand's own numbers.
 *   - **Where the capsule is.** The stand puts the hold capsule at 74 % of the
 *     screen (iOS keeps it on the canvas sheet there). The terminal's capsule
 *     lives in its action bar, and the scene has to start from the capsule the
 *     finger actually held — so `capY` can be moved to it. The mascot's foot
 *     keeps the stand's distance below the capsule, read from the stand's own
 *     `layout`, not re-derived here.
 *   - **The words.** The stand's frames carry its Russian demo labels; the
 *     terminal swaps in its own language's strings by value.
 *   - **When to buzz.** The stand lists its haptics per role; `dueHaptics`
 *     picks the ones a frame step crossed.
 */

import {
  Ceremony,
  type CeremonyDevice,
  type CeremonyFrame,
  type CeremonyHapticId,
  type CeremonyPlan,
  type CeremonyRole,
} from "./ceremony-stand.js";

/**
 * Millimetres per CSS px — an estimate, and the only one available to a web
 * page. On iPhone a CSS px is a point (≈ 0.157–0.166 mm); on Android a CSS px
 * is a dp, nominally 1/160 in (0.159 mm). The mascot's height in mm is all it
 * drives, and a few percent of it is invisible.
 */
export const MM_PER_CSS_PX = 0.16;

/** The stand's pace (mm/s) — the only speed the founder approved. */
const STAND_SPEED = 280;

export interface OwnScreen {
  /** Viewport width, CSS px. */
  w: number;
  /** Viewport height, CSS px (full screen in Telegram fullscreen mode). */
  h: number;
  /** Bottom safe-area inset, CSS px. */
  home: number;
  mm?: number;
}

export function ownDevice(screen: OwnScreen): CeremonyDevice {
  return {
    name: "Telegram viewport",
    w: screen.w,
    h: screen.h,
    mm: screen.mm ?? MM_PER_CSS_PX,
    home: screen.home,
    // The bezel is read only by the stand's table x-ray, never by a frame.
    top: 0,
  };
}

export interface PlanOptions {
  /** `prefers-reduced-motion: reduce` — the stand's `rm` branch. */
  rm: boolean;
  /** Where the plaque's mark sits from its centre (`Render.plaqueMarkDX`). */
  markDX: number;
  /** The capsule's centre, px from the top, when it is not where the stand puts it. */
  capY?: number;
}

let registrations = 0;

/**
 * One phone's plan. Both roles are planned on the SAME device: a frame reads
 * only its own phone's layout (see `flight`), and the partner's phone is never
 * sent — the stand's own fixtures pair a phone with itself for the same reason.
 */
export function planFor(device: CeremonyDevice, options: PlanOptions): CeremonyPlan {
  const key = `__miniapp_${++registrations}`;
  Ceremony.DEVICES[key] = device;
  let plan: CeremonyPlan;
  try {
    plan = Ceremony.plan({
      devA: key,
      devB: key,
      gap: 4,
      offset: 0,
      speed: STAND_SPEED,
      clock: 0,
      rm: options.rm,
      markDX: options.markDX,
    });
  } finally {
    delete Ceremony.DEVICES[key];
  }
  if (options.capY !== undefined) {
    const base = Ceremony.layout(device);
    const footBelowCapsule = base.foot - base.capY;
    const moved = { ...base, capY: options.capY, foot: options.capY + footBelowCapsule };
    plan.A.L = moved;
    plan.B.L = { ...moved };
  }
  return plan;
}

export interface CeremonyLabels {
  /** The waiting capsule — «Ждём твою пару…». */
  waiting: string;
  /** The capsule of the phone whose hold completed the pair — «Готово». */
  ready: string;
  title: string;
  sub: string;
}

/** The stand's own strings, exactly as its frames carry them. */
export const STAND_LABELS: Readonly<CeremonyLabels> = {
  waiting: "Ждём Аню…",
  ready: "Готово",
  title: "Встреча подтверждена",
  sub: "Следующий билет — за мной",
};

export function localizeFrame(frame: CeremonyFrame, labels: CeremonyLabels): CeremonyFrame {
  const out: CeremonyFrame = { ...frame };
  if (frame.capsule) {
    const label =
      frame.capsule.label === STAND_LABELS.waiting
        ? labels.waiting
        : frame.capsule.label === STAND_LABELS.ready
          ? labels.ready
          : frame.capsule.label;
    out.capsule = { ...frame.capsule, label };
  }
  if (frame.plaque) out.plaque = { ...frame.plaque, title: labels.title, sub: labels.sub };
  return out;
}

export interface RoleHaptic {
  t: number;
  id: CeremonyHapticId;
}

export function hapticsFor(plan: CeremonyPlan, role: CeremonyRole): RoleHaptic[] {
  return plan.haptics.filter((h) => h.who.includes(role)).map((h) => ({ t: h.t, id: h.id }));
}

/**
 * The haptics a frame step from `prev` to `now` (scene ms) crossed. A beat
 * crossed more than `staleMs` ago is dropped: a phone that joins the scene
 * late, or wakes from a stalled frame, buzzes for what is on screen now, never
 * for a landing that already happened.
 */
export function dueHaptics(list: readonly RoleHaptic[], prev: number, now: number, staleMs = 200): CeremonyHapticId[] {
  return list.filter((h) => h.t > prev && h.t <= now && now - h.t <= staleMs).map((h) => h.id);
}
