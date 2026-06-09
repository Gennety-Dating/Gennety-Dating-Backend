import { prisma } from "@gennety/db";

export type MatchDecisionSide = "A" | "B";

interface ClaimMatchDecisionInput {
  matchId: string;
  side: MatchDecisionSide;
  decision: boolean;
}

interface MatchDecisionClaimDeps {
  updateMany: typeof prisma.match.updateMany;
  findUnique: typeof prisma.match.findUnique;
}

export type MatchDecisionClaimResult =
  | { claimed: false }
  | {
      claimed: true;
      status: string;
      acceptedByA: boolean | null;
      acceptedByB: boolean | null;
    };

const defaultDeps: MatchDecisionClaimDeps = {
  updateMany: prisma.match.updateMany.bind(prisma.match),
  findUnique: prisma.match.findUnique.bind(prisma.match),
};

/**
 * Atomically claim one participant's previously-null verdict.
 *
 * The conditional update is the finality boundary: concurrent taps from the
 * same side cannot overwrite the first answer. The fresh read lets the caller
 * derive the next match state from decisions committed by both participants,
 * rather than from a stale pre-click snapshot.
 */
export async function claimMatchDecision(
  input: ClaimMatchDecisionInput,
  deps: MatchDecisionClaimDeps = defaultDeps,
): Promise<MatchDecisionClaimResult> {
  const ownField = input.side === "A" ? "acceptedByA" : "acceptedByB";
  const claimed = await deps.updateMany({
    where: {
      id: input.matchId,
      status: "proposed",
      [ownField]: null,
    },
    data: {
      [ownField]: input.decision,
    },
  });
  if (claimed.count === 0) return { claimed: false };

  const match = await deps.findUnique({
    where: { id: input.matchId },
    select: {
      status: true,
      acceptedByA: true,
      acceptedByB: true,
    },
  });
  if (!match) return { claimed: false };

  return {
    claimed: true,
    status: match.status,
    acceptedByA: match.acceptedByA,
    acceptedByB: match.acceptedByB,
  };
}
