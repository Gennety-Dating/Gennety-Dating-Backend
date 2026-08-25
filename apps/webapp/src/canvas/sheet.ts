/**
 * The Living Canvas sheet — what one state looks like (PRODUCT_SPEC §6.1).
 *
 * Pure: state in, a descriptor out. The DOM half renders whatever this
 * returns and decides nothing, so every rule about what a state may say — and
 * in particular what it may NOT say — is testable without a browser, a map or
 * a network.
 *
 * ── The rule the whole file exists to hold ──────────────────────────────
 *
 * **`DROP_PENDING_DECISION` may never carry anything about the partner's own
 * answer**, because at that moment the product does not know it and the user
 * has not earned it (§3.4, the blind-decision invariant). The server already
 * enforces this — `deriveDateState` reads only the caller's own column and
 * `/v1/date/state` never selects the peer's — but a client that invented a
 * hint would reopen it on the one screen the user stares at while deciding.
 * The descriptor for that state therefore carries no partner field at all,
 * rather than an empty one: absent is not something a later edit can fill in
 * by accident.
 */

import type { CanvasStrings, Lang } from "./i18n.js";
import { stringsFor } from "./i18n.js";

export const CANVAS_STATES = [
  "IDLE_EXPLORING",
  "DROP_PENDING_DECISION",
  "LOGISTICS_SCHEDULING",
  "DATE_SCHEDULED",
  "DATE_RADAR_ACTIVE",
  "DATE_BUMP_PENDING",
  "DATE_IN_PROGRESS",
  "POST_DATE_FEEDBACK",
] as const;

export type CanvasState = (typeof CANVAS_STATES)[number];

export function isCanvasState(value: unknown): value is CanvasState {
  return (
    typeof value === "string" && (CANVAS_STATES as readonly string[]).includes(value)
  );
}

/** What the partner's phone last said. `viewOfPeer`'s vocabulary, verbatim. */
export type PeerStatus = "unknown" | "en_route" | "arrived";

export interface RadarReading {
  peer: PeerStatus;
  /** `HH:mm` in the pair's own city. Present only while they are en route. */
  peerEtaLocal?: string;
  bothArrived: boolean;
}

export interface CanvasInput {
  state: CanvasState;
  lang: Lang;
  /** Server clock, so a wrong device clock cannot invent a countdown. */
  serverNow: Date;
  nextDropAt?: Date | null;
  agreedTime?: Date | null;
  venueName?: string | null;
  /** This side's own shake. The peer's is deliberately not knowable here. */
  bumpMine?: boolean;
  bumpVerified?: boolean;
  deck?: string[];
  radar?: RadarReading | null;
}

/**
 * What the sheet does when tapped. `chat` closes the Mini App, which is the
 * honest action for every state whose real flow lives in the bot: the canvas
 * is a map and a status surface in v1, not a second place to accept a pitch.
 * `shake` is the one action the canvas genuinely owns.
 */
export type SheetAction = "chat" | "shake" | null;

export interface SheetView {
  title: string;
  body: string;
  /** Extra line under the body — the radar's one sentence about the partner. */
  note?: string;
  /** Talking points, only ever on `DATE_IN_PROGRESS`. */
  list?: string[];
  action: SheetAction;
  actionLabel?: string;
  /** Drives the accent: the two states worth celebrating read warm. */
  tone: "quiet" | "urgent" | "warm";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A coarse countdown, in the pair's own language.
 *
 * Deliberately the same shape the pinned banner uses (§2.1): days+hours, then
 * hours+minutes, then minutes — so the two surfaces a user can see at once
 * never disagree about the same date by a rounding step. Rounds UP for the
 * same reason the radar's ETA does: "in 2h" that turns out to be 2h05 is a
 * lie, "in 3h" that turns out to be 2h55 is not.
 */
export function formatCountdown(ms: number, s: CanvasStrings): string {
  if (ms <= 0) return s.soon;
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY);
    const hours = Math.ceil((ms - days * DAY) / HOUR);
    // 23h59m left of the hours bucket rounds to a whole extra day rather than
    // rendering "1d 24h".
    if (hours >= 24) return s.days.replace("{n}", String(days + 1));
    return hours > 0
      ? `${s.days.replace("{n}", String(days))} ${s.hours.replace("{n}", String(hours))}`
      : s.days.replace("{n}", String(days));
  }
  if (ms >= HOUR) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.ceil((ms - hours * HOUR) / MINUTE);
    if (minutes >= 60) return s.hours.replace("{n}", String(hours + 1));
    return minutes > 0
      ? `${s.hours.replace("{n}", String(hours))} ${s.minutes.replace("{n}", String(minutes))}`
      : s.hours.replace("{n}", String(hours));
  }
  return s.minutes.replace("{n}", String(Math.max(1, Math.ceil(ms / MINUTE))));
}

