import { beforeEach, describe, expect, it, vi } from "vitest";

const env = { OPENAI_API_KEY: "test-key" };
vi.mock("../config.js", () => ({ env }));
const fetchConsent = vi.fn();
vi.mock("./openai-fetch.js", () => ({ openaiFetch: (...args: unknown[]) => fetchConsent(...args) }));
const { personConsented } = await import("./chat-consent.js");

const question = {
  previous: "Another 13 is already on your wishlist",
  message: "ну тогда удали его",
  tool: "remove_wishlist_item",
  args: { itemId: "w1", item: { title: "Another 13", brand: "Le Labo" } },
};
const response = (content: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

beforeEach(() => {
  env.OPENAI_API_KEY = "test-key";
  fetchConsent.mockReset();
});

describe("wishlist removal authorization", () => {
  it("uses the removal-specific check with the named previous item", async () => {
    fetchConsent.mockResolvedValue(response('{"consent":true}'));
    expect(await personConsented(question)).toBe(true);
    const body = JSON.parse(fetchConsent.mock.calls[0]![1].body);
    expect(body.messages[0].content).toContain("this exact wishlist item");
    expect(body.messages[1].content).toContain("Another 13");
  });

  it.each(['{"consent":false}', '{}', '{"consent":"true"}', 'not JSON'])("refuses an absent/invalid positive answer: %s", async content => {
    fetchConsent.mockResolvedValue(response(content));
    expect(await personConsented(question)).toBe(false);
  });

  it("refuses removal if the provider is unavailable", async () => {
    fetchConsent.mockResolvedValueOnce({ ok: false, status: 503 });
    expect(await personConsented(question)).toBe(false);
    fetchConsent.mockRejectedValueOnce(new Error("timeout"));
    expect(await personConsented(question)).toBe(false);
    env.OPENAI_API_KEY = "";
    expect(await personConsented(question)).toBe(false);
  });

  it("preserves the existing profile-write fallback", async () => {
    fetchConsent.mockResolvedValueOnce({ ok: false, status: 503 });
    expect(await personConsented({ ...question, tool: "update_hobbies" })).toBe(true);
  });
});
