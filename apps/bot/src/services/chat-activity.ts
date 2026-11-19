import { BoundedMap } from "../utils/bounded-map.js";

/**
 * What the chat agent is doing right now, for the one-line status in the app
 * (decision journal 2026-11-01). `POST /v1/chat/message` blocks until the reply,
 * so the phone polls `GET /v1/chat/activity` beside it.
 *
 * Steps are machine keys, not copy: the client localizes them. Nothing of the
 * conversation is stored here, only the key and a counter.
 *
 * In process memory: production is one PM2 process in fork mode, the same
 * assumption `SendDedupe` already makes. A restart loses the status of a turn
 * the restart has killed anyway.
 */
export const CHAT_ACTIVITY_STEPS = [
  "thinking",
  "reading_photo",
  // A TikTok / Reels / YouTube link in this turn's message, read before the
  // first model call (`videoTakeBlocks`), not by a tool. Decision 2026-11-19.
  "watching_video",
  "web",
  "screenshots",
  "wishlist",
  "past_chats",
  // Reading the person's memory: saved ideas and preferences. Decision 2026-11-19.
  "remembering",
  "profile",
  "date",
  "matching",
  "writing",
] as const;

export type ChatActivityStep = (typeof CHAT_ACTIVITY_STEPS)[number];

/**
 * Every tool the chat agent can be given. `chat-activity.test.ts` compares this
 * with the real tool list, so a new tool fails the test until it is placed here.
 *
 * A `Map`, not an object: the name comes from the model, and `constructor` must
 * land on the fallback rather than on `Object.prototype`.
 *
 * The ones on `thinking` do no work worth naming: they answer at once.
 */
export const CHAT_TOOL_STEPS: ReadonlyMap<string, ChatActivityStep> = new Map<string, ChatActivityStep>([
  // The profile and the person's own settings.
  ["get_my_profile", "profile"],
  ["update_profile", "profile"],
  ["update_bio", "profile"],
  ["update_major", "profile"],
  ["update_age_range", "profile"],
  ["update_partner_preferences", "profile"],
  ["update_hobbies", "profile"],
  ["set_language", "profile"],
  ["set_theme", "profile"],
  ["attach_profile_photo", "profile"],
  ["review_my_photos", "profile"],
  ["offer_change", "profile"],
  ["propose_close_account", "profile"],
  // The search itself: why they are or are not being matched, pausing it.
  ["get_my_standing", "matching"],
  ["pause_matching", "matching"],
  ["resume_matching", "matching"],
  // The match, the date, the venue.
  ["explain_my_match", "date"],
  ["get_my_date", "date"],
  ["propose_venue_change", "date"],
  ["propose_cancel_date", "date"],
  ["record_date_feedback", "date"],
  ["record_rejection_feedback", "date"],
  ["propose_report_partner", "date"],
  // The wishlist. A card's web look-up reports `web` from inside the tool.
  ["get_my_wishlist", "wishlist"],
  ["remove_wishlist_item", "wishlist"],
  ["propose_wishlist_items", "wishlist"],
  // Earlier chats — «Ищу в истории диалогов…».
  ["search_past_chats", "past_chats"],
  ["read_past_chat", "past_chats"],
  // Memory reads (`chat-memory.ts`): saved ideas, preferences, places like the
  // saved ones — «Вспоминаю…». Its writes answer at once and stay on `thinking`,
  // as does skipping a question, which reads nothing.
  ["find_ideas", "remembering"],
  ["idea_questions", "remembering"],
  ["planning_ideas", "remembering"],
  ["idea_deletion_scope", "remembering"],
  ["list_preferences", "remembering"],
  ["similar_places", "remembering"],
  ["skip_idea_question", "thinking"],
  ["set_idea_reminder", "thinking"],
  ["save_idea", "thinking"],
  ["update_idea", "thinking"],
  ["grant_idea_use", "thinking"],
  ["revoke_idea_use", "thinking"],
  ["delete_idea", "thinking"],
  ["confirm_preference", "thinking"],
  ["use_style_reference", "thinking"],
  ["record_impression", "thinking"],
  ["grant_preference_matching", "thinking"],
  ["revoke_preference", "thinking"],
  // Long-term memory (decision 2026-11-19): recalling is «Вспоминаю…»; the
  // other three answer at once.
  ["recall", "remembering"],
  ["remember", "thinking"],
  ["update_memory", "thinking"],
  ["forget_memory", "thinking"],
  // The screenshot library.
  ["search_screenshots", "screenshots"],
  ["read_screenshot", "screenshots"],
  ["show_screenshots", "screenshots"],
  ["view_screenshot", "screenshots"],
  ["check_event", "web"],
  // Nothing to report.
  ["open_screen", "thinking"],
  // Reads the curated video list — answers at once (`agent-video-takes.ts`).
  ["suggest_video", "thinking"],
  ["show_app_guide", "thinking"],
  ["offer_cancel_premium", "thinking"],
]);

/** The step of a tool call; a name nobody declared is `thinking`. */
export function stepForTool(name: string): ChatActivityStep {
  return CHAT_TOOL_STEPS.get(name) ?? "thinking";
}

export interface ChatActivityView {
  step: ChatActivityStep | null;
  seq: number;
}

/** One turn's handle: it reports steps, then finishes. */
export interface ChatActivityTracker {
  report(step: ChatActivityStep): void;
  finish(): void;
}

interface Entry {
  step: ChatActivityStep;
  seq: number;
  expiresAt: number;
}

const NOTHING: ChatActivityView = { step: null, seq: 0 };

function keyOf(userId: string, clientMessageId: string): string {
  return `${userId}\u0000${clientMessageId}`;
}

/**
 * Steps of turns in flight, keyed by person + `clientMessageId`, so an id is
 * readable only by whoever sent it. The expiry is a backstop: `finish` is what
 * normally ends an entry, and the bound protects against a client minting ids.
 */
export class ChatActivityStore {
  private readonly entries: BoundedMap<string, Entry>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 2 * 60 * 1000;
    this.entries = new BoundedMap(options.maxEntries ?? 5_000);
    this.now = options.now ?? Date.now;
  }

  /**
   * Start a turn on `thinking`. The counter lives in the handle, so an entry
   * lost to the bound or the expiry comes back without `seq` going backwards.
   */
  begin(userId: string, clientMessageId: string): ChatActivityTracker {
    const key = keyOf(userId, clientMessageId);
    let current: Entry | null = null;
    let seq = 0;
    let finished = false;

    const report = (step: ChatActivityStep): void => {
      if (finished) return;
      if (current?.step !== step) seq += 1;
      current = { step, seq, expiresAt: this.now() + this.ttlMs };
      this.entries.set(key, current);
    };
    report("thinking");

    return {
      report,
      finish: () => {
        finished = true;
        // A newer turn under the same id owns the key now; leave it alone.
        if (this.entries.get(key) === current) this.entries.delete(key);
      },
    };
  }

  read(userId: string, clientMessageId: string | null): ChatActivityView {
    if (!clientMessageId) return NOTHING;
    const key = keyOf(userId, clientMessageId);
    const entry = this.entries.get(key);
    if (!entry) return NOTHING;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return NOTHING;
    }
    return { step: entry.step, seq: entry.seq };
  }

  /** Tests only. */
  clear(): void {
    this.entries.clear();
  }
}

export const chatActivity = new ChatActivityStore();
