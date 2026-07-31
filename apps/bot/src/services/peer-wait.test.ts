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

const NOW = new Date("2026-07-30T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("peerWaitLabel — tier ladder", () => {
  // The whole point of the rewrite: the wording is a function of how long this
  // side has been waiting, not of a rotation counter.
  const cases = [
    { elapsed: 0, key: "peerWaitT1Sent" },
    { elapsed: 5 * MIN - 1, key: "peerWaitT1Sent" },
    { elapsed: 5 * MIN, key: "peerWaitT2Waiting" },
    { elapsed: HOUR - 1, key: "peerWaitT2Waiting" },
    { elapsed: HOUR, key: "peerWaitT3Quiet" },
    { elapsed: 6 * HOUR - 1, key: "peerWaitT3Quiet" },
    { elapsed: 6 * HOUR, key: "peerWaitT4Nudged" },
    { elapsed: 24 * HOUR - 1, key: "peerWaitT4Nudged" },
    { elapsed: 24 * HOUR, key: "peerWaitT5Deadline" },
    { elapsed: 40 * HOUR, key: "peerWaitT5Deadline" },
  ] as const;

  it.each(cases)("$elapsed ms into the wait renders $key", ({ elapsed, key }) => {
    expect(peerWaitLabel("en", "Anna", ago(elapsed), NOW)).toBe(t("en", key, { name: "Anna" }));
  });

  it("climbs strictly — every tier is a distinct line", () => {
    const seen = [0, 10 * MIN, 2 * HOUR, 8 * HOUR, 30 * HOUR].map((e) =>
      peerWaitLabel("en", "Anna", ago(e), NOW),
    );
    expect(new Set(seen).size).toBe(5);
  });

  it("treats a missing anchor as tier 1 rather than throwing", () => {
    expect(peerWaitLabel("en", "Anna", null, NOW)).toBe(t("en", "peerWaitT1Sent", { name: "Anna" }));
  });

  it("treats a future anchor as tier 1 (clock skew must not jump to the deadline copy)", () => {
    const future = new Date(NOW.getTime() + HOUR);
    expect(peerWaitLabel("en", "Anna", future, NOW)).toBe(
      t("en", "peerWaitT1Sent", { name: "Anna" }),
    );
  });

  it("interpolates the partner's name", () => {
    const label = peerWaitLabel("ru", "Аня", ago(10 * MIN), NOW);
    expect(label).toContain("Аня");
    expect(label).not.toContain("{name}");
  });

  it("falls back to the anonymous line when there is no name", () => {
    // Substituting a generic noun into the personalised templates breaks case
    // agreement in de/pl, so a nameless partner gets its own sentence.
    for (const empty of [null, undefined, "  "]) {
      expect(peerWaitLabel("de", empty, ago(HOUR), NOW)).toBe(t("de", "peerWaitAnon"));
    }
  });

  it("localises every tier in every language and stays one line", () => {
    for (const lang of ["en", "ru", "uk", "de", "pl"] as const) {
      for (const { elapsed } of cases) {
        const label = peerWaitLabel(lang, "Anna", ago(elapsed), NOW);
        expect(label).not.toContain("{name}");
        expect(label).not.toContain("\n");
        // The thinking block is meant to hold ONE line; anything much longer
        // wraps, which is the bug this rewrite set out to fix.
        expect(label.length).toBeLessThanOrEqual(45);
      }
    }
  });
});

describe("peerWaitLabel — no-overlap variant", () => {
  // The calendar state where the partner DID answer and the two selections just
  // don't intersect. "No word from them yet" / "nudged them" would both be
  // false there, so it gets its own two-step ladder.
  it("uses the dedicated line instead of the default ladder", () => {
    for (const elapsed of [0, 10 * MIN, 2 * HOUR, 8 * HOUR]) {
      expect(peerWaitLabel("en", "Anna", ago(elapsed), NOW, "no_overlap")).toBe(
        t("en", "peerWaitNoOverlap", { name: "Anna" }),
      );
    }
  });

  it("escalates to the deadline line past 24h", () => {
    expect(peerWaitLabel("en", "Anna", ago(25 * HOUR), NOW, "no_overlap")).toBe(
      t("en", "peerWaitNoOverlapLate", { name: "Anna" }),
    );
  });

  it("names the partner, same as the default ladder", () => {
    const label = peerWaitLabel("en", "Anna", ago(HOUR), NOW, "no_overlap");
    expect(label).toContain("Anna");
    expect(label).not.toContain("{name}");
  });

  it("falls back to the shared anonymous line without a partner name", () => {
    // No dedicated no-overlap "anon" line — this edge case is never meant to
    // actually render (firstName is required onboarding), so both variants
    // share peerWaitAnon rather than each carrying its own unused fallback.
    const label = peerWaitLabel("pl", null, ago(HOUR), NOW, "no_overlap");
    expect(label).toBe(t("pl", "peerWaitAnon"));
    expect(label).not.toContain("{name}");
  });
});

