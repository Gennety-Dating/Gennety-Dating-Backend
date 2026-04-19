import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    botSession: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from "@gennety/db";
import { prismaSessionAdapter } from "./prisma-session-adapter.js";

describe("prismaSessionAdapter", () => {
  const adapter = prismaSessionAdapter<{ count: number }>();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("read returns undefined when no row exists", async () => {
    (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await adapter.read("user:123");
    expect(result).toBeUndefined();
    expect(prisma.botSession.findUnique).toHaveBeenCalledWith({
      where: { key: "user:123" },
    });
  });

  it("read returns parsed data when row exists", async () => {
    (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "user:123",
      data: { count: 42 },
    });

    const result = await adapter.read("user:123");
    expect(result).toEqual({ count: 42 });
  });

  it("write upserts session data", async () => {
    (prisma.botSession.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await adapter.write("user:123", { count: 7 });

    expect(prisma.botSession.upsert).toHaveBeenCalledWith({
      where: { key: "user:123" },
      create: { key: "user:123", data: { count: 7 } },
      update: { data: { count: 7 } },
    });
  });

  it("delete removes the session row", async () => {
    (prisma.botSession.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    await adapter.delete("user:123");

    expect(prisma.botSession.deleteMany).toHaveBeenCalledWith({
      where: { key: "user:123" },
    });
  });
});
