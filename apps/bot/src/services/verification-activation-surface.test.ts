/**
 * The landing sequence a freshly verified Telegram user sees
 * (`surfaceVerifiedActivationDefault`): the Profiler heads-up, the main menu,
 * then the pinned status banner.
 *
 * The heads-up is what these tests exist for. It announces the §Phase 1b
 * Profiler at the one honest moment — activation, which is exactly when the
 * dispatch sweep (`workers/profiler.ts`) starts being able to reach the user —
 * so it must carry that worker's OWN reachability rule rather than the looser
 * `telegramId > 0` test one line above it, and it must land above the menu so
 * it reads under the "verified ✨" DM instead of below a keyboard.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@gennety/shared";

const userFindUnique = vi.fn(async (_arg?: unknown): Promise<unknown> => null);

vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: (arg: unknown) => userFindUnique(arg) } },
  Prisma: {},
}));

const sendMainMenu = vi.fn(async () => {});
vi.mock("../handlers/menu/main.js", () => ({
  sendMainMenu: (...args: unknown[]) => sendMainMenu(...(args as [])),
}));

const pinStatusBanner = vi.fn(async () => {});
vi.mock("./status-banner.js", () => ({
  pinStatusBanner: (...args: unknown[]) => pinStatusBanner(...(args as [])),
}));

const { surfaceVerifiedActivationDefault } = await import("./verification-pipeline.js");

const ACTIVE = {
  telegramId: 555n,
  language: "ru" as const,
  status: "active",
  verificationStatus: "verified",
  statusMessageId: null,
  platform: "telegram",
};

function makeApi() {
  return { sendMessage: vi.fn(async () => ({})) } as never;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("surfaceVerifiedActivationDefault", () => {
  it("sends the Profiler heads-up in the user's language, above the menu", async () => {
    userFindUnique.mockResolvedValueOnce(ACTIVE);
    const api = makeApi();
    const order: string[] = [];
    (api as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mockImplementation(
      async () => {
        order.push("heads-up");
        return {};
      },
    );
    sendMainMenu.mockImplementation(async () => {
      order.push("menu");
    });

    await surfaceVerifiedActivationDefault(api, "u1", 555n);

    const send = (api as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toBe(t("ru", "profilerHeadsUp"));
    // The heads-up belongs under the "verified ✨" DM, not under a keyboard.
    expect(order).toEqual(["heads-up", "menu"]);
    expect(pinStatusBanner).toHaveBeenCalledTimes(1);
  });

  it("stays silent for an app-only account carrying a REAL Telegram id", async () => {
    // "Continue with Telegram" stores a positive `telegramId` on an account the
    // bot cannot message, and `workers/profiler.ts` skips it — so promising it
    // questions would be promising something that never arrives.
    userFindUnique.mockResolvedValueOnce({ ...ACTIVE, platform: "mobile" });
    const api = makeApi();

    await surfaceVerifiedActivationDefault(api, "u1", 555n);

    expect((api as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage).not
      .toHaveBeenCalled();
  });

  it("does not repeat the heads-up on a verification rerun", async () => {
    // A photo edit reruns the pipeline; the existing banner is the marker that
    // this user already had their landing sequence.
    userFindUnique.mockResolvedValueOnce({ ...ACTIVE, statusMessageId: 42 });
    const api = makeApi();

    await surfaceVerifiedActivationDefault(api, "u1", 555n);

    expect((api as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage).not
      .toHaveBeenCalled();
    expect(sendMainMenu).not.toHaveBeenCalled();
  });

  it("never blocks the menu when the heads-up fails to send", async () => {
    userFindUnique.mockResolvedValueOnce(ACTIVE);
    const api = makeApi();
    (api as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mockRejectedValue(
      new Error("blocked by user"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await surfaceVerifiedActivationDefault(api, "u1", 555n);

    expect(sendMainMenu).toHaveBeenCalledTimes(1);
    expect(pinStatusBanner).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
