import { describe, expect, it, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  voicePrompt: { upsert: vi.fn(), deleteMany: vi.fn() },
  profile: { updateMany: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));
const refreshMock = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("@gennety/db", () => ({ prisma: prismaMock }));
vi.mock("../workers/embedding-refresh.js", () => ({ refreshUserEmbedding: refreshMock }));

const { saveVoicePrompt, deleteVoicePrompt } = await import("./voice-prompt.js");

describe("saveVoicePrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (ops: unknown[]) => ops);
    prismaMock.voicePrompt.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("marks the profile dirty AND refreshes immediately", async () => {
    // `embeddingDirty` is fail-closed: findCandidatesFor withholds a dirty
    // seeker from matching entirely, so marking dirty without refreshing takes
    // the user out of the pool until the 5-minute cron. That is the
    // appendNegativeConstraint bug (DECISIONS 2026-08-08) — the one thing this
    // path must not repeat.
    await saveVoicePrompt({
      userId: "u1",
      telegramFileId: "file-1",
      durationSec: 14,
      waveform: [1, 2],
      transcript: "варю кофе по утрам",
    });

    expect(prismaMock.profile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1" },
        data: expect.objectContaining({ embeddingDirty: true }),
      }),
    );
    expect(refreshMock).toHaveBeenCalledWith("u1");
  });

  it("writes the row and the dirty flag in ONE transaction", async () => {
    await saveVoicePrompt({
      userId: "u1",
      telegramFileId: "f",
      durationSec: 10,
      waveform: [],
      transcript: "t",
    });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("REPLACES on re-record rather than accumulating", async () => {
    await saveVoicePrompt({
      userId: "u1",
      telegramFileId: "f2",
      durationSec: 11,
      waveform: [3],
      transcript: "second take",
    });
    const args = prismaMock.voicePrompt.upsert.mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
    };
    expect(args.update).toMatchObject({ telegramFileId: "f2", transcript: "second take" });
  });

  it("does not fail the save when the refresh throws — the recording is good either way", async () => {
    refreshMock.mockRejectedValueOnce(new Error("openai down"));
    await expect(
      saveVoicePrompt({
        userId: "u1",
        telegramFileId: "f",
        durationSec: 10,
        waveform: [],
        transcript: "t",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("deleteVoicePrompt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-dirties and refreshes, so a deleted clip stops influencing matching", async () => {
    prismaMock.voicePrompt.deleteMany.mockResolvedValue({ count: 1 });
    await deleteVoicePrompt("u1");
    expect(prismaMock.profile.updateMany).toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalledWith("u1");
  });

  it("does nothing at all when there was no prompt — no needless re-embed", async () => {
    prismaMock.voicePrompt.deleteMany.mockResolvedValue({ count: 0 });
    await deleteVoicePrompt("u1");
    expect(prismaMock.profile.updateMany).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
