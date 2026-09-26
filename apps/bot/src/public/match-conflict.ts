import { prisma } from "@gennety/db";

/** A conflict may name the current status only to a participant. */
export async function currentMatchStatusForUser(
  matchId: string,
  userId: string,
): Promise<string | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { status: true, userAId: true, userBId: true },
  });
  if (!match || (match.userAId !== userId && match.userBId !== userId)) return null;
  return match.status;
}

export function staleActionBody(currentMatchStatus: string): {
  error: "stale_action";
  currentMatchStatus: string;
} {
  return { error: "stale_action", currentMatchStatus };
}
