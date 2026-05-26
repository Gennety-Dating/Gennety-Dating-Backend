import { Prisma } from "@gennety/db";
import type { ProfileMedia } from "@gennety/shared";

export function profileMediaToJson(
  media: readonly ProfileMedia[],
): Prisma.InputJsonValue[] {
  return media.map((item): Prisma.InputJsonObject => {
    if (item.type === "photo") {
      return { type: "photo", photo: item.photo };
    }

    return {
      type: "live_photo",
      photo: item.photo,
      livePhoto: item.livePhoto,
      ...(item.duration !== undefined ? { duration: item.duration } : {}),
      ...(item.width !== undefined ? { width: item.width } : {}),
      ...(item.height !== undefined ? { height: item.height } : {}),
      ...(item.fileSize !== undefined ? { fileSize: item.fileSize } : {}),
      ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
    };
  });
}
