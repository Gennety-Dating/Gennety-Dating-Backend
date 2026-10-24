import { prisma } from "@gennety/db";
import { MAX_HOBBIES, MAX_HOBBY_LENGTH } from "@gennety/shared";

/**
 * «＋ Интерес» in the iOS share sheet: one topic appended to `Profile.hobbies`.
 *
 * `PATCH /v1/me` replaces the whole array, which the share extension cannot do
 * safely — it does not hold the profile, and a stale copy would drop what the
 * person added elsewhere. So the merge happens here, server-side:
 * case-insensitive dedupe, append at the end, and a refusal (not a silent
 * truncation) at `MAX_HOBBIES` — the same rule as `applyChatProfilePatch`.
 */

export type AddShareInterestResult =
  | { ok: true; hobbies: string[]; added: boolean }
  | { ok: false; error: "bad-request" | "too-many" | "not-found" };

type ProfileStore = {
  profile: {
    findUnique(args: {
      where: { userId: string };
      select: { hobbies: true };
    }): Promise<{ hobbies: string[] } | null>;
    update(args: {
      where: { userId: string };
      data: { hobbies: string[]; embeddingDirty: boolean; embeddingDirtyAt: Date };
    }): Promise<unknown>;
  };
};

export function normaliseInterest(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.replace(/\s+/gu, " ").trim();
  if (!label || label.length > MAX_HOBBY_LENGTH) return null;
  return label;
}

export async function addShareInterest(
  userId: string,
  rawLabel: unknown,
  db: ProfileStore = prisma as unknown as ProfileStore,
): Promise<AddShareInterestResult> {
  const label = normaliseInterest(rawLabel);
  if (!label) return { ok: false, error: "bad-request" };

  const profile = await db.profile.findUnique({ where: { userId }, select: { hobbies: true } });
  if (!profile) return { ok: false, error: "not-found" };

  const hobbies = profile.hobbies;
  const key = label.toLocaleLowerCase();
  if (hobbies.some((hobby) => hobby.toLocaleLowerCase() === key)) {
    return { ok: true, hobbies, added: false };
  }
  if (hobbies.length >= MAX_HOBBIES) return { ok: false, error: "too-many" };

  const next = [...hobbies, label];
  await db.profile.update({
    where: { userId },
    // Hobbies feed the embedding (`me.ts` M-2): the worker recomputes it.
    data: { hobbies: next, embeddingDirty: true, embeddingDirtyAt: new Date() },
  });
  return { ok: true, hobbies: next, added: true };
}
