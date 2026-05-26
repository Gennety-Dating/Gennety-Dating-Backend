import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import { t, type Language } from "@gennety/shared";
import {
  pullVerificationStatus,
  type PullVerificationOutcome,
} from "./verification-pipeline.js";
import { VERIFY_CHECK_CALLBACK } from "../handlers/onboarding/verification.js";

/**
 * In-process poller that auto-checks Persona verification after the user
 * returns to the bot via the `?start=verify_done` deep-link redirect.
 *
 * Why in-memory:
 * - Poll is short (5 min ceiling) and the data is recoverable: the user
 *   can always tap the manual "✅ I'm done" button.
 * - A bot restart loses in-flight polls, but the safety-net button keeps
 *   the user's case resolvable. No DB schema cost for what is purely a
 *   convenience-poll.
 *
 * Concurrency: a second `startPoll(userId)` while one is already running
 * cancels the first interval — there's always at most one poll per user.
 */

export const POLL_INTERVAL_MS = 10_000;
export const MAX_ATTEMPTS = 30;

interface PollState {
  intervalId: ReturnType<typeof setInterval>;
  attemptsLeft: number;
}

const polls = new Map<string, PollState>();

export interface PollerDeps {
  pull: (userId: string, api: Api<RawApi>) => Promise<PullVerificationOutcome>;
  setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn: (id: ReturnType<typeof setInterval>) => void;
}

const defaultDeps: PollerDeps = {
  pull: pullVerificationStatus,
  setIntervalFn: setInterval,
  clearIntervalFn: clearInterval,
};

/**
 * Begin polling Persona for `userId`. Idempotent: if a poll is already in
 * flight for this user, the existing interval is cleared and replaced.
 *
 * Side-effects on outcome:
 *   - `pipeline_ran` / `already_done` → stop. Pipeline already DM'd the user.
 *   - `still_pending` / `no_inquiry`  → keep polling until attempts run out.
 *   - `persona_failed`                → stop + DM retry instructions.
 *   - `infra_error`                   → stop + DM transient-error message.
 *   - attempts exhausted              → stop + DM timeout with safety-net button.
 */
export function startPoll(
  userId: string,
  telegramId: bigint,
  language: Language,
  api: Api<RawApi>,
  deps: PollerDeps = defaultDeps,
): void {
  stopPoll(userId, deps);

  const state: PollState = {
    attemptsLeft: MAX_ATTEMPTS,
    intervalId: deps.setIntervalFn(() => {
      void tick(userId, telegramId, language, api, deps);
    }, POLL_INTERVAL_MS),
  };
  polls.set(userId, state);
}

export function stopPoll(userId: string, deps: PollerDeps = defaultDeps): void {
  const state = polls.get(userId);
  if (!state) return;
  deps.clearIntervalFn(state.intervalId);
  polls.delete(userId);
}

export function isPolling(userId: string): boolean {
  return polls.has(userId);
}

async function tick(
  userId: string,
  telegramId: bigint,
  language: Language,
  api: Api<RawApi>,
  deps: PollerDeps,
): Promise<void> {
  const state = polls.get(userId);
  if (!state) return;

  state.attemptsLeft -= 1;

  let outcome: PullVerificationOutcome;
  try {
    outcome = await deps.pull(userId, api);
  } catch (err) {
    console.error("[verification-poller] pull threw", { userId, err });
    // Treat unexpected throws as a transient infra error — surface the
    // standard infra-error DM and stop, the user can retry via the manual
    // button.
    stopPoll(userId, deps);
    await safeSend(api, telegramId, t(language, "verifyAutoPollInfraError"));
    return;
  }

  switch (outcome.kind) {
    case "pipeline_ran":
    case "already_done":
      // Pipeline (or earlier webhook) already DM'd the user — stay silent.
      stopPoll(userId, deps);
      return;

    case "no_inquiry":
    case "still_pending":
      if (state.attemptsLeft <= 0) {
        stopPoll(userId, deps);
        const keyboard = new InlineKeyboard().text(
          t(language, "verifyBtnCheck"),
          VERIFY_CHECK_CALLBACK,
        );
        await safeSend(api, telegramId, t(language, "verifyAutoPollTimeout"), keyboard);
      }
      return;

    case "persona_failed":
      stopPoll(userId, deps);
      await safeSend(api, telegramId, t(language, "verifyAutoPollPersonaFailed"));
      return;

    case "infra_error":
      stopPoll(userId, deps);
      await safeSend(api, telegramId, t(language, "verifyAutoPollInfraError"));
      return;
  }
}

async function safeSend(
  api: Api<RawApi>,
  telegramId: bigint,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  if (telegramId <= 0n) return; // mobile-only user — nothing to DM
  try {
    if (keyboard) {
      await api.sendMessage(Number(telegramId), text, { reply_markup: keyboard });
    } else {
      await api.sendMessage(Number(telegramId), text);
    }
  } catch (err) {
    console.warn("[verification-poller] DM failed", {
      telegramId: String(telegramId),
      err,
    });
  }
}
