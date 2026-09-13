/**
 * Whether a `refundStarPayment` failure means the Stars are ALREADY back —
 * Telegram answers a second refund of one charge with
 * `Bad Request: CHARGE_ALREADY_REFUNDED`.
 *
 * Every Stars rail treats that answer as the success it is: the outcome the
 * refund wanted is true. Reading it as a failure parks a settled refund in
 * `refund_failed` forever — the sweep retries it hourly, Telegram gives the same
 * answer every time, and the row never reaches a refunded status. It lives in
 * its own module because the date gate, venue change, Prime Time and Rematch
 * rails all refund, and a copy per rail is how one of them drifts.
 */
export function isAlreadyRefundedError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "description" in error
        ? String((error as { description?: unknown }).description ?? "")
        : String(error);
  return /already[^\n]*refund|refund[^\n]*already/i.test(text);
}
