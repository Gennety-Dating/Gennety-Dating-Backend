/**
 * Every `:id` on the admin surface is a `@db.Uuid` primary key. Handing Prisma
 * a non-UUID string does not return "not found" — it throws `P2023`
 * ("Inconsistent column data: Error creating UUID"), which the route catches
 * as an unknown failure and reports as a 500 with a stack trace in the logs.
 *
 * That is wrong twice over: a caller who mistyped an id gets "Internal server
 * error" and cannot tell their mistake from a broken server, and the error log
 * fills with entries that look like incidents. Observed live on
 * `/admin/users/:id` before this guard existed.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
