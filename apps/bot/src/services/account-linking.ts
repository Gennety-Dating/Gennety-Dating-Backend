import { prisma, type Prisma } from "@gennety/db";

/**
 * Cross-rail account linking — "вход по номеру" (PRODUCT_SPEC §1.1).
 *
 * Registration v2 carries TWO identities for one human: the Telegram rail keys
 * on `telegramId`, the native-app phone rail keys on the `@unique` `User.phone`
 * (creating a row with a synthetic NEGATIVE `telegramId` when the number is new
 * — see `public/mobile-user.ts`). Without linking, someone who verified their
 * number on iOS and then opened the bot could never share their contact again:
 * the write hit P2002 and the flow dead-ended on "this number belongs to
 * another account". The same wall stood in front of anyone who re-created their
 * Telegram account with the same number.
 *
 * A trusted `message.contact` is Telegram vouching that the number belongs to
 * the CURRENT Telegram account, and Telegram allows one active account per
 * number. So the row already holding that number belongs to the same human, and
 * the correct product answer is to log them in rather than refuse. Founder
 * decision (2026-07-25): adopt in every such case, including a previous real
 * (positive) `telegramId`. Accepted tradeoff: a carrier-recycled number hands
 * the new holder the previous profile — the phone rail already makes exactly
 * this trade (`findOrCreateMobileUserByPhone` logs anyone holding the number
 * into the row), so refusing only on the Telegram side would be inconsistent
 * and would strand real users.
 *
 * The ONE thing that can never be automated is a collision where BOTH rows
 * carry real data — that is a merge of two populated accounts, and it goes to
 * support instead.
 */

/** Columns the classifier needs to judge whether a row is disposable. */
export const ACCOUNT_LINK_SELECT = {
  id: true,
  telegramId: true,
  telegramUsername: true,
  platform: true,
  phone: true,
  phoneVerifiedAt: true,
  registrationTrack: true,
  referralSource: true,
  onboardingStep: true,
  status: true,
  language: true,
  isEmailVerified: true,
  ticketBalance: true,
  premiumUntil: true,
  promoRedeemedAt: true,
  profile: { select: { photos: true } },
  _count: { select: { matchesAsA: true, matchesAsB: true } },
} satisfies Prisma.UserSelect;

export type AccountLinkUser = Prisma.UserGetPayload<{
  select: typeof ACCOUNT_LINK_SELECT;
}>;

export type PhoneConflictDecision =
  /** The number already belongs to this very row — nothing to resolve. */
  | { kind: "same" }
  /** The current row is disposable: hand its Telegram identity to the owner. */
  | { kind: "adopt"; ownerId: string; stubId: string }
  /** Both rows carry real data — a human has to merge them. */
  | { kind: "manual-merge" };

/**
 * True when a row holds something a user would lose if we deleted it. Kept
 * deliberately strict: anything that took real effort (a finished onboarding,
 * photos, a match, paid balance, an entitlement, a redeemed promo, a verified
 * email) makes the row non-disposable, so the ambiguous cases go to support
 * rather than getting silently destroyed.
 */
export function hasRealAccountData(user: AccountLinkUser): boolean {
  return (
    user.onboardingStep === "completed" ||
    user.status !== "onboarding" ||
    user.isEmailVerified ||
    (user.profile?.photos.length ?? 0) > 0 ||
    user._count.matchesAsA + user._count.matchesAsB > 0 ||
    user.ticketBalance > 0 ||
    user.premiumUntil != null ||
    user.promoRedeemedAt != null
  );
}

/**
 * Decide what a phone-uniqueness collision means. Pure — every DB read happens
 * in the caller, so the whole policy is unit-testable.
 *
 * @param current the row for the Telegram account that just shared its contact
 * @param owner   the row that already holds the number
 */
export function classifyPhoneConflict(
  current: AccountLinkUser,
  owner: AccountLinkUser,
): PhoneConflictDecision {
  if (current.id === owner.id) return { kind: "same" };
  if (hasRealAccountData(current)) return { kind: "manual-merge" };
  return { kind: "adopt", ownerId: owner.id, stubId: current.id };
}

export type AdoptionResult =
  | { kind: "adopted"; user: AccountLinkUser }
  /** State moved under us between the classification and the transaction. */
  | { kind: "stale" };

/**
 * Move a Telegram identity onto the account that already owns the phone number,
 * then delete the empty row it came from.
 *
 * Ordering is load-bearing: `telegramId` is `@unique`, so the disposable row
 * must be deleted BEFORE the owner can take its id. Everything runs in one
 * transaction and re-reads both rows inside it, so a concurrent write (a
 * parallel `/start`, a mobile login) makes the adoption bail out as `stale`
 * instead of corrupting either account.
 */
export async function adoptAccountByPhone(params: {
  ownerId: string;
  stubId: string;
  telegramId: bigint;
  /** The E.164 number Telegram just vouched for — re-checked inside the tx. */
  phone: string;
  telegramUsername?: string | null;
}): Promise<AdoptionResult> {
  const { ownerId, stubId, telegramId, phone, telegramUsername } = params;

  const result = await prisma.$transaction(async (tx) => {
    const [owner, stub] = await Promise.all([
      tx.user.findUnique({ where: { id: ownerId }, select: ACCOUNT_LINK_SELECT }),
      tx.user.findUnique({ where: { id: stubId }, select: ACCOUNT_LINK_SELECT }),
    ]);

    // Re-validate the exact invariants the decision was made on.
    if (!owner || !stub) return { kind: "stale" as const };
    if (stub.telegramId !== telegramId) return { kind: "stale" as const };
    // The stub never carries the number (that write is exactly what failed with
    // P2002), so the ownership check compares the owner against the number
    // Telegram vouched for.
    if (owner.phone !== phone) return { kind: "stale" as const };
    if (hasRealAccountData(stub)) return { kind: "stale" as const };

    await tx.user.delete({ where: { id: stub.id } });

    const user = await tx.user.update({
      where: { id: owner.id },
      data: {
        telegramId,
        ...(telegramUsername ? { telegramUsername } : {}),
        // A phone-rail row now reachable on Telegram serves both surfaces.
        ...(owner.platform === "mobile" ? { platform: "both" as const } : {}),
        // The pinned status banner id points at a message in the OLD chat.
        // Left in place, the status-timer worker would edit an unrelated
        // message id in the new chat; the banner re-pins itself on the next
        // activation instead.
        statusMessageId: null,
        // Keep the fresh touch's attribution when the owner has none, so a
        // promo/referral deep link isn't lost with the deleted row.
        ...(owner.referralSource == null && stub.referralSource != null
          ? { referralSource: stub.referralSource }
          : {}),
        ...(owner.registrationTrack ? {} : { registrationTrack: "general" }),
        ...(owner.phoneVerifiedAt ? {} : { phoneVerifiedAt: new Date() }),
      },
      select: ACCOUNT_LINK_SELECT,
    });

    return { kind: "adopted" as const, user };
  });

  if (result.kind === "adopted") {
    console.info(
      `[account-linking] adopted account ${ownerId} onto telegramId ${telegramId} ` +
        `(deleted empty row ${stubId})`,
    );
  }

  return result;
}
