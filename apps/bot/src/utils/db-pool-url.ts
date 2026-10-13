/**
 * `DATABASE_URL` with a Prisma `connection_limit` added when it carries none.
 *
 * An explicit `connection_limit` already in the URL is left untouched, so the
 * env stays the override (and the rollback). The rest of the URL is kept byte
 * for byte — it is appended to, never re-serialised, so credentials with
 * percent-encoding survive exactly as written.
 */
export function withConnectionLimit(
  url: string | undefined,
  limit: number,
): string | undefined {
  if (!url) return url;
  if (/[?&]connection_limit=/.test(url)) return url;
  const separator = !url.includes("?")
    ? "?"
    : url.endsWith("?") || url.endsWith("&")
      ? ""
      : "&";
  return `${url}${separator}connection_limit=${limit}`;
}

/** The `connection_limit` a URL carries, for the boot log; `null` when none. */
export function connectionLimitOf(url: string): string | null {
  return /[?&]connection_limit=([^&#]*)/.exec(url)?.[1] ?? null;
}
