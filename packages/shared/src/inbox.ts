/**
 * The in-app inbox, admin announcements, the Today "Live Pulse" rows and the
 * chat context they hand to the agent (decision journal 2026-09-13).
 *
 * Every limit and window the feature runs on lives here, so the admin route
 * that validates an announcement, the fan-out that sends it and the chat turn
 * that grounds on it all read one definition.
 */

/**
 * Push types that also land in the inbox (decision F5).
 *
 * The bell's dot has to mean "something arrived that you have not seen" — a
 * dot that lights only for a rare announcement is the badge spam the iOS
 * client refused on 2026-09-08. So the news a person is actually waiting on
 * counts, and three kinds of push deliberately do not:
 *
 *  - Messages with a surface of their own: `proxy.message` (the proxy chat has
 *    its own unread state), `date.bump` and `venue_intent` (both live on the
 *    date card that is already the whole of Today while they matter).
 *  - Reminders (`match-nudge.ts`): `match.nudge`, `match.planning` and
 *    `match.deadline` repeat news that is already in the inbox; a second
 *    unread row saying the same thing is the counter counting messages rather
 *    than news.
 *  - In-event rounds (`event.round`): several arrive during one evening and
 *    each is stale by the next — the inbox would fill with dead pairings.
 *
 * `announcement` is not here: the fan-out writes those rows itself, before it
 * pushes, so an app user without a push token still gets them.
 */
export const INBOX_PUSH_TYPES: ReadonlySet<string> = new Set([
  "match.proposed",
  "match.none",
  "match.both_accepted",
  "match.peer_decided",
  "match.outcome",
  "match.scheduled",
  "match.wingman",
  "match.cancelled",
  "safety.brief",
  "feedback.due",
  "verification.outcome",
  "event.recap",
  "event.mutual",
]);

export const ANNOUNCEMENT_PUSH_TYPE = "announcement";

/** Page size bounds for `GET /v1/inbox`. */
export const INBOX_PAGE_DEFAULT = 30;
export const INBOX_PAGE_MAX = 100;
/** How many ids one `POST /v1/inbox/read` may carry. */
export const INBOX_READ_BATCH_MAX = 200;
/** Inbox rows are swept after this long by the retention worker. */
export const INBOX_RETENTION_DAYS = 90;

/** Character limits the admin route enforces on an announcement. */
export const ANNOUNCEMENT_LIMITS = {
  title: 80,
  teaser: 140,
  body: 2000,
  agentBrief: 1500,
  suggestedQuestions: 3,
  suggestedQuestion: 80,
} as const;

/** Media an announcement may carry. Video is short and silent by design (F3). */
export const ANNOUNCEMENT_MEDIA = {
  imageMaxBytes: 2 * 1024 * 1024,
  videoMaxBytes: 8 * 1024 * 1024,
  videoMaxSeconds: 10,
  /** Signed URL lifetime handed to the app. */
  signedUrlTtlSeconds: 24 * 60 * 60,
} as const;

export const ANNOUNCEMENT_STATUSES = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "archived",
] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

/**
 * Pacing of the announcement push fan-out: one push every 100 ms, the ~10/s
 * the 2026-09-07 "no pairs today" decision set for whole-base sends. Inbox rows
 * are written in batches up front; only the pushes are paced.
 */
export const ANNOUNCEMENT_PUSH_INTERVAL_MS = 100;
export const ANNOUNCEMENT_INBOX_BATCH = 500;

/**
 * How long a context-bearing chat message keeps grounding the agent. The same
 * silence that cuts a chat topic (`services/chat-topics.ts`): past it, the
 * person has moved on and the old announcement would only mislead the model.
 */
export const CHAT_CONTEXT_WINDOW_HOURS = 6;

export const CHAT_CONTEXT_KINDS = ["inbox_item"] as const;
export type ChatContextKind = (typeof CHAT_CONTEXT_KINDS)[number];

/**
 * Live Pulse row kinds (decision F2/F7). Strings on the wire, for the same
 * reason inbox types are: an older app build must skip a kind it does not
 * know, not fail the whole response.
 */
export const PULSE_ROW_KINDS = [
  "drop_batch",
  "venue_search",
  "event_application",
  "announcement",
  "date_past",
  "chat_topic",
] as const;
export type PulseRowKind = (typeof PULSE_ROW_KINDS)[number];

/** `processing` spins, `active` holds a still dot, `past` is muted (F2). */
export type PulseRowState = "processing" | "active" | "past";

/** Most rows the server returns; the client shows at most three. */
export const PULSE_ROWS_MAX = 6;

/**
 * The drop batch is "processing" for this long after its instant, and only
 * until the person's outcome exists (a match, or the no-match notice that
 * fires ~15 minutes after the batch). A bounded window is the whole point of
 * F2: past it, nothing is running and nothing may spin.
 */
export const PULSE_DROP_WINDOW_MINUTES = 20;
/** A completed date stays as a past row this long. */
export const PULSE_DATE_PAST_DAYS = 14;
/** How many recent chat topics may appear as past rows. */
export const PULSE_CHAT_TOPICS_MAX = 2;
/** Read announcements older than this drop off the pulse (the inbox keeps them). */
export const PULSE_ANNOUNCEMENT_DAYS = 7;
