import type { Language } from "@gennety/shared";
import type { MatchStatus, OnboardingStep, UserStatus, VerificationStatus } from "@gennety/db";
import type { DemoBeat } from "./script.js";

/**
 * What the puppet owes the visitor right now — a pure function of observed
 * state.
 *
 * This is the whole reason demo mode does not rot. There are no callbacks wired
 * into the pitch, calendar, venue or ticket handlers: the driver re-derives the
 * situation on every tick and asks this function what to do, exactly as
 * `workers/peer-wait-shimmer.ts` re-derives who is waiting rather than tracking
 * it. A change to a production flow shows up here as a different snapshot, not
 * as a broken hook.
 *
 * Everything below is deterministic and I/O-free so the interesting part — the
 * decision table — is unit-testable without a database, a bot or a clock.
 */

export type DemoAction =
  /** Say something in the demo's own voice (fake gate, compressed wait, …). */
  | { kind: "narrate"; beat: DemoBeat }
  /** Explain matchmaking, then create the first match and dispatch the pitch. */
  | { kind: "pitch" }
  /** The puppet answers the proposal. Only ever "yes". */
  | { kind: "partner_accept" }
  /** Settle the puppet's half of the Date Ticket gate from its wallet. */
  | { kind: "partner_pay_ticket" }
  /** Mark availability that deliberately does NOT overlap the visitor's. */
  | { kind: "partner_counter_slots"; slots: string[] }
  /** Give in and take one of the visitor's slots, which auto-locks the date. */
  | { kind: "partner_converge_slots"; slots: string[] }
  /** Submit the puppet's departure point + vibe, which finalizes the venue. */
  | { kind: "partner_venue" }
  /** Heart a venue the visitor did not, so the board needs a second round. */
  | { kind: "partner_counter_likes" }
  /** Heart one the visitor already liked, which agrees the change. */
  | { kind: "partner_agree_likes" }
  /** The puppet is the payer for the venue change; settle it for free. */
  | { kind: "partner_settle_venue_change" }
  /** Explain the pre-date days, then play them out immediately. */
  | { kind: "run_predate" }
  /** The visitor passed. Explain that it is final, offer the demo way back. */
  | { kind: "offer_continue" }
  | { kind: "none" };

export interface DemoDecision {
  action: DemoAction;
  /**
   * How long this action must have been *continuously* owed before the driver
   * performs it. Zero for narration (the visitor is mid-step and should read it
   * now); a beat for anything the puppet "does", so the peer-wait shimmer and
   * the real waiting copy are on screen long enough to be read.
   */
  waitMs: number;
}

export interface DemoMatchSnapshot {
  id: string;
  status: MatchStatus;
  /** Which side of the row the *visitor* is on. */
  visitorSide: "A" | "B";
  visitorAccepted: boolean | null;
  partnerAccepted: boolean | null;
  /** Date Ticket gate (§3.5b). `ticketOpen` is false when the feature is off. */
  ticketOpen: boolean;
  visitorTicketPaid: boolean;
  partnerTicketPaid: boolean;
  /** Server-owned slot allowlist; empty until the Calendar actually opens. */
  proposedTimes: string[];
  visitorSlots: string[];
  partnerSlots: string[];
  agreedTime: Date | null;
  visitorVenueConfirmed: boolean;
  partnerVenueConfirmed: boolean;
  icebreakersSentAt: Date | null;
  /** §3.7b board sub-state: null | liking | agreed | settled | lapsed. */
  venueChangeStatus: string | null;
  visitorLikeKeys: string[];
  partnerLikeKeys: string[];
  /** True when the payer matrix puts the bill on the puppet, not the visitor. */
  venueChangePayerIsPartner: boolean;
}

export interface DemoSnapshot {
  language: Language | null;
  status: UserStatus;
  onboardingStep: OnboardingStep;
  verificationStatus: VerificationStatus;
  /** `OnboardingProgress.currentQuestion` — the collector's next missing field. */
  currentQuestion: string | null;
  /** Narration already delivered this process lifetime (see driver). */
  spokenBeats: ReadonlySet<DemoBeat>;
  /** The live match with the puppet, if any. */
  match: DemoMatchSnapshot | null;
  /** A finished match with the puppet the visitor has not been offered a redo on. */
  awaitingContinueOffer: boolean;
}

