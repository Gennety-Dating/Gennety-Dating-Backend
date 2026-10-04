/**
 * When the ceremony plays — once, and only for a meeting this screen saw happen.
 *
 * Two ways in:
 *
 *   1. **The hold's own answer** carries `ceremony: { startAt, role }`. That is
 *      the real thing: both phones start the same scene on the server's clock.
 *   2. **The degrade path.** Until the bot's long-poll is deployed, production
 *      ignores `hold` and answers at once without `ceremony`; a hold request
 *      can also die on a bad connection while the partner's completes the
 *      pair. Either way the terminal learns "verified" from a state read.
 *      If this screen had SEEN the date unverified, the meeting happened while
 *      it was open, so the scene plays locally as B (the mascot falls in,
 *      winks, becomes the plaque's mark) starting now — not in step with the
 *      other phone, but complete.
 *
 * Never: twice (whatever arrives after a scene is ignored), for a terminal
 * opened after the fact (first read already verified — the silent synced
 * view), or from a state read while a hold request is still out (its answer
 * may carry the synchronised scene; a poll landing first must not pre-empt it).
 */

import type { CeremonyRole } from "./ceremony-stand.js";
import { parseServerTime } from "./clock.js";

export interface CeremonyGate {
  /** A state read in this screen's lifetime said "not verified yet". */
  sawUnverified: boolean;
  /** A scene has been cued. */
  played: boolean;
}

export const GATE_START: CeremonyGate = { sawUnverified: false, played: false };

export interface CeremonyCue {
  role: CeremonyRole;
  /** Server-clock epoch ms at which scene time is 0. */
  startAt: number;
  /** False on the degrade path — started locally, not on the shared clock. */
  synced: boolean;
}

export interface GateStep {
  gate: CeremonyGate;
  cue: CeremonyCue | null;
}

/** The `ceremony` object of a hold's 200 answer, as the contract sends it. */
export interface BumpCeremonyWire {
  startAt: string;
  role: CeremonyRole;
  serverNow: string;
}

export function cueFromHold(gate: CeremonyGate, ceremony: BumpCeremonyWire | null | undefined): GateStep {
  if (gate.played || !ceremony) return { gate, cue: null };
  const startAt = parseServerTime(ceremony.startAt);
  if (!Number.isFinite(startAt) || (ceremony.role !== "A" && ceremony.role !== "B")) return { gate, cue: null };
  return { gate: { ...gate, played: true }, cue: { role: ceremony.role, startAt, synced: true } };
}

export function cueFromState(
  gate: CeremonyGate,
  read: { verified: boolean; holdInFlight: boolean; serverNow: number },
): GateStep {
  if (!read.verified) return gate.sawUnverified ? { gate, cue: null } : { gate: { ...gate, sawUnverified: true }, cue: null };
  if (gate.played || !gate.sawUnverified || read.holdInFlight) return { gate, cue: null };
  return { gate: { ...gate, played: true }, cue: { role: "B", startAt: read.serverNow, synced: false } };
}