describe("issuePeerWaitDraft", () => {
  const base = {
    chatId: 111,
    matchId: "m1",
    side: "A" as const,
    lang: "en" as const,
    partnerName: "Anna",
  };

  it("sends a tg-thinking draft under the stable id", async () => {
    const { api, drafts } = createApi();

    await issuePeerWaitDraft(api, { ...base, startedAt: ago(10 * MIN), now: NOW });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.chat_id).toBe(111);
    expect(drafts[0]!.draft_id).toBe(peerWaitDraftId(111, "m1", "A"));
    expect(drafts[0]!.html).toContain("tg-thinking");
    expect(drafts[0]!.html).toContain("Anna");
  });

  it("carries no glyph at all — the status is plain text", async () => {
    // Founder decision 2026-07-30: a status here describes state, and an icon on
    // it is decoration the state doesn't need; the shimmer already signals
    // "in progress". Guards against a glyph creeping back in via `thinkingHtml`.
    const { api, drafts } = createApi();

    for (const elapsed of [1 * MIN, 30 * HOUR]) {
      await issuePeerWaitDraft(api, { ...base, startedAt: ago(elapsed), now: NOW });
    }

    for (const draft of drafts) {
      expect(draft.html).not.toContain("<tg-emoji");
    }
  });

  it("propagates failure so callers can decide (worker falls back)", async () => {
    const api = {
      raw: { sendRichMessageDraft: vi.fn().mockRejectedValue(new Error("unsupported")) },
    } as never;

    await expect(
      issuePeerWaitDraft(api, { ...base, startedAt: ago(MIN), now: NOW }),
    ).rejects.toThrow();
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

    startPeerWaitShimmer(api, "m1", { userId: "uid-A" });
    await flush();

    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.chat_id).toBe(111); // side A's own chat
    expect(drafts[0]!.html).toContain("Anna"); // …naming the PARTNER
    // …in the ACTOR's language, and always at tier 1: this only fires the
    // instant the user commits. The line is plain text, so it appears verbatim.
    expect(drafts[0]!.html).toContain(t("ru", "peerWaitT1Sent", { name: "Anna" }));
  });

  it("accepts a Telegram id, for the initData Mini App routes", async () => {
    const { api, drafts } = createApi();
    mMatch.findUnique.mockResolvedValue({
      userAId: "uid-A",
      userA: { telegramId: 111n, language: "en", firstName: "Gleb" },
      userB: { telegramId: 222n, language: "en", firstName: "Anna" },
    });

    startPeerWaitShimmer(api, "m1", { telegramId: 222n });
    await flush();

    expect(drafts[0]!.chat_id).toBe(222);
    expect(drafts[0]!.html).toContain("Gleb");
  });

  it("no-ops on an id belonging to neither participant", async () => {
    // Must not degenerate into "not A, therefore B" — that would put the
    // shimmer in the wrong person's chat.
    const { api, drafts } = createApi();
    mMatch.findUnique.mockResolvedValue({
      userAId: "uid-A",
      userA: { telegramId: 111n, language: "en", firstName: "Gleb" },
      userB: { telegramId: 222n, language: "en", firstName: "Anna" },
    });

    startPeerWaitShimmer(api, "m1", { telegramId: 999n });
    await flush();

    expect(drafts).toHaveLength(0);
  });

  it("flips sides correctly for user B", async () => {
    const { api, drafts } = createApi();
    mMatch.findUnique.mockResolvedValue({
      userAId: "uid-A",
      userA: { telegramId: 111n, language: "en", firstName: "Gleb" },
      userB: { telegramId: 222n, language: "en", firstName: "Anna" },
    });

    startPeerWaitShimmer(api, "m1", { userId: "uid-B" });
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

    startPeerWaitShimmer(api, "m1", { userId: "uid-A" });
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

    expect(() => startPeerWaitShimmer(api, "m1", { userId: "uid-A" })).not.toThrow();
    await flush();
  });

  it("no-ops on a match that vanished", async () => {
    const { api, drafts } = createApi();
    mMatch.findUnique.mockResolvedValue(null);

    startPeerWaitShimmer(api, "gone", { userId: "uid-A" });
    await flush();

    expect(drafts).toHaveLength(0);
  });
});