/** A beat, so the shimmer and the "waiting on your partner" copy are readable. */
export const DEMO_STEP_WAIT_MS = 12_000;
/**
 * How long the puppet holds out on a calendar it has already countered before
 * giving in. The visitor is meant to answer the counter-proposal themselves —
 * that is the mechanic being demonstrated — but a demo must never dead-end, so
 * the puppet eventually takes one of their slots and the date locks.
 */
export const DEMO_CONVERGE_WAIT_MS = 90_000;

export function decideDemoAction(snapshot: DemoSnapshot): DemoDecision {
  const narration = decideNarration(snapshot);
  if (narration) return { action: narration, waitMs: 0 };

  if (snapshot.awaitingContinueOffer) {
    return { action: { kind: "offer_continue" }, waitMs: DEMO_STEP_WAIT_MS };
  }

  const match = snapshot.match;
  if (!match) {
    // Verified and active with nothing in flight: this is the first pitch.
    // `awaitingContinueOffer` above already caught the post-decline case, so
    // reaching here with no match at all means the demo has not started.
    return isLive(snapshot)
      ? { action: { kind: "pitch" }, waitMs: DEMO_STEP_WAIT_MS }
      : { action: { kind: "none" }, waitMs: 0 };
  }

  return decideMatchAction(match);
}

function isLive(snapshot: DemoSnapshot): boolean {
  return (
    snapshot.status === "active" &&
    snapshot.onboardingStep === "completed" &&
    snapshot.verificationStatus === "verified"
  );
}

/**
 * The three moments the demo has to speak for itself. Each is tied to a state
 * the product itself owns, so the beat lands at the right time without the
 * onboarding flow knowing demo mode exists — and, for the intro, late enough
 * that the visitor has told us which language to say it in.
 */
function decideNarration(snapshot: DemoSnapshot): DemoAction | null {
  const spoken = snapshot.spokenBeats;

  // The intro waits for the onboarding Mini App to hand the chat back, because
  // that Mini App is where the visitor picks their language (PRODUCT_SPEC §1.2:
  // `consent` and `language` are Mini App-owned steps with no chat screens).
  // Firing at `/start` meant `User.language` was still null and this longest,
  // most explanatory message in the demo resolved to English for everyone —
  // pushed at someone who had not yet been asked which language they read.
  // Baking it into the Mini App instead was rejected: demo behaviour must not
  // leak into `apps/webapp`.
  // The upper bound is what makes the beat survive a restart. `spokenBeats` is
  // in memory (no demo-only schema, DEMO_MODE.md), so a deploy mid-demo forgets
  // what a visitor has read — and every other beat is saved by its own window
  // already having closed. Without one here, an active visitor would be handed
  // the whole "how this works" opener again on the next PM2 restart. Once they
  // are past onboarding the moment has genuinely passed: the matchmaking beat
  // that precedes the pitch covers what happens from there.
  if (!spoken.has("intro")) {
    const beforeHandoff =
      snapshot.onboardingStep === "consent" || snapshot.onboardingStep === "language";
    return beforeHandoff || snapshot.status !== "onboarding"
      ? null
      : { kind: "narrate", beat: "intro" };
  }

  // The collector is asking for photos next.
  if (
    !spoken.has("photos") &&
    snapshot.onboardingStep === "conversational" &&
    snapshot.currentQuestion === "photos"
  ) {
    return { kind: "narrate", beat: "photos" };
  }

  // Profile is finished, liveness is not: the verification gate (§1.4) holds
  // them here, which is exactly when to say the check is theatre.
  if (
    !spoken.has("verification") &&
    snapshot.status === "onboarding" &&
    snapshot.onboardingStep === "completed" &&
    snapshot.verificationStatus !== "verified"
  ) {
    return { kind: "narrate", beat: "verification" };
  }

  return null;
}

