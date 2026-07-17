import { fetchInquirySelfie } from "./persona-api.js";
import { downloadSelfie } from "./storage.js";

export interface VerifiedIdentityUser {
  verificationStatus: string;
  verifiedSelfiePath: string | null;
  personaInquiryId: string | null;
}

export type VerifiedIdentityReferenceResult =
  | { kind: "not_required" }
  | { kind: "available"; buffer: Buffer; source: "storage" | "persona" }
  | { kind: "unavailable" };

export interface VerifiedIdentityReferenceDeps {
  downloadSelfie: typeof downloadSelfie;
  fetchInquirySelfie: typeof fetchInquirySelfie;
}

const LOG_PREFIX = "[verified-identity-reference]";

/**
 * Resolve the authoritative Persona selfie used to gate a new profile photo.
 *
 * The retention worker removes our stored copy after 90 days. Verified users
 * must still pass the identity gate after that point, so we re-fetch the image
 * from Persona for this one comparison and do not persist it again. Any
 * storage/Persona failure is fail-closed: the upload can be retried, but it is
 * never published without an authoritative reference.
 */
export async function resolveVerifiedIdentityReference(
  user: VerifiedIdentityUser,
  deps: VerifiedIdentityReferenceDeps = {
    downloadSelfie,
    fetchInquirySelfie,
  },
): Promise<VerifiedIdentityReferenceResult> {
  if (user.verificationStatus !== "verified") {
    return { kind: "not_required" };
  }

  if (user.verifiedSelfiePath) {
    const stored = await deps.downloadSelfie(user.verifiedSelfiePath);
    if (stored) {
      return { kind: "available", buffer: stored, source: "storage" };
    }
    console.warn(`${LOG_PREFIX} stored selfie unavailable`, {
      path: user.verifiedSelfiePath,
    });
  }

  if (user.personaInquiryId) {
    const fresh = await deps.fetchInquirySelfie(user.personaInquiryId);
    if (fresh.ok) {
      return {
        kind: "available",
        buffer: fresh.selfie.buffer,
        source: "persona",
      };
    }
    console.warn(`${LOG_PREFIX} Persona selfie unavailable`, {
      inquiryId: user.personaInquiryId,
      error: fresh.error,
    });
  }

  return { kind: "unavailable" };
}
