/**
 * The one UUID shape check for both HTTP surfaces.
 *
 * Every `:id` on `/v1/*` and `/admin/*` is a `@db.Uuid` primary key, and
 * handing Prisma a non-UUID string does not return "not found" — it throws
 * `P2023` ("Inconsistent column data: Error creating UUID"). A route that lets
 * that through reports a caller's typo as `500 Internal server error` and fills
 * the log with entries shaped like incidents.
 *
 * The admin surface learned this first (observed live on `/admin/users/:id`)
 * and grew a guard; the public one grew eight private copies of the same regex
 * in eight route files and, in the two that never got one — the JWT match
 * router and the events router — no guard at all. So the predicate lives here
 * now, once, and both surfaces import it.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
