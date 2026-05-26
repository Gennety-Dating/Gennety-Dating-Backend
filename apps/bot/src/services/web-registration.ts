import { createHash, randomBytes } from "node:crypto";
import {
  prisma,
  type Language,
  type Platform,
  type User,
  type WebRegistrationLink,
  type WebRegistrationPurpose,
} from "@gennety/db";

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

export interface CreateWebRegistrationLinkInput {
  email: string;
  language: Language;
  purpose: WebRegistrationPurpose;
  termsAccepted: true;
  researchOptIn: boolean;
}

export interface CreatedWebRegistrationLink {
  token: string;
  startParam: string;
  expiresAt: Date;
}

export async function createWebRegistrationLink(
  input: CreateWebRegistrationLinkInput,
): Promise<CreatedWebRegistrationLink> {
  const email = input.email.trim().toLowerCase();
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

  await prisma.$transaction([
    prisma.webRegistrationLink.updateMany({
      where: { email, consumedAt: null },
      data: { consumedAt: now },
    }),
    prisma.webRegistrationLink.create({
      data: {
        tokenHash: hashToken(token),
        email,
        universityDomain: extractDomain(email),
        language: input.language,
        purpose: input.purpose,
        termsAccepted: input.termsAccepted,
        termsAcceptedAt: now,
        researchOptIn: input.researchOptIn,
        expiresAt,
      },
    }),
  ]);

  return {
    token,
    startParam: `${AUTH_REGISTRATION_START_PREFIX}${token}`,
    expiresAt,
  };
}

export type ConsumeWebRegistrationResult =
  | { kind: "linked"; user: User; purpose: WebRegistrationPurpose }
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

function webPatchFor(
  link: WebRegistrationLink,
  existing?: Pick<User, "onboardingStep" | "referralSource"> | null,
) {
  return {
    email: link.email,
    universityDomain: link.universityDomain,
    language: link.language,
    hasConsented: true,
    consentedAt: link.termsAcceptedAt,
    termsAccepted: true,
    termsAcceptedAt: link.termsAcceptedAt,
    researchOptIn: link.researchOptIn,
    isEmailVerified: true,
    emailOtp: null,
    emailOtpExpiresAt: null,
    onboardingStep: stepAfterWebLink(existing?.onboardingStep),
    ...(existing?.referralSource ? {} : { referralSource: `web:${link.purpose}` }),
  };
}

export async function consumeWebRegistrationLink(
  token: string,
  telegramId: bigint,
): Promise<ConsumeWebRegistrationResult> {
  const cleanToken = token.trim();
  if (!TOKEN_RE.test(cleanToken)) return { kind: "invalid_token" };

  return prisma.$transaction(async (tx) => {
    const link = await tx.webRegistrationLink.findUnique({
      where: { tokenHash: hashToken(cleanToken) },
    });

    if (!link) return { kind: "not_found" as const };
    if (link.consumedAt) return { kind: "used" as const };
    if (link.expiresAt <= new Date()) return { kind: "expired" as const };

    const [telegramUser, emailUser] = await Promise.all([
      tx.user.findUnique({ where: { telegramId } }),
      tx.user.findUnique({ where: { email: link.email } }),
    ]);

    if (telegramUser?.email && telegramUser.email !== link.email) {
      return {
        kind: "telegram_has_other_email" as const,
        email: telegramUser.email,
      };
    }

    if (emailUser && telegramUser && emailUser.id !== telegramUser.id) {
      return {
        kind: "email_linked_to_other_telegram" as const,
        email: link.email,
      };
    }

    if (emailUser && emailUser.telegramId > 0n && emailUser.telegramId !== telegramId) {
      return {
        kind: "email_linked_to_other_telegram" as const,
        email: link.email,
      };
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

    return { kind: "linked" as const, user, purpose: link.purpose };
  });
}
