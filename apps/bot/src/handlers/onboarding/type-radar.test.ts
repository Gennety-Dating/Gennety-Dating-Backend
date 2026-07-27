import { describe, it, expect, vi, beforeEach } from "vitest";

// The module pulls prisma + config + the onboarding agent at import time; stub
// them so we can unit-test the pure session-patch mapping in isolation.
const dbMocks = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: dbMocks.findUnique } },
}));
vi.mock("../../config.js", () => ({ env: { WEBAPP_URL: "https://x.invalid" } }));
const agentMocks = vi.hoisted(() => ({ runAgentTurn: vi.fn() }));
vi.mock("../../services/onboarding-agent.js", () => ({
  runAgentTurn: agentMocks.runAgentTurn,
}));
vi.mock("../../services/mini-app-url.js", () => ({ buildMiniAppUrl: () => "https://x.invalid/radar.html" }));

const { sessionPatchAfterRadar, resumeOnboardingAfterRadar } = await import("./type-radar.js");

function result(overrides: Record<string, unknown>) {
  return {
    reply: "",
    expectingPhoto: false,
    onboardingComplete: false,
    verificationRequired: false,
    contextPromptRequested: false,
    contextDumpStarted: false,
    contextDumpSaved: false,
    ...overrides,
  } as Parameters<typeof sessionPatchAfterRadar>[0];
}

describe("sessionPatchAfterRadar", () => {
  it("buffers the paste on the accepted path (Magic Prompt shown)", () => {
    expect(sessionPatchAfterRadar(result({ contextPromptRequested: true, contextDumpStarted: true })))
      .toEqual({ awaitingContextDump: true, contextDumpBuffer: "", expectingPhoto: false });
  });

  it("expects photos on the declined path", () => {
    expect(sessionPatchAfterRadar(result({ expectingPhoto: true })))
      .toEqual({ expectingPhoto: true, awaitingContextDump: false });
  });

  it("stays idle when the resume neither shows the prompt nor asks for photos", () => {
    expect(sessionPatchAfterRadar(result({})))
      .toEqual({ expectingPhoto: false, awaitingContextDump: false });
  });
});

// ---------------------------------------------------------------------------
// The radar gate intercepts the photos question before `handleConversational`
// can send it, so this resume IS the upload stage's entry point whenever
// TYPE_RADAR_ENABLED is on. If it doesn't carry the bottom panel, the photo
// editor has no entry point at all (PRODUCT_SPEC §1.3).
// ---------------------------------------------------------------------------
describe("resumeOnboardingAfterRadar — photo-stage bottom panel", () => {
  const api = { sendMessage: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    api.sendMessage.mockResolvedValue({ message_id: 1 });
    dbMocks.findUnique.mockResolvedValue({ language: "ru" });
  });

  it("attaches the panel to the photo request on the declined path", async () => {
    agentMocks.runAgentTurn.mockResolvedValue(result({
      reply: "Пришли мне свои фото",
      expectingPhoto: true,
    }));

    const { sessionPatch } = await resumeOnboardingAfterRadar(
      api as never,
      BigInt(500),
      500,
    );

    expect(api.sendMessage).toHaveBeenCalledWith(
      500,
      "Пришли мне свои фото",
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          keyboard: expect.any(Array),
          is_persistent: true,
        }),
      }),
    );
    // The flag has to travel with the patch, otherwise the next message would
    // send a second, duplicate keyboard.
    expect(sessionPatch.photoStagePanelShown).toBe(true);
  });

  it("renders the panel in the user's own language", async () => {
    agentMocks.runAgentTurn.mockResolvedValue(result({
      reply: "Send me your photos",
      expectingPhoto: true,
    }));
    dbMocks.findUnique.mockResolvedValue({ language: "de" });

    await resumeOnboardingAfterRadar(api as never, BigInt(500), 500);

    const markup = api.sendMessage.mock.calls[0]![2].reply_markup as {
      keyboard: { text: string }[][];
    };
    expect(markup.keyboard[0]![0]!.text).toContain("Fotos");
  });

  it("does NOT attach the panel on the accepted path (Magic Prompt, not photos)", async () => {
    agentMocks.runAgentTurn.mockResolvedValue(result({
      reply: "Paste the analysis back here",
      contextPromptRequested: true,
      contextDumpStarted: true,
    }));

    const { sessionPatch } = await resumeOnboardingAfterRadar(
      api as never,
      BigInt(500),
      500,
    );

    const replyCall = api.sendMessage.mock.calls.at(-1)!;
    expect(replyCall[2] ?? {}).toEqual({});
    expect(sessionPatch.photoStagePanelShown).toBeUndefined();
  });

  it("leaves the flag unset when the message could not be delivered", async () => {
    // Marking the panel shown after a lost message would suppress every later
    // attempt to establish it — the user would never get into the editor.
    agentMocks.runAgentTurn.mockResolvedValue(result({
      reply: "Send me your photos",
      expectingPhoto: true,
    }));
    api.sendMessage.mockRejectedValue(new Error("blocked by user"));

    const { sessionPatch } = await resumeOnboardingAfterRadar(
      api as never,
      BigInt(500),
      500,
    );

    expect(sessionPatch.photoStagePanelShown).toBeUndefined();
    expect(sessionPatch.expectingPhoto).toBe(true);
  });
});