function radarNote(reading: RadarReading | null | undefined, s: CanvasStrings): string {
  if (!reading) return s.radarPeerUnknown;
  if (reading.bothArrived) return s.radarBothArrived;
  if (reading.peer === "arrived") return s.radarPeerArrived;
  if (reading.peer === "en_route") {
    return reading.peerEtaLocal
      ? s.radarPeerEnRoute.replace("{eta}", reading.peerEtaLocal)
      : s.radarPeerUnknown;
  }
  return s.radarPeerUnknown;
}

export function sheetFor(input: CanvasInput): SheetView {
  const s = stringsFor(input.lang);
  const until = (at: Date | null | undefined): string | null =>
    at ? formatCountdown(at.getTime() - input.serverNow.getTime(), s) : null;

  switch (input.state) {
    case "DROP_PENDING_DECISION": {
      const left = until(input.agreedTime);
      return {
        title: s.decisionTitle,
        // `agreedTime` is null on a `proposed` match, so the deadline is not
        // knowable here and the sentence drops its clause rather than
        // rendering a placeholder. It is never replaced by anything about the
        // partner — see this file's header.
        body: left ? s.decisionBody.replace("{time}", left) : s.planningBody,
        action: "chat",
        actionLabel: s.openChat,
        tone: "urgent",
      };
    }

    case "LOGISTICS_SCHEDULING":
      return {
        title: s.planningTitle,
        body: s.planningBody,
        action: "chat",
        actionLabel: s.openChat,
        tone: "quiet",
      };

    case "DATE_SCHEDULED": {
      const left = until(input.agreedTime) ?? s.soon;
      return {
        title: s.scheduledTitle.replace("{time}", left),
        body: input.venueName ?? s.planningBody,
        action: "chat",
        actionLabel: s.openChat,
        tone: "quiet",
      };
    }

    case "DATE_RADAR_ACTIVE":
      return {
        title: s.radarTitle,
        body: input.venueName ?? s.planningBody,
        note: radarNote(input.radar, s),
        action: null,
        tone: input.radar?.bothArrived ? "warm" : "quiet",
      };

    case "DATE_BUMP_PENDING":
      return {
        title: s.bumpTitle,
        // Once this side has shaken there is nothing left to do but wait, so
        // the action goes away rather than sitting there re-armable — a second
        // shake from the same phone can never verify a pair (the server reads
        // the PEER's column), and offering it would say otherwise.
        body: input.bumpMine ? s.bumpWaiting : s.bumpBody,
        action: input.bumpMine ? null : "shake",
        ...(input.bumpMine ? {} : { actionLabel: s.bumpAction }),
        tone: "urgent",
      };

    case "DATE_IN_PROGRESS":
      return {
        title: s.inProgressTitle,
        body: s.inProgressBody,
        ...(input.deck && input.deck.length > 0 ? { list: input.deck } : {}),
        action: null,
        tone: "warm",
      };

    case "POST_DATE_FEEDBACK":
      return {
        title: s.feedbackTitle,
        body: s.feedbackBody,
        action: "chat",
        actionLabel: s.openChat,
        tone: "quiet",
      };

    case "IDLE_EXPLORING":
    default: {
      const left = until(input.nextDropAt);
      return {
        title: s.idleTitle,
        // No `nextDropAt` is not an error state — under a cadence where drops
        // outpace the notices explaining them the product deliberately shows
        // a steady search rather than a timer counting down into silence
        // (§2.1 mode 5). The canvas follows the banner rather than inventing
        // a countdown of its own.
        body: left ? s.idleBody.replace("{time}", left) : s.idleNoDrop,
        action: null,
        tone: "quiet",
      };
    }
  }
}
