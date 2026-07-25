import { beforeEach, describe, expect, it, vi } from "vitest";

const { env } = vi.hoisted(() => ({ env: { AI_MEMORY_EXPORT_ENABLED: true } }));
vi.mock("../config.js", () => ({ env }));

import {
  effectiveAiMemoryPreference,
  isAiMemoryExportDeclined,
  isAiMemoryExportEnabled,
} from "./ai-memory-export.js";

beforeEach(() => {
  env.AI_MEMORY_EXPORT_ENABLED = true;
});

describe("ai-memory export kill switch", () => {
  it("passes the stored preference through while the feature is on", () => {
    expect(isAiMemoryExportEnabled()).toBe(true);
    expect(effectiveAiMemoryPreference("undecided")).toBe("undecided");
    expect(effectiveAiMemoryPreference("accepted")).toBe("accepted");
    expect(effectiveAiMemoryPreference("declined")).toBe("declined");
    expect(isAiMemoryExportDeclined("accepted")).toBe(false);
    expect(isAiMemoryExportDeclined("undecided")).toBe(false);
  });

  it("treats a missing preference as undecided while on", () => {
    expect(effectiveAiMemoryPreference(null)).toBe("undecided");
    expect(effectiveAiMemoryPreference(undefined)).toBe("undecided");
  });

  it("masks every stored preference to declined while the feature is off", () => {
    env.AI_MEMORY_EXPORT_ENABLED = false;
    expect(isAiMemoryExportEnabled()).toBe(false);
    // Crucially `accepted` is masked too: a user who opted in before the flip
    // must not be parked on a Magic Prompt step the flow no longer asks for.
    expect(effectiveAiMemoryPreference("accepted")).toBe("declined");
    expect(effectiveAiMemoryPreference("undecided")).toBe("declined");
    expect(effectiveAiMemoryPreference(null)).toBe("declined");
    expect(isAiMemoryExportDeclined("accepted")).toBe(true);
    expect(isAiMemoryExportDeclined("undecided")).toBe(true);
  });
});
