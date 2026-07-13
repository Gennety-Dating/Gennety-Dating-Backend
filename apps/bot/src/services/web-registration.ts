import { createHash, randomBytes } from "node:crypto";
import {
  prisma,
  type Language,
  type Platform,
  type User,
  type WebRegistrationLink,
  type WebRegistrationPurpose,
} from "@gennety/db";
import { saveHomeLocationForUser, type HomeLocationInput } from "../public/home-location.js";

export const WEB_REGISTRATION_START_PREFIX = "web_";
export const AUTH_REGISTRATION_START_PREFIX = "auth_";

const TOKEN_BYTES = 24;
const TOKEN_TTL_MS = 30 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{24,64}$/;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function extractDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return email.slice(at + 1).toLowerCase();
}

export type WebRegistrationTrack = "student" | "general";

/**
 * The website owns the first slice of onboarding: language, consent, and the
 * sign-up fork. What it may verify depends on the track.
 *
 * - `student` — the university email is OTP-verified on the site, and the
 *   dating city is picked there too, so Telegram resumes at the theme picker.
 * - `general` — the site collects nothing but language + consent. The phone is
 *   **not** verified on the web on purpose: a number is only trusted when it
 *   arrives as Telegram's own `message.contact`, so the handoff carries the
 *   *choice* of rail and the Mini App runs the real gate.
 */
export type CreateWebRegistrationLinkInput = {
  language: Language;
  purpose: WebRegistrationPurpose;
  termsAccepted: true;
  researchOptIn: boolean;
} & (
  | {
      track: "student";
      email: string;
      /** Dating city chosen on the website. */
      city: HomeLocationInput;
    }
  | { track: "general"; email?: undefined; city?: undefined }
);

export interface CreatedWebRegistrationLink {
  token: string;
  startParam: string;
  expiresAt: Date;
}

export async function createWebRegistrationLink(
  input: CreateWebRegistrationLinkInput,
): Promise<CreatedWebRegistrationLink> {
  const email = input.track === "student" ? input.email.trim().toLowerCase() : null;
  const city = input.track === "student" ? input.city : null;
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

  const create = prisma.webRegistrationLink.create({
    data: {
      tokenHash: hashToken(token),
      registrationTrack: input.track,
      email,
      universityDomain: email ? extractDomain(email) : null,
      language: input.language,
      purpose: input.purpose,
      termsAccepted: input.termsAccepted,
      termsAcceptedAt: now,
      researchOptIn: input.researchOptIn,
      homeCity: city?.homeCity ?? null,
      homeCountryCode: city?.homeCountryCode ?? null,
      homeCityKey: city?.homeCityKey ?? null,
      homePlaceId: city?.homePlaceId ?? null,
      latitude: city?.latitude ?? null,
      longitude: city?.longitude ?? null,
      expiresAt,
    },
  });

  // Superseding an earlier unconsumed link is only meaningful for the student
  // track: it is keyed by email, and a general-track link has none.
  if (email) {
    await prisma.$transaction([
      prisma.webRegistrationLink.updateMany({
        where: { email, consumedAt: null },
        data: { consumedAt: now },
      }),
      create,
    ]);
  } else {
    await create;
  }

  return {
    token,
    startParam: `${AUTH_REGISTRATION_START_PREFIX}${token}`,
    expiresAt,
  };
}

export type ConsumeWebRegistrationResult =
  | {
      kind: "linked";
      user: User;
      purpose: WebRegistrationPurpose;
      /**
       * The track the link was minted for. Callers MUST branch on this rather
       * than assume a web handoff means a verified university email — only the
       * student track carries one (and only it earns the student bonus).
       */
      track: WebRegistrationTrack;
    }
  | { kind: "invalid_token" }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "used" }
  | { kind: "telegram_has_other_email"; email: string }
  | { kind: "email_linked_to_other_telegram"; email: string };

function nextPlatform(current: Platform, hasMobileSession: boolean): Platform {
  if (current === "both") return "both";
  if (current === "mobile" && hasMobileSession) return "both";
  return "telegram";
}

function stepAfterWebLink(
  currentStep: User["onboardingStep"] | null | undefined,
): User["onboardingStep"] {
  return currentStep === "completed" ? "completed" : "conversational";
}

/** A link carries a verified email only on the student track. */
export function trackOf(link: WebRegistrationLink): WebRegistrationTrack {
  // Legacy links (minted before the fork) always carried a verified university
  // email, so an absent track reads as `student`.
  return link.registrationTrack === "general" ? "general" : "student";
}

function webPatchFor(
  link: WebRegistrationLink,
  existing?: Pick<User, "onboardingStep" | "referralSource"> | null,
) {
  const track = trackOf(link);
  const shared = {
    language: link.language,
    hasConsented: true,
    consentedAt: link.termsAcceptedAt,
    termsAccepted: true,
    termsAcceptedAt: link.termsAcceptedAt,
    researchOptIn: link.researchOptIn,
    registrationTrack: track,
    onboardingStep: stepAfterWebLink(existing?.onboardingStep),
    ...(existing?.referralSource ? {} : { referralSource: `web:${link.purpose}` }),
  };

  // The general track brings NO contact rail with it. The website never sees the
  // number, so nothing here may imply a verified phone — `phoneVerifiedAt` stays
  // null and the Mini App's phone gate (and the server-side `/complete` contact
  // gate) is what actually verifies it.
  if (track === "general") return shared;

  return {
    ...shared,
    email: link.email,
    universityDomain: link.universityDomain,
    isEmailVerified: true,
    emailOtp: null,
    emailOtpExpiresAt: null,
  };
}

