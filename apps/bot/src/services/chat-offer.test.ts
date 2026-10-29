import { describe, expect, it, vi } from "vitest";

/**
 * The change-offer card (decision journal 2026-10-28): what `offer_change`
 * accepts, how the tap runs exactly the stored change, idempotency, and one
 * open offer at a time. The turn around it is tested in
 * `chat-agent-offer.test.ts`, the route in `chat-offer-route.test.ts`.
 */

vi.mock("../config.js", () => ({ env: { OPENAI_API_KEY: "k" } }));
vi.mock("@gennety/db", () => ({ prisma: {} }));

const {
  buildChangeOffer,
  changeOfferNote,
  changeOfferView,
  expireOlderOffers,
  markOfferAccepted,
  readChangeOffer,
  resolveChangeOffer,
  validateOfferArgs,
} = await import("./chat-offer.js");
type ChangeOffer = import("./chat-offer.js").ChangeOffer;
type ResolveOfferDeps = import("./chat-offer.js").ResolveOfferDeps;

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const MSG = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-28T10:00:00Z");

const openOffer: ChangeOffer = {
  kind: "change_offer",
  state: "open",
  question: "Добавить «парфюмерия» в интересы?",
  acceptLabel: "Добавить",
  tool: "update_hobbies",
  args: { add: ["парфюмерия"] },
};

/** An in-memory `messages` table: rowId → { owner, attachment }. */
function store(rows: Record<string, { userId: string; attachment: unknown }>) {
  const execute = vi.fn<ResolveOfferDeps["execute"]>(async () => ({ ok: true, receipt: "Интересы обновлены", error: null }));
  const deps: ResolveOfferDeps = {
    findRow: async (userId, id) => (rows[id] && rows[id].userId === userId ? { attachment: rows[id].attachment } : null),
    saveOffer: async (id, offer) => {
      rows[id]!.attachment = offer;
    },
    openOfferRows: async (userId) =>
      Object.entries(rows)
        .filter(([, row]) => row.userId === userId && readChangeOffer(row.attachment)?.state === "open")
        .map(([id]) => ({ id })),
    execute,
  };
  return { rows, deps, execute };
}

describe("validateOfferArgs — the executors' rules, before a card is shown", () => {
  it("accepts and normalizes each gated tool", () => {
    expect(validateOfferArgs("update_hobbies", { add: [" парфюмерия "] })).toEqual({ ok: true, args: { add: ["парфюмерия"] } });
    expect(validateOfferArgs("update_age_range", { min_age: 24, max_age: 30 })).toEqual({ ok: true, args: { min_age: 24, max_age: 30 } });
    expect(validateOfferArgs("update_bio", { bio: " люблю джаз " })).toEqual({ ok: true, args: { bio: "люблю джаз" } });
    expect(validateOfferArgs("update_profile", { height: 180, junk: 1 })).toEqual({ ok: true, args: { height: 180 } });
  });

  it("refuses what the tool would refuse", () => {
    expect(validateOfferArgs("set_language", { language: "en" }).ok).toBe(false);
    expect(validateOfferArgs("update_hobbies", {}).ok).toBe(false);
    expect(validateOfferArgs("update_hobbies", { add: ["  "] }).ok).toBe(false);
    expect(validateOfferArgs("update_age_range", { min_age: 30, max_age: 24 }).ok).toBe(false);
    expect(validateOfferArgs("update_bio", { bio: "" }).ok).toBe(false);
    expect(validateOfferArgs("update_profile", { height: 300 }).ok).toBe(false);
    expect(validateOfferArgs("update_profile", {}).ok).toBe(false);
    expect(validateOfferArgs("update_major", "x").ok).toBe(false);
  });
});

describe("buildChangeOffer", () => {
  it("builds an open offer and tells the model not to ask in words", () => {
    const built = buildChangeOffer({ tool: "update_hobbies", args: { add: ["парфюмерия"] }, question: "Добавить «парфюмерия» в интересы?", acceptLabel: "Добавить" }, "ru");
    expect(built.offer).toEqual(openOffer);
    const result = JSON.parse(built.result) as { success: boolean; instruction: string };
    expect(result.success).toBe(true);
    expect(result.instruction).toContain("do NOT ask the question in words");
  });

  it("defaults the button to a localized yes, and to it for a long label", () => {
    expect(buildChangeOffer({ tool: "update_major", args: { major: "CS" }, question: "Поставить «CS»?" }, "ru").offer?.acceptLabel).toBe("Да");
    expect(buildChangeOffer({ tool: "update_major", args: { major: "CS" }, question: "Set «CS»?", acceptLabel: "yes please do it" }, "en").offer?.acceptLabel).toBe("Yes");
  });

  it("refuses a long question, no question, or bad args — back to the model", () => {
    const long = buildChangeOffer({ tool: "update_major", args: { major: "CS" }, question: "x".repeat(91) }, "ru");
    expect(long.offer).toBeNull();
    expect(JSON.parse(long.result)).toMatchObject({ success: false, error: "question_too_long" });
    expect(buildChangeOffer({ tool: "update_major", args: { major: "CS" } }, "ru").offer).toBeNull();
    expect(JSON.parse(buildChangeOffer({ tool: "update_age_range", args: { min_age: 5, max_age: 9 }, question: "?" }, "ru").result)).toMatchObject({ error: "invalid_args" });
  });
});

