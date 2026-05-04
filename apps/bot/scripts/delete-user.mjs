#!/usr/bin/env node
import { prisma } from "@gennety/db";

const id = process.argv[2];
if (!id) {
  console.error("Usage: tsx scripts/delete-user.mjs <userId>");
  process.exit(1);
}

const before = await prisma.user.findUnique({
  where: { id },
  select: { id: true, email: true, telegramId: true, firstName: true },
});
if (!before) {
  console.error(`User ${id} not found`);
  await prisma.$disconnect();
  process.exit(1);
}

console.log("Deleting:", JSON.stringify({ ...before, telegramId: String(before.telegramId) }, null, 2));

// Raw SQL avoids Prisma validating columns missing from the live DB schema.
const deleted = await prisma.$executeRawUnsafe(
  `DELETE FROM users WHERE id = $1::uuid`,
  id,
);
console.log(deleted === 1 ? "OK: 1 row deleted" : `WARN: ${deleted} rows deleted`);
await prisma.$disconnect();
