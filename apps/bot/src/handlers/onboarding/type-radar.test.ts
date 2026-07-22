import { describe, it, expect, vi } from "vitest";

// The module pulls prisma + config + the onboarding agent at import time; stub
// them so we can unit-test the pure session-patch mapping in isolation.
vi.mock("@gennety/db", () => ({ prisma: {} }));
vi.mock("../../config.js", () => ({ env: { WEBAPP_URL: "https://x.invalid" } }));
vi.mock("../../services/onboarding-agent.js", () => ({ runAgentTurn: vi.fn() }));
vi.mock("../../services/mini-app-url.js", () => ({ buildMiniAppUrl: () => "https://x.invalid/radar.html" }));

const { sessionPatchAfterRadar } = await import("./type-radar.js");

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
