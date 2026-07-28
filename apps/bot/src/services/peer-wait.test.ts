import { describe, it, expect, vi, beforeEach } from "vitest";
import { t } from "@gennety/shared";

vi.mock("../config.js", () => ({
  env: { CUSTOM_EMOJI_THINKING_ID: "" },
}));

vi.mock("@gennety/db", () => ({
  prisma: { match: { findUnique: vi.fn() } },
}));

import { prisma } from "@gennety/db";
import {
  issuePeerWaitDraft,
  peerWaitDraftId,
  peerWaitLabel,
  startPeerWaitShimmer,
} from "./peer-wait.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findUnique: MockFn };

function createApi() {
  const drafts: Array<{ chat_id: number; draft_id: number; html?: string }> = [];
  return {
    api: {
      raw: {
        sendRichMessageDraft: vi.fn(
          async (p: {
            chat_id: number;
            draft_id: number;
            rich_message: { html?: string };
          }) => {
            drafts.push({ chat_id: p.chat_id, draft_id: p.draft_id, ...p.rich_message });
            return true as const;
          },
        ),
      },
    } as never,
    drafts,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mMatch.findUnique.mockReset();
});

describe("peerWaitDraftId", () => {
  it("is stable for the same (chat, match, side)", () => {
    // Stability is the whole point: an id that changed per tick would start a
    // NEW draft every 20s instead of refreshing the one on screen.
    expect(peerWaitDraftId(111, "m1", "A")).toBe(peerWaitDraftId(111, "m1", "A"));
  });

  it("differs per side and per match", () => {
    expect(peerWaitDraftId(111, "m1", "A")).not.toBe(peerWaitDraftId(111, "m1", "B"));
    expect(peerWaitDraftId(111, "m1", "A")).not.toBe(peerWaitDraftId(111, "m2", "A"));
  });

  it("stays a valid non-zero int32", () => {
    for (const chatId of [1, 782065541, -1001234567890]) {
      const id = peerWaitDraftId(chatId, "abc-def", "B");
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThan(0x7fffffff);
    }
  });
});

describe("peerWaitLabel", () => {
  it("rotates through the three phrasings so a long wait never reads frozen", () => {
    const seen = [0, 1, 2].map((i) => peerWaitLabel("en", "Anna", i));
    expect(new Set(seen).size).toBe(3);
    expect(peerWaitLabel("en", "Anna", 3)).toBe(seen[0]);
  });

  it("interpolates the partner's name", () => {
    expect(peerWaitLabel("ru", "Аня", 0)).toContain("Аня");
    expect(peerWaitLabel("ru", "Аня", 0)).not.toContain("{name}");
  });

  it("falls back to the anonymous line when there is no name", () => {
    // Substituting a generic noun into the personalised templates breaks case
    // agreement in de/pl, so a nameless partner gets its own sentence.
    for (const empty of [null, undefined, "  "]) {
      expect(peerWaitLabel("de", empty, 0)).toBe(t("de", "peerWaitLoopAnon"));
    }
  });

  it("localises every rotation in every language", () => {
    for (const lang of ["en", "ru", "uk", "de", "pl"] as const) {
      for (let i = 0; i < 3; i++) {
        const label = peerWaitLabel(lang, "Anna", i);
        expect(label).not.toContain("{name}");
        expect(label.length).toBeGreaterThan(0);
      }
    }
  });

  it("tolerates a negative or fractional rotation index", () => {
    expect(() => peerWaitLabel("en", "Anna", -7)).not.toThrow();
    expect(() => peerWaitLabel("en", "Anna", 2.9)).not.toThrow();
  });
});

describe("issuePeerWaitDraft", () => {
  it("sends a tg-thinking draft under the stable id", async () => {
    const { api, drafts } = createApi();

    await issuePeerWaitDraft(api, 111, "m1", "A", "en", "Anna", 0);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.chat_id).toBe(111);
    expect(drafts[0]!.draft_id).toBe(peerWaitDraftId(111, "m1", "A"));
    expect(drafts[0]!.html).toContain("tg-thinking");
    expect(drafts[0]!.html).toContain("Anna");
  });

  it("propagates failure so callers can decide (worker falls back)", async () => {
    const api = {
      raw: { sendRichMessageDraft: vi.fn().mockRejectedValue(new Error("unsupported")) },
    } as never;

    await expect(issuePeerWaitDraft(api, 111, "m1", "A", "en", "Anna", 0)).rejects.toThrow();
  });
});

describe("startPeerWaitShimmer", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("resolves the side, language and partner name from the match", async () => {
    const { api, drafts } = createApi();
    mMatch.findUnique.mockResolvedValue({
      userAId: "uid-A",
      userA: { telegramId: 111n, language: "ru", firstName: "Глеб" },
      userB: { telegramId: 222n, language: "en", firstName: "Anna" },
    });

    startPeerWaitShimmer(api, "m1", "uid-A");
    await flush();

    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.chat_id).toBe(111); // side A's own chat
    expect(drafts[0]!.html).toContain("Anna"); // …naming the PARTNER
    // …in the ACTOR's language. The leading glyph is swapped for an animated
    // <tg-emoji>, so match on the words after it.
    const ruPrefix = t("ru", "peerWaitLoop1").split("{name}")[0]!.split(" ").slice(1).join(" ");
    expect(drafts[0]!.html).toContain(ruPrefix.trim());
  });

  it("flips sides correctly for user B", async () => {
    const { api, drafts } = createApi();
    mMatch.findUnique.mockResolvedValue({
      userAId: "uid-A",
      userA: { telegramId: 111n, language: "en", firstName: "Gleb" },
      userB: { telegramId: 222n, language: "en", firstName: "Anna" },
    });

    startPeerWaitShimmer(api, "m1", "uid-B");
    await flush();

    expect(drafts[0]!.chat_id).toBe(222);
    expect(drafts[0]!.html).toContain("Gleb");
  });

  it("skips a mobile-only user (synthetic negative telegramId)", async () => {
    const { api, drafts } = createApi();
    mMatch.findUnique.mockResolvedValue({
      userAId: "uid-A",
      userA: { telegramId: -42n, language: "en", firstName: "Gleb" },
      userB: { telegramId: 222n, language: "en", firstName: "Anna" },
    });

    startPeerWaitShimmer(api, "m1", "uid-A");
    await flush();

    expect(drafts).toHaveLength(0);
  });

  it("never throws — a failed draft must not break the flow it decorates", async () => {
    const api = {
      raw: { sendRichMessageDraft: vi.fn().mockRejectedValue(new Error("unsupported")) },
    } as never;
    mMatch.findUnique.mockResolvedValue({
      userAId: "uid-A",
      userA: { telegramId: 111n, language: "en", firstName: "Gleb" },
      userB: { telegramId: 222n, language: "en", firstName: "Anna" },
    });

    expect(() => startPeerWaitShimmer(api, "m1", "uid-A")).not.toThrow();
    await flush();
  });

  it("no-ops on a match that vanished", async () => {
    const { api, drafts } = createApi();
    mMatch.findUnique.mockResolvedValue(null);

    startPeerWaitShimmer(api, "gone", "uid-A");
    await flush();

    expect(drafts).toHaveLength(0);
  });
});
