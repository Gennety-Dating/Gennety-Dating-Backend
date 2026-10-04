/**
 * Types for the vendored stand (`ceremony-stand.js`). Only what the Mini App
 * reads; the stand's x-ray helpers (`ground`, `seamInfo`) are typed loosely.
 */

export type CeremonyRole = "A" | "B";

/** A phone as the stand sees it. Points, and millimetres per point. */
export interface CeremonyDevice {
  name: string;
  w: number;
  h: number;
  mm: number;
  /** Bottom inset (home indicator), points. Only its truthiness moves the capsule. */
  home: number;
  /** Bezel above the screen, mm — used only by the stand's table x-ray. */
  top: number;
}

export interface CeremonyLayout {
  capY: number;
  capW: number;
  capH: number;
  foot: number;
  apex: number;
  panelTop: number;
}

export interface CeremonyPhone {
  key: CeremonyRole;
  d: CeremonyDevice;
  rot: number;
  L: CeremonyLayout;
  toWorld(x: number, y: number): [number, number];
  toLocal(x: number, y: number): [number, number];
}

export interface CeremonyConfig {
  devA: string;
  devB: string;
  gap: number;
  offset: number;
  speed: number;
  clock: number;
  rm?: boolean;
  markDX?: number;
}

export type CeremonyHapticId = "ceremonyLaunch" | "magSafeSnap" | "success";

export interface CeremonyHaptic {
  who: string;
  t: number;
  id: CeremonyHapticId;
  note: string;
  tg: string;
}

export interface CeremonyBeat {
  who: string;
  from: number;
  to: number;
  label: string;
}

export interface CeremonyPlan {
  cfg: CeremonyConfig;
  rm: boolean;
  A: CeremonyPhone;
  B: CeremonyPhone;
  TA: number;
  TT: number;
  TB: number;
  t1: number;
  t2: number;
  t3: number;
  b: {
    gather: number;
    pop: number;
    eyes: number;
    look: number;
    crouch: number;
    leap: number;
    glance: number;
    wink: number;
    dissolve: number;
    plaque: number;
  };
  tEnd: number;
  markDX: number;
  beats: CeremonyBeat[];
  haptics: CeremonyHaptic[];
}

export interface CeremonyEyes {
  gx: number;
  gy: number;
  blinkL: number;
  blinkR: number;
  smileL: number;
  smileR: number;
}

export interface CeremonyExpression {
  alpha: number;
  scale: number;
  sx: number;
  sy: number;
  anchor: number;
  tilt: number;
  flexL: number;
  flexR: number;
  lift: number;
  eyes: CeremonyEyes;
  sparkle: number;
  sparkleP?: number;
  toMark?: number;
}

export interface CeremonyMascot {
  C: [number, number];
  s: number;
  rot: number;
  sx: number;
  sy: number;
  e: CeremonyExpression;
  s0: number;
  blur: number;
}

export interface CeremonyCapsule {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: number;
  label: string;
  labelAlpha: number;
  alpha?: number;
  waiting?: boolean;
}

export interface CeremonyPlaque {
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
  text: number;
  title: string;
  sub: string;
  markX: number;
  mark?: number;
}

export interface CeremonyFrame {
  t: number;
  key: CeremonyRole;
  stage: number;
  blur: number;
  capsule: CeremonyCapsule | null;
  plaque: CeremonyPlaque | null;
  mascot: CeremonyMascot | null;
}

export declare const Ceremony: {
  clamp(v: number, a?: number, b?: number): number;
  mix(a: number, b: number, p: number): number;
  seg(t: number, start: number, dur: number): number;
  DEVICES: Record<string, CeremonyDevice>;
  UNIT_MM: number;
  FLIGHT: { rise: number; air: number; fall: number; top: number; grow: number; blur: number };
  layout(d: CeremonyDevice): CeremonyLayout;
  plan(cfg: CeremonyConfig): CeremonyPlan;
  frame(P: CeremonyPlan, key: CeremonyRole, tGlobal: number): CeremonyFrame;
  bodyMatrix(m: CeremonyMascot): DOMMatrix;
};
