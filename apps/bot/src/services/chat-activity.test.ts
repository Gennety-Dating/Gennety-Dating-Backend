import { describe, expect, it, vi } from "vitest";

const env = { OPENAI_API_KEY: "k", WISHLIST_FEATURE_ENABLED: true };
vi.mock("../config.js", () => ({ env }));
vi.mock("@gennety/db", () => ({ prisma: {}, Prisma: {} }));

const { turnTools } = await import("./chat-agent.js");
const { CHAT_ACTIVITY_STEPS, CHAT_TOOL_STEPS, ChatActivityStore, stepForTool } = await import("./chat-activity.js");

describe("stepForTool", () => {
  it("places every tool the chat agent can be given, and nothing else", () => {
    const declared = turnTools({ wishlistCards: true, offerCards: true, guideCards: true, screenshotCards: true }).map(
      (tool) => tool.function.name,
    );
    expect(declared.length).toBeGreaterThan(30);
    expect([...CHAT_TOOL_STEPS.keys()].sort()).toEqual([...declared].sort());
  });

  it("uses only keys of the contract", () => {
    for (const step of CHAT_TOOL_STEPS.values()) expect(CHAT_ACTIVITY_STEPS).toContain(step);
  });

  it.each([
    ["search_screenshots", "screenshots"],
    ["read_screenshot", "screenshots"],
    ["show_screenshots", "screenshots"],
    ["get_my_wishlist", "wishlist"],
    ["propose_wishlist_items", "wishlist"],
    ["search_past_chats", "past_chats"],
    ["read_past_chat", "past_chats"],
    ["get_my_profile", "profile"],
    ["update_profile", "profile"],
    ["attach_profile_photo", "profile"],
    ["review_my_photos", "profile"],
    ["explain_my_match", "date"],
    ["propose_venue_change", "date"],
    ["propose_cancel_date", "date"],
    ["get_my_standing", "date"],
  ])("%s is %s", (name, step) => {
    expect(stepForTool(name)).toBe(step);
  });

  it("falls back to thinking, including for names on Object.prototype", () => {
    expect(stepForTool("no_such_tool")).toBe("thinking");
    expect(stepForTool("constructor")).toBe("thinking");
  });
});

describe("ChatActivityStore", () => {
  it("starts on thinking at seq 1 and counts changes, not repeats", () => {
    const store = new ChatActivityStore();
    const turn = store.begin("u1", "client-id-1");
    expect(store.read("u1", "client-id-1")).toEqual({ step: "thinking", seq: 1 });
    turn.report("web");
    expect(store.read("u1", "client-id-1")).toEqual({ step: "web", seq: 2 });
    turn.report("web");
    expect(store.read("u1", "client-id-1")).toEqual({ step: "web", seq: 2 });
    turn.report("thinking");
    expect(store.read("u1", "client-id-1")).toEqual({ step: "thinking", seq: 3 });
  });

  it("answers nothing for an unknown id, a missing id and someone else's id", () => {
    const store = new ChatActivityStore();
    store.begin("u1", "client-id-1");
    const nothing = { step: null, seq: 0 };
    expect(store.read("u1", "client-id-2")).toEqual(nothing);
    expect(store.read("u1", null)).toEqual(nothing);
    expect(store.read("u2", "client-id-1")).toEqual(nothing);
  });

  it("forgets a finished turn, and a late report does not bring it back", () => {
    const store = new ChatActivityStore();
    const turn = store.begin("u1", "client-id-1");
    turn.finish();
    expect(store.read("u1", "client-id-1")).toEqual({ step: null, seq: 0 });
    turn.report("writing");
    expect(store.read("u1", "client-id-1")).toEqual({ step: null, seq: 0 });
  });

  it("does not let an old turn finish a newer one under the same id", () => {
    const store = new ChatActivityStore();
    const first = store.begin("u1", "client-id-1");
    store.begin("u1", "client-id-1");
    first.finish();
    expect(store.read("u1", "client-id-1")).toEqual({ step: "thinking", seq: 1 });
  });

  it("expires a stuck turn, each report extending it, without seq going back", () => {
    let clock = 0;
    const store = new ChatActivityStore({ ttlMs: 100, now: () => clock });
    const turn = store.begin("u1", "client-id-1");
    clock = 99;
    turn.report("web");
    clock = 198;
    expect(store.read("u1", "client-id-1")).toEqual({ step: "web", seq: 2 });
    clock = 199;
    expect(store.read("u1", "client-id-1")).toEqual({ step: null, seq: 0 });
    turn.report("writing");
    expect(store.read("u1", "client-id-1")).toEqual({ step: "writing", seq: 3 });
  });

  it("stays bounded", () => {
    const store = new ChatActivityStore({ maxEntries: 2 });
    store.begin("u1", "client-id-1");
    store.begin("u1", "client-id-2");
    store.begin("u1", "client-id-3");
    expect(store.read("u1", "client-id-1")).toEqual({ step: null, seq: 0 });
    expect(store.read("u1", "client-id-3")).toEqual({ step: "thinking", seq: 1 });
  });
});
