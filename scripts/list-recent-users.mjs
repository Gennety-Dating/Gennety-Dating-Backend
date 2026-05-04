#!/usr/bin/env node
// Usage: pnpm tsx scripts/list-recent-users.mjs
import { prisma } from "@gennety/db";

const users = await prisma.user.findMany({
  orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
  take: 5,
  select: {
    id: true,
    email: true,
    telegramId: true,
    onboardingStep: true,
    firstName: true,
    isEmailVerified: true,
    lastMessageAt: true,
    createdAt: true,
  },
});

const rows = users.map((u) => ({
  id: u.id,
  email: u.email,
  tg: String(u.telegramId),
  step: u.onboardingStep,
  name: u.firstName,
  verified: u.isEmailVerified,
  lastMsg: u.lastMessageAt?.toISOString() ?? null,
  created: u.createdAt?.toISOString() ?? null,
}));

console.log(JSON.stringify(rows, null, 2));
await prisma.$disconnect();