function decideMatchAction(match: DemoMatchSnapshot): DemoDecision {
  const wait = (action: DemoAction, waitMs = DEMO_STEP_WAIT_MS): DemoDecision => ({
    action,
    waitMs,
  });
  const idle: DemoDecision = { action: { kind: "none" }, waitMs: 0 };

  switch (match.status) {
    case "proposed": {
      // Blind-decision invariant is untouched: the puppet answers only after
      // the visitor has committed, and always with a yes. A "no" from the
      // visitor terminates the row, which is handled by `awaitingContinueOffer`.
      if (match.visitorAccepted === true && match.partnerAccepted === null) {
        return wait({ kind: "partner_accept" });
      }
      return idle;
    }

    case "negotiating": {
      // The Date Ticket gate sits inside `negotiating` and the Calendar has not
      // opened yet — `proposedTimes` is the honest discriminator (§3.5c), since
      // `ticketStatus` defaults to `pending` even with tickets switched off.
      if (match.proposedTimes.length === 0) {
        if (match.ticketOpen && match.visitorTicketPaid && !match.partnerTicketPaid) {
          // Deliberately only after the visitor has paid: settling first would
          // pull the "pay for us both" gesture out from under them, and a
          // status on a step they owe is exactly what §3.6b forbids.
          return wait({ kind: "partner_pay_ticket" });
        }
        return idle;
      }

      if (match.visitorSlots.length === 0) return idle; // their move

      if (match.partnerSlots.length === 0) {
        const slots = pickCounterSlots(match.proposedTimes, match.visitorSlots);
        // Nothing left to counter with (the visitor marked everything): take
        // one of theirs instead of stalling.
        return slots.length > 0
          ? wait({ kind: "partner_counter_slots", slots })
          : wait({ kind: "partner_converge_slots", slots: match.visitorSlots.slice(0, 1) });
      }

      if (intersect(match.visitorSlots, match.partnerSlots).length === 0) {
        return wait(
          { kind: "partner_converge_slots", slots: match.visitorSlots.slice(0, 1) },
          DEMO_CONVERGE_WAIT_MS,
        );
      }
      return idle;
    }

    case "negotiating_venue": {
      if (match.visitorVenueConfirmed && !match.partnerVenueConfirmed) {
        return wait({ kind: "partner_venue" });
      }
      return idle;
    }

    case "scheduled": {
      // The venue-change board runs on top of a scheduled date, so it is
      // checked before the pre-date content — a visitor who opened the board is
      // mid-interaction and must not be interrupted by the lifecycle replay.
      const board = decideVenueChangeAction(match);
      if (board) return wait(board);

      if (match.icebreakersSentAt === null) {
        return wait({ kind: "run_predate" });
      }
      return idle;
    }

    default:
      return idle;
  }
}

function decideVenueChangeAction(match: DemoMatchSnapshot): DemoAction | null {
  if (match.venueChangeStatus === "liking") {
    if (match.visitorLikeKeys.length === 0) return null; // their move
    if (match.partnerLikeKeys.length === 0) {
      return { kind: "partner_counter_likes" };
    }
    if (intersect(match.visitorLikeKeys, match.partnerLikeKeys).length === 0) {
      return { kind: "partner_agree_likes" };
    }
    return null;
  }

  // Agreed but unpaid, and the payer matrix says it is the puppet's bill.
  if (match.venueChangeStatus === "agreed" && match.venueChangePayerIsPartner) {
    return { kind: "partner_settle_venue_change" };
  }

  return null;
}

/**
 * Up to three slots the visitor did NOT mark, spread across different days.
 *
 * Different days on purpose: the point of the counter-proposal is that it reads
 * like a person with their own calendar, and three alternatives on the
 * visitor's own chosen evening would read like noise. Returns an empty array
 * when the visitor left nothing to counter with, which the caller treats as
 * "give in immediately" rather than as an error.
 */
export function pickCounterSlots(
  proposedTimes: readonly string[],
  visitorSlots: readonly string[],
): string[] {
  const taken = new Set(visitorSlots);
  const visitorDays = new Set(visitorSlots.map(dayKey));
  const picked: string[] = [];
  const usedDays = new Set<string>();

  // First pass: days the visitor did not choose at all — the clearest signal
  // that the other person simply has a different week.
  for (const slot of proposedTimes) {
    if (picked.length >= 3) break;
    const day = dayKey(slot);
    if (taken.has(slot) || visitorDays.has(day) || usedDays.has(day)) continue;
    picked.push(slot);
    usedDays.add(day);
  }

  // Second pass: any free slot, so a visitor who marked something on every day
  // still gets a counter-proposal rather than silence.
  if (picked.length === 0) {
    for (const slot of proposedTimes) {
      if (picked.length >= 3) break;
      if (taken.has(slot)) continue;
      picked.push(slot);
    }
  }

  return picked;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((value) => set.has(value));
}