describe("reading and showing", () => {
  it("a wishlist card or junk is not an offer", () => {
    expect(readChangeOffer({ kind: "wishlist_proposal", items: [] })).toBeNull();
    expect(readChangeOffer(null)).toBeNull();
    expect(readChangeOffer(openOffer)).toEqual(openOffer);
  });

  it("the view hides the tool and args", () => {
    expect(changeOfferView({ ...openOffer, state: "accepted", receipt: "Интересы обновлены" })).toEqual({
      state: "accepted",
      question: openOffer.question,
      acceptLabel: "Добавить",
      receipt: "Интересы обновлены",
    });
    expect(changeOfferView(openOffer).receipt).toBeNull();
  });

  it("the model's note carries the question and the state", () => {
    expect(changeOfferNote(openOffer)).toContain("«Добавить «парфюмерия» в интересы?»");
    expect(changeOfferNote(openOffer)).toContain("Not answered yet");
    expect(changeOfferNote({ ...openOffer, state: "declined" })).toContain("Don't offer this again");
    expect(changeOfferNote({ ...openOffer, state: "accepted", receipt: "Интересы обновлены" })).toContain("Интересы обновлены");
    expect(changeOfferNote({ ...openOffer, state: "expired" })).toContain("Replaced by a later offer");
  });
});

describe("resolveChangeOffer — the tap", () => {
  it("accept runs exactly the stored tool and args, and stores the receipt", async () => {
    const { rows, deps, execute } = store({ [MSG]: { userId: USER, attachment: { ...openOffer } } });
    const result = await resolveChangeOffer(USER, MSG, "accept", deps, NOW);
    expect(execute).toHaveBeenCalledWith(USER, "update_hobbies", { add: ["парфюмерия"] });
    expect(result).toMatchObject({ ok: true, offer: { state: "accepted", receipt: "Интересы обновлены" } });
    expect(readChangeOffer(rows[MSG]!.attachment)).toMatchObject({ state: "accepted", resolvedAt: NOW.toISOString() });
  });

  it("decline changes nothing but the state", async () => {
    const { rows, deps, execute } = store({ [MSG]: { userId: USER, attachment: { ...openOffer } } });
    const result = await resolveChangeOffer(USER, MSG, "decline", deps, NOW);
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, offer: { state: "declined" } });
    expect(readChangeOffer(rows[MSG]!.attachment)?.state).toBe("declined");
  });

  it("is idempotent: a double tap runs the change once", async () => {
    const { deps, execute } = store({ [MSG]: { userId: USER, attachment: { ...openOffer } } });
    const [a, b] = await Promise.all([
      resolveChangeOffer(USER, MSG, "accept", deps, NOW),
      resolveChangeOffer(USER, MSG, "accept", deps, NOW),
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ ok: true, offer: { state: "accepted" } });
    expect(b).toMatchObject({ ok: true, offer: { state: "accepted" } });
  });

  it("an answered or expired offer answers its state unchanged", async () => {
    for (const state of ["declined", "expired", "accepted"] as const) {
      const { deps, execute } = store({ [MSG]: { userId: USER, attachment: { ...openOffer, state } } });
      const result = await resolveChangeOffer(USER, MSG, "accept", deps, NOW);
      expect(result).toMatchObject({ ok: true, offer: { state } });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("a refused change stays open, with the executor's message", async () => {
    const { rows, deps, execute } = store({ [MSG]: { userId: USER, attachment: { ...openOffer } } });
    execute.mockResolvedValueOnce({ ok: false, receipt: null, error: "The list holds 12 interests" });
    const result = await resolveChangeOffer(USER, MSG, "accept", deps, NOW);
    expect(result).toEqual({ ok: false, error: "change-failed", message: "The list holds 12 interests" });
    expect(readChangeOffer(rows[MSG]!.attachment)?.state).toBe("open");
  });

  it("someone else's message, or a reply without an offer, is not found", async () => {
    const { deps, execute } = store({
      [MSG]: { userId: OTHER, attachment: { ...openOffer } },
      other: { userId: USER, attachment: { kind: "wishlist_proposal", state: "open", items: [] } },
    });
    expect(await resolveChangeOffer(USER, MSG, "accept", deps, NOW)).toEqual({ ok: false, error: "not-found" });
    expect(await resolveChangeOffer(USER, "other", "accept", deps, NOW)).toEqual({ ok: false, error: "not-found" });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("one open offer at a time", () => {
  it("a newer offer expires the older open ones of this user, and only those", async () => {
    const { rows, deps, execute } = store({
      old1: { userId: USER, attachment: { ...openOffer } },
      old2: { userId: USER, attachment: { ...openOffer, state: "declined" } },
      foreign: { userId: OTHER, attachment: { ...openOffer } },
      fresh: { userId: USER, attachment: { ...openOffer } },
    });
    await expireOlderOffers(USER, "fresh", deps, NOW);
    expect(readChangeOffer(rows.old1!.attachment)?.state).toBe("expired");
    expect(readChangeOffer(rows.old2!.attachment)?.state).toBe("declined");
    expect(readChangeOffer(rows.foreign!.attachment)?.state).toBe("open");
    expect(readChangeOffer(rows.fresh!.attachment)?.state).toBe("open");

    // Its buttons no longer run anything.
    expect(await resolveChangeOffer(USER, "old1", "accept", deps, NOW)).toMatchObject({ ok: true, offer: { state: "expired" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("a typed yes marks the open offer accepted with the receipt", async () => {
    const { rows, deps } = store({ [MSG]: { userId: USER, attachment: { ...openOffer } } });
    await markOfferAccepted(USER, MSG, "Интересы обновлены", deps, NOW);
    expect(readChangeOffer(rows[MSG]!.attachment)).toMatchObject({ state: "accepted", receipt: "Интересы обновлены" });
    // A declined card is not turned into an accepted one.
    rows[MSG]!.attachment = { ...openOffer, state: "declined" };
    await markOfferAccepted(USER, MSG, "x", deps, NOW);
    expect(readChangeOffer(rows[MSG]!.attachment)?.state).toBe("declined");
  });
});
