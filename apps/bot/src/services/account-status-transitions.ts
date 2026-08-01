import type { Api, RawApi } from "grammy";
import { prisma, type Prisma, type UserStatus } from "@gennety/db";
import {
  claimInFlightMatchCancellations,
  deliverCancelledPartnerEffects,
  type CancelledPartner,
} from "./cancel-in-flight-matches.js";
import { FOUNDER_ACCOUNT_CLOSED_SELECT, notifyFounderAccountClosed } from "./founder-notify.js";
import { unpinStatusBanner } from "./status-banner.js";

export type AccountStatusAction = "pause" | "resume" | "return_from_freeze";

export type AccountStatusLocator = { id: string } | { telegramId: bigint };

interface TransitionedAccount {
  id: string;
  telegramId: bigint;
  status: UserStatus;
}

export type StatusTransitionResult =
  | {
      kind: "changed";
      previousStatus: UserStatus;
      status: UserStatus;
      user: TransitionedAccount;
    }
  | {
      kind: "already";
      status: UserStatus;
      user: TransitionedAccount;
    }
  | {
      kind: "forbidden";
      status: UserStatus;
      user: TransitionedAccount;
    }
  | { kind: "not_found" };

export type FreezeAccountResult = StatusTransitionResult & {
  cancelled?: readonly CancelledPartner[];
};

type TransitionDb = Pick<typeof prisma, "user">;

const ACTION_RULES: Record<
  AccountStatusAction,
  { from: UserStatus; to: UserStatus }
> = {
  pause: { from: "active", to: "paused" },
  resume: { from: "paused", to: "active" },
  return_from_freeze: { from: "frozen", to: "active" },
};

const STATUS_SELECT = {
  id: true,
  telegramId: true,
  status: true,
} satisfies Prisma.UserSelect;

function whereUnique(locator: AccountStatusLocator): Prisma.UserWhereUniqueInput {
  return "id" in locator
    ? { id: locator.id }
    : { telegramId: locator.telegramId };
}

function asAccount(user: TransitionedAccount): TransitionedAccount {
  return {
    id: user.id,
    telegramId: user.telegramId,
    status: user.status,
  };
}

function classifyTransition(
  user: TransitionedAccount,
  action: AccountStatusAction,
): Exclude<StatusTransitionResult, { kind: "changed" } | { kind: "not_found" }> {
  const rule = ACTION_RULES[action];
  if (user.status === rule.to) {
    return { kind: "already", status: user.status, user: asAccount(user) };
  }
  return { kind: "forbidden", status: user.status, user: asAccount(user) };
}

/**
 * Apply one user-owned matchmaking status transition using compare-and-set.
 * Moderation-owned statuses can never be overwritten, including when a
 * moderation write races the initial read.
 */
export async function transitionAccountStatus(
  locator: AccountStatusLocator,
  action: AccountStatusAction,
  db: TransitionDb = prisma,
): Promise<StatusTransitionResult> {
  const rule = ACTION_RULES[action];
  const user = await db.user.findUnique({
    where: whereUnique(locator),
    select: STATUS_SELECT,
  });
  if (!user) return { kind: "not_found" };
  if (user.status !== rule.from) return classifyTransition(user, action);

  const changed = await db.user.updateMany({
    where: { id: user.id, status: rule.from },
    data: { status: rule.to },
  });
  if (changed.count === 1) {
    if (action === "resume") {
      // D10: clear the system-pause marker on ANY resume, manual or
      // automatic. A user-initiated resume already had this at null (only
      // the pool-exhaustion sweep ever sets it), so this is a harmless no-op
      // for the common case — it only matters for a user who manually
      // resumes out of a system-driven pause, so the pool-exhaustion sweep's
      // periodic re-check doesn't act on a marker that no longer reflects
      // reality. Best-effort and off the injected `db` (profile isn't part
      // of `TransitionDb`'s narrow contract): a lagging clear is harmless,
      // the status transition above is what actually matters.
      await prisma.profile
        .updateMany({
          where: { userId: user.id, starvationPausedAt: { not: null } },
          data: { starvationPausedAt: null },
        })
        .catch((err) => {
          console.warn(
            `[account-status] starvationPausedAt clear failed for userId=${user.id}:`,
            (err as Error).message,
          );
        });
    }
    return {
      kind: "changed",
      previousStatus: user.status,
      status: rule.to,
      user: { ...asAccount(user), status: rule.to },
    };
  }

  // A concurrent write won after our read. Re-read and report its actual
  // state rather than turning a failed CAS into a blind update.
  const current = await db.user.findUnique({
    where: { id: user.id },
    select: STATUS_SELECT,
  });
  if (!current) return { kind: "not_found" };
  return classifyTransition(current, action);
}

function classifyFreeze(
  user: TransitionedAccount,
): Exclude<FreezeAccountResult, { kind: "changed" } | { kind: "not_found" }> {
  if (user.status === "frozen") {
    return { kind: "already", status: user.status, user: asAccount(user) };
  }
  return { kind: "forbidden", status: user.status, user: asAccount(user) };
}

/**
 * Atomically freeze an account and cancel all of its in-flight matches.
 * Partner compensation/notifications, founder analytics, and Telegram banner
 * cleanup happen only after the transaction commits successfully.
 */
export async function freezeAccount(
  locator: AccountStatusLocator,
  api: Api<RawApi> | null,
): Promise<FreezeAccountResult> {
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: whereUnique(locator),
      select: STATUS_SELECT,
    });
    if (!user) return { kind: "not_found" } as const;
    if (user.status !== "active" && user.status !== "paused") {
      return classifyFreeze(user);
    }

    const changed = await tx.user.updateMany({
      where: { id: user.id, status: user.status },
      data: { status: "frozen" },
    });
    if (changed.count === 0) {
      const current = await tx.user.findUnique({
        where: { id: user.id },
        select: STATUS_SELECT,
      });
      if (!current) return { kind: "not_found" } as const;
      return classifyFreeze(current);
    }

    const cancelled = await claimInFlightMatchCancellations(user.id, tx, {
      strict: true,
    });
    return {
      kind: "changed",
      previousStatus: user.status,
      status: "frozen",
      user: { ...asAccount(user), status: "frozen" },
      cancelled,
    } as const;
  });

  if (result.kind !== "changed") return result;

  await deliverCancelledPartnerEffects(result.cancelled, api);
  // Freeze keeps the row, so the founder-DM snapshot is a plain fresh read
  // (unlike delete, which must pre-fetch before the row is gone). The DB read
  // is awaited; only the best-effort Telegram send itself is fire-and-forget.
  const founderSnapshot = await prisma.user
    .findUnique({
      where: { id: result.user.id },
      select: FOUNDER_ACCOUNT_CLOSED_SELECT,
    })
    .catch(() => null);
  if (founderSnapshot) {
    void notifyFounderAccountClosed("frozen", founderSnapshot).catch(() => {});
  }
  if (api) {
    await unpinStatusBanner(api, result.user.telegramId).catch(() => {});
  }
  return result;
}
