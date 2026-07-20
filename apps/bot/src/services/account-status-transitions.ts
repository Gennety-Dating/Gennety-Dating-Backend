import type { Api, RawApi } from "grammy";
import { prisma, type Prisma, type UserStatus } from "@gennety/db";
import {
  claimInFlightMatchCancellations,
  deliverCancelledPartnerEffects,
  type CancelledPartner,
} from "./cancel-in-flight-matches.js";
import { notifyFounderAccountClosed } from "./founder-notify.js";
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
  void notifyFounderAccountClosed("frozen").catch(() => {});
  if (api) {
    await unpinStatusBanner(api, result.user.telegramId).catch(() => {});
  }
  return result;
}
