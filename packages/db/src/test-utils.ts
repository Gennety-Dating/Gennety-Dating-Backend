/**
 * Centralised Prisma mock for unit tests.
 *
 * Usage:
 *   import { mockPrisma, resetPrismaMocks } from "@gennety/db/test-utils";
 *
 * Every model method is a `vi.fn()` that defaults to `undefined`.
 * Override per-test with `mockPrisma.user.findUnique.mockResolvedValue(...)`.
 *
 * Call `resetPrismaMocks()` in `beforeEach` to clear call history.
 */

import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Model method factories — add methods here as the schema grows
// ---------------------------------------------------------------------------

function userMock() {
  return {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    groupBy: vi.fn().mockResolvedValue([]),
  };
}

function profileMock() {
  return {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  };
}

function matchMock() {
  return {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    groupBy: vi.fn().mockResolvedValue([]),
  };
}

function botSessionMock() {
  return {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  };
}

function systemKnowledgeMock() {
  return {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// The mock client
// ---------------------------------------------------------------------------

export const mockPrisma = {
  user: userMock(),
  profile: profileMock(),
  match: matchMock(),
  botSession: botSessionMock(),
  systemKnowledge: systemKnowledgeMock(),
  $queryRawUnsafe: vi.fn(),
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  $executeRawUnsafe: vi.fn(),
  $transaction: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(mockPrisma)),
  ),
};

/** Reset every mock function call history. Use in `beforeEach`. */
export function resetPrismaMocks(): void {
  const walk = (obj: Record<string, unknown>) => {
    for (const val of Object.values(obj)) {
      if (typeof val === "function" && "mockClear" in val) {
        (val as ReturnType<typeof vi.fn>).mockClear();
      } else if (val && typeof val === "object") {
        walk(val as Record<string, unknown>);
      }
    }
  };
  walk(mockPrisma as unknown as Record<string, unknown>);
}
