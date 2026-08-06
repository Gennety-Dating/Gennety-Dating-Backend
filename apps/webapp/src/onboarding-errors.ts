import { CalendarApiError } from "./api.js";
import type { OnboardingStrings } from "./onboarding-i18n.js";

/**
 * Turn a failed onboarding request into copy the user can act on.
 *
 * The server's machine reason (`age_out_of_range`, `invalid_name`, …) is the
 * lookup key, so validation stays server-owned and the client only translates.
 * Shared by the gates in `onboarding.tsx` and the profile screens.
 */
export function errorCopy(err: unknown, strings: OnboardingStrings): string {
  if (err instanceof CalendarApiError) {
    if (err.reason && strings.errors[err.reason]) return strings.errors[err.reason];
    return err.reason ?? err.message;
  }
  return err instanceof Error ? err.message : strings.genericError;
}
