#!/usr/bin/env node
import { prisma } from "@gennety/db";

const users = await prisma.user.findMany({
  orderBy: [{ createdAt: "desc" }],
  take: 20,
  select: {
    id: true,
    email: true,
    telegramId: true,
    onboardingStep: true,
    firstName: true,
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
  lastMsg: u.lastMessageAt?.toISOString() ?? null,
  created: u.createdAt?.toISOString() ?? null,
}));

console.log(JSON.stringify(rows, null, 2));
await prisma.$disconnect();
