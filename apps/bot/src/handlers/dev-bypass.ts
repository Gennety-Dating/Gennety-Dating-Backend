/**
 * Dev-only helper: skip the corporate-email verification step for whitelisted
 * Telegram IDs at /start time.
 *
 * Why this exists: PRODUCT_SPEC.md §Core Principles requires a verified
 * university email for every user. That gate is appropriate in prod but makes
 * local two-account E2E testing painful — the developer would need a second
 * `.edu` address. Configuring `DEV_OTP_BYPASS_TELEGRAM_IDS` in `.env.local`
 * for the dev's secondary Telegram account synthesises a verified state
 * (`isEmailVerified=true`, an `@gennety.dev` synthetic email) so the
 * onboarding agent's `verifiedNote` branch fires and step 1 is skipped
 * entirely.
 *
 * Contract: must be empty in production. The bot logs a loud warning at
 * startup AND at every /start that hits the bypass.
 */

export const DEV_BYPASS_EMAIL_DOMAIN = "gennety.dev";

export interface BypassFields {
  email: string;
  universityDomain: string;
  isEmailVerified: true;
}

/**
 * Returns the partial `prisma.user.create` data that synthesises a verified
 * email for a bypassed Telegram ID, or `null` when the ID isn't in the list.
 *
 * Pure — takes the bypass set explicitly so callers can inject mocks in tests
 * and so the function doesn't reach into module-level env state.
 */
export function computeDevBypassFields(
  telegramId: bigint,
  bypassIds: ReadonlySet<bigint>,
): BypassFields | null {
  if (!bypassIds.has(telegramId)) return null;
  return {
    email: `dev+${telegramId.toString()}@${DEV_BYPASS_EMAIL_DOMAIN}`,
    universityDomain: DEV_BYPASS_EMAIL_DOMAIN,
    isEmailVerified: true,
  };
}