/** The city the user picked on the website, if this link carries one. */
function cityOf(link: WebRegistrationLink): HomeLocationInput | null {
  if (
    !link.homeCity ||
    !link.homeCountryCode ||
    !link.homeCityKey ||
    link.latitude === null ||
    link.longitude === null
  ) {
    return null;
  }
  return {
    homeCity: link.homeCity,
    homeCountryCode: link.homeCountryCode,
    homeCityKey: link.homeCityKey,
    homePlaceId: link.homePlaceId,
    latitude: link.latitude,
    longitude: link.longitude,
  };
}

export async function consumeWebRegistrationLink(
  token: string,
  telegramId: bigint,
): Promise<ConsumeWebRegistrationResult> {
  const cleanToken = token.trim();
  if (!TOKEN_RE.test(cleanToken)) return { kind: "invalid_token" };

  const result = await linkTelegramToWebRegistration(cleanToken, telegramId);

  // The city the user picked on the website is written after the link is
  // committed: it lives on `Profile`, and failing to persist it must not undo
  // the account link. The cost of a failure here is one extra screen — the Mini
  // App simply shows the city gate, exactly as it does for the general track.
  if (result.kind === "linked" && result.city) {
    try {
      await saveHomeLocationForUser(result.user.id, result.city);
    } catch (err) {
      console.error("[web-registration] city handoff failed, user will pick it in-app:", err);
    }
  }

  return result.kind === "linked"
    ? { kind: "linked", user: result.user, purpose: result.purpose, track: result.track }
    : result;
}

type LinkOutcome =
  | {
      kind: "linked";
      user: User;
      purpose: WebRegistrationPurpose;
      track: WebRegistrationTrack;
      city: HomeLocationInput | null;
    }
  | Exclude<ConsumeWebRegistrationResult, { kind: "linked" }>;

async function linkTelegramToWebRegistration(
  cleanToken: string,
  telegramId: bigint,
): Promise<LinkOutcome> {
  return prisma.$transaction(async (tx) => {
    const link = await tx.webRegistrationLink.findUnique({
      where: { tokenHash: hashToken(cleanToken) },
    });

    if (!link) return { kind: "not_found" as const };
    if (link.consumedAt) return { kind: "used" as const };
    if (link.expiresAt <= new Date()) return { kind: "expired" as const };

    const linkEmail = link.email;

    // A general-track link carries no email, so every email-collision check
    // below is inapplicable — there is nothing to collide with. Its identity is
    // the Telegram account alone.
    const [telegramUser, emailUser] = await Promise.all([
      tx.user.findUnique({ where: { telegramId } }),
      linkEmail ? tx.user.findUnique({ where: { email: linkEmail } }) : Promise.resolve(null),
    ]);

    if (linkEmail) {
      if (telegramUser?.email && telegramUser.email !== linkEmail) {
        return {
          kind: "telegram_has_other_email" as const,
          email: telegramUser.email,
        };
      }

      if (emailUser && telegramUser && emailUser.id !== telegramUser.id) {
        return {
          kind: "email_linked_to_other_telegram" as const,
          email: linkEmail,
        };
      }

      if (emailUser && emailUser.telegramId > 0n && emailUser.telegramId !== telegramId) {
        return {
          kind: "email_linked_to_other_telegram" as const,
          email: linkEmail,
        };
      }
    }

    const consumed = await tx.webRegistrationLink.updateMany({
      where: { id: link.id, consumedAt: null },
      data: {
        consumedAt: new Date(),
        consumedTelegramId: telegramId,
      },
    });
    if (consumed.count !== 1) return { kind: "used" as const };

    let user: User;
    if (telegramUser) {
      user = await tx.user.update({
        where: { id: telegramUser.id },
        data: {
          ...webPatchFor(link, telegramUser),
          platform: nextPlatform(telegramUser.platform, false),
        },
      });
    } else if (emailUser) {
      const activeMobileSessions = await tx.userSession.count({
        where: {
          userId: emailUser.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });

      user = await tx.user.update({
        where: { id: emailUser.id },
        data: {
          ...webPatchFor(link, emailUser),
          telegramId,
          platform: nextPlatform(emailUser.platform, activeMobileSessions > 0),
        },
      });
    } else {
      user = await tx.user.create({
        data: {
          telegramId,
          firstName: null,
          platform: "telegram",
          status: "onboarding",
          ...webPatchFor(link),
        },
      });
    }

    return {
      kind: "linked" as const,
      user,
      purpose: link.purpose,
      track: trackOf(link),
      city: cityOf(link),
    };
  });
}
