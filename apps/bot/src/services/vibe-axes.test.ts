import { beforeEach, describe, expect, it, vi } from "vitest";

const profileUpdate = vi.fn();
const callOpenAIJson = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    profile: {
      update: profileUpdate,
    },
  },
}));

vi.mock("./openai.js", () => ({
  callOpenAIJson: (...args: unknown[]) => callOpenAIJson(...args),
}));

const { extractVibeAxes, saveVibeAxes } = await import("./vibe-axes.js");

beforeEach(() => {
  vi.clearAllMocks();
  profileUpdate.mockResolvedValue({});
});

describe("extractVibeAxes", () => {
  it("returns null without calling the model when both answers are empty", async () => {
    const result = await extractVibeAxes("  ", null, "en");
    expect(result).toBeNull();
    expect(callOpenAIJson).not.toHaveBeenCalled();
  });

  it("clamps axes, whitelists the role, and lowercases/dedupes anchor tags", async () => {
    callOpenAIJson.mockResolvedValue({
      energy_axis: 2.5, // out of range → clamp to 1
      orientation_axis: -3, // out of range → clamp to -1
      social_role: "initiator",
      anchor_tags: ["Music", "music", " FOOD ", 42, "Nature"],
    });
    const result = await extractVibeAxes("club until 4am with everyone", "the people", "en");
    expect(result).toEqual({
      energyAxis: 1,
      orientationAxis: -1,
      socialRole: "initiator",
      anchorTags: ["music", "food", "nature"],
    });
  });

  it("coerces an unknown role to null and non-array tags to []", async () => {
    callOpenAIJson.mockResolvedValue({
      energy_axis: -0.4,
      orientation_axis: 0.2,
      social_role: "wallflower",
      anchor_tags: "not-an-array",
    });
    const result = await extractVibeAxes("quiet night in", "the process", "ru");
    expect(result?.socialRole).toBeNull();
    expect(result?.anchorTags).toEqual([]);
    expect(result?.energyAxis).toBeCloseTo(-0.4);
  });

  it("returns null when the model is unavailable", async () => {
    callOpenAIJson.mockResolvedValue(null);
    const result = await extractVibeAxes("anything", null, "en");
    expect(result).toBeNull();
  });

  it("defaults a non-numeric axis to 0", async () => {
    callOpenAIJson.mockResolvedValue({ energy_axis: "loud", orientation_axis: null });
    const result = await extractVibeAxes("party", null, "en");
    expect(result?.energyAxis).toBe(0);
    expect(result?.orientationAxis).toBe(0);
  });
});

describe("saveVibeAxes", () => {
  it("persists the axes and stamps vibeExtractedAt", async () => {
    await saveVibeAxes("user-1", {
      energyAxis: 0.5,
      orientationAxis: -0.5,
      socialRole: "observer",
      anchorTags: ["film"],
    });
    expect(profileUpdate).toHaveBeenCalledTimes(1);
    const arg = profileUpdate.mock.calls[0]![0];
    expect(arg.where).toEqual({ userId: "user-1" });
    expect(arg.data.energyAxis).toBe(0.5);
    expect(arg.data.orientationAxis).toBe(-0.5);
    expect(arg.data.socialRole).toBe("observer");
    expect(arg.data.anchorTags).toEqual(["film"]);
    expect(arg.data.vibeExtractedAt).toBeInstanceOf(Date);
  });

  it("writes nulls/[] but still stamps when extraction was unavailable", async () => {
    await saveVibeAxes("user-2", null);
    const arg = profileUpdate.mock.calls[0]![0];
    expect(arg.data.energyAxis).toBeNull();
    expect(arg.data.orientationAxis).toBeNull();
    expect(arg.data.socialRole).toBeNull();
    expect(arg.data.anchorTags).toEqual([]);
    expect(arg.data.vibeExtractedAt).toBeInstanceOf(Date);
  });
});
