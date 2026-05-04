import { prisma } from "@gennety/db";

export type MatchEventActionType =
  | "PROPOSAL_SHOWN"
  | "ACCEPTED"
  | "DECLINED"
  | "DATE_COMPLETED"
  | "CHEMISTRY_POSITIVE"
  | "CHEMISTRY_NEGATIVE"
  | "EXPIRED_SILENT"
  | "EXPIRED_PEER_IGNORED";

interface MatchEventWriteClient {
  matchEvent: {
    create(args: {
      data: {
        matchId: string;
        actorId: string;
        targetId: string;
        actionType: MatchEventActionType;
        metadata?: Record<string, unknown>;
      };
    }): Promise<unknown>;
    updateMany(args: {
      where: {
        matchId: string;
        actorId: string;
        targetId: string;
        actionType: "DECLINED";
      };
      data: {
        metadata: Record<string, unknown>;
      };
    }): Promise<unknown>;
  };
}

const matchEventClient = prisma as typeof prisma & MatchEventWriteClient;

interface CreateMatchEventInput {
  matchId: string;
  actorId: string;
  targetId: string;
  actionType: MatchEventActionType;
  metadata?: Record<string, unknown>;
}

export async function createMatchEvent(input: CreateMatchEventInput): Promise<void> {
  await matchEventClient.matchEvent.create({
    data: {
      matchId: input.matchId,
      actorId: input.actorId,
      targetId: input.targetId,
      actionType: input.actionType,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });
}

interface AttachDeclineReasonInput {
  matchId: string;
  actorId: string;
  targetId: string;
  rejectionReason: string;
}

export async function attachDeclineReasonToMatchEvent(
  input: AttachDeclineReasonInput,
): Promise<void> {
  await matchEventClient.matchEvent.updateMany({
    where: {
      matchId: input.matchId,
      actorId: input.actorId,
      targetId: input.targetId,
      actionType: "DECLINED",
    },
    data: {
      metadata: {
        rejectionReason: input.rejectionReason,
      },
    },
  });
}
