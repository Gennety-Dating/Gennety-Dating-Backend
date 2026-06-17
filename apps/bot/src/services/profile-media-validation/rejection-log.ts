import { prisma } from "@gennety/db";
import type { MediaValidationReason } from "./types.js";

export type MediaValidationMediaType = "photo" | "video";

interface MediaValidationRejectionLogInput {
  userId: string;
  mediaType: MediaValidationMediaType;
  reason: MediaValidationReason;
  timestamp?: Date;
}

type RejectionDelegate = {
  create: (args: {
    data: {
      userId: string;
      mediaType: string;
      rejectionReason: string;
      createdAt: Date;
    };
  }) => Promise<unknown>;
};

export async function logMediaValidationRejection(
  input: MediaValidationRejectionLogInput,
): Promise<void> {
  const timestamp = input.timestamp ?? new Date();
  console.warn("[media-validation] rejected", {
    user_id: input.userId,
    media_type: input.mediaType,
    rejection_reason: input.reason,
    timestamp: timestamp.toISOString(),
  });

  const delegate = (prisma as unknown as {
    mediaValidationRejection?: RejectionDelegate;
  }).mediaValidationRejection;
  if (!delegate) return;

  try {
    await delegate.create({
      data: {
        userId: input.userId,
        mediaType: input.mediaType,
        rejectionReason: input.reason,
        createdAt: timestamp,
      },
    });
  } catch (err) {
    console.warn("[media-validation] rejection log write failed", {
      user_id: input.userId,
      media_type: input.mediaType,
      rejection_reason: input.reason,
      err,
    });
  }
}
