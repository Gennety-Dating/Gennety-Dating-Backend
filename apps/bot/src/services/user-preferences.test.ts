import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { update: vi.fn() },
    match: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@gennety/db";
import { setUserLanguage, setUserTheme } from "./user-preferences.js";

describe("user-preferences", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (work: (tx: typeof prisma) => unknown) => work(prisma),
    );
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
    (prisma.match.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
  });

  it("setUserLanguage writes the language and clears both cached date-card sides", async () => {
    await setUserLanguage(BigInt(42), "ru");

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { telegramId: BigInt(42) },
      data: { language: "ru" },
      select: { id: true },
    });
    expect(prisma.match.updateMany).toHaveBeenCalledWith({
      where: { userAId: "u1", status: "scheduled" },
      data: { dateCardFileIdA: null },
    });
    expect(prisma.match.updateMany).toHaveBeenCalledWith({
      where: { userBId: "u1", status: "scheduled" },
      data: { dateCardFileIdB: null },
    });
  });

  it("setUserTheme writes the theme + themeChosenAt and clears the same cache", async () => {
    await setUserTheme(BigInt(42), "light");

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { telegramId: BigInt(42) },
      data: { theme: "light", themeChosenAt: expect.any(Date) },
      select: { id: true },
    });
    expect(prisma.match.updateMany).toHaveBeenCalledTimes(2);
  });

  it("runs both writes inside prisma.$transaction, not as loose calls", async () => {
    await setUserLanguage(BigInt(1), "en");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
