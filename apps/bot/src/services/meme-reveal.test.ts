import { describe, it, expect, vi, beforeEach } from "vitest";

const prisma = {
  match: { findUnique: vi.fn() },
  profilerAnswer: { findFirst: vi.fn() },
};
vi.mock("@gennety/db", () => ({ prisma }));
vi.mock("../config.js", () => ({ env: { MEME_REVEAL_ENABLED: true } }));
vi.mock("../demo/config.js", () => ({
  DEMO_MODE_ENABLED: false,
  PROTECT_PARTNER_MEDIA: true,
}));

const {
  buildMemeCard,
  deliverMemeReveal,
  memeAnswerFor,
  partnerMemeForViewer,
  resolveMemeSubject,
  sendMemeCard,
} = await import("./meme-reveal.js");

type MemeFixture = Awaited<ReturnType<typeof memeAnswerFor>>;

const MEME = {
  subjectUserId: "u-b",
  subjectFirstName: "Kate",
  fileId: "file-1",
  kind: "photo",
  description: "a cat in a tiny helmet, deadpan absurdist humour",
  sourceUrl: null,
} satisfies NonNullable<MemeFixture>;

/** The same meme, captured from a link — the reveal owes this viewer the video. */
const LINKED_MEME = {
  ...MEME,
  sourceUrl: "https://www.tiktok.com/@u/video/7301234567890123456",
};

function fakeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 2 }),
    sendSticker: vi.fn().mockResolvedValue({ message_id: 3 }),
  };
}
const asApi = (api: ReturnType<typeof fakeApi>) => api as unknown as Parameters<typeof deliverMemeReveal>[0];

beforeEach(() => {
  vi.clearAllMocks();
  prisma.match.findUnique.mockResolvedValue({
    userAId: "u-a",
    userBId: "u-b",
    userA: { id: "u-a", firstName: "Sam" },
    userB: { id: "u-b", firstName: "Kate" },
  });
  prisma.profilerAnswer.findFirst.mockResolvedValue({
    memeFileId: "file-1",
    memeKind: "photo",
    answerText: MEME.description,
    memeSourceUrl: null,
  });
});

describe("resolveMemeSubject — the trust boundary", () => {
  it("resolves the OTHER side of the match", async () => {
    await expect(resolveMemeSubject("m1", "u-a")).resolves.toEqual({
      subjectUserId: "u-b",
      subjectFirstName: "Kate",
    });
  });

  it("finds nothing for someone who is not on the match", async () => {
    // A callback carries a match id and nothing else, so a stranger's tap has
    // to resolve to null here or it resolves to somebody's private answer.
    await expect(resolveMemeSubject("m1", "u-stranger")).resolves.toBeNull();
    await expect(partnerMemeForViewer("m1", "u-stranger")).resolves.toBeNull();
  });
});

describe("memeAnswerFor — a pointer is the consent", () => {
  it("returns the meme when the partner's answer carries a pointer", async () => {
    await expect(memeAnswerFor({ subjectUserId: "u-b", subjectFirstName: "Kate" })).resolves.toEqual(
      MEME,
    );
  });

  it("returns null when the answer has no pointer", async () => {
    // A caption fallback, or an answer typed in words, records no pointer. That
    // is how an image the vision pass refused stays unshowable — and how
    // re-answering in words withdraws consent.
    prisma.profilerAnswer.findFirst.mockResolvedValue(null);
    await expect(
      memeAnswerFor({ subjectUserId: "u-b", subjectFirstName: "Kate" }),
    ).resolves.toBeNull();
  });

  it("only ever reads answers that still carry a pointer", async () => {
    await memeAnswerFor({ subjectUserId: "u-b", subjectFirstName: "Kate" });
    expect(prisma.profilerAnswer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ memeFileId: { not: null }, skipped: false }),
      }),
    );
  });

  it("carries the source URL through when the answer came from a link", async () => {
    prisma.profilerAnswer.findFirst.mockResolvedValue({
      memeFileId: "file-1",
      memeKind: "photo",
      answerText: MEME.description,
      memeSourceUrl: LINKED_MEME.sourceUrl,
    });
    await expect(
      memeAnswerFor({ subjectUserId: "u-b", subjectFirstName: "Kate" }),
    ).resolves.toMatchObject({ sourceUrl: LINKED_MEME.sourceUrl });
  });
});

describe("buildMemeCard — the teaser stays a teaser", () => {
  it("names the person but never the meme", () => {
    const card = buildMemeCard("en", "m1", "Kate");
    expect(card.text).toContain("Kate");
    expect(card.text).not.toContain(MEME.description);
  });

  it("carries no price and routes to the show callback", () => {
    const card = buildMemeCard("en", "m1", "Kate");
    const button = card.keyboard.inline_keyboard[0]![0]!;
    expect(button).toMatchObject({ callback_data: "meme:show:m1" });
    expect(button.text).not.toMatch(/⭐|\d/u);
  });
});

describe("sendMemeCard", () => {
  it("sends the card when the partner has a meme", async () => {
    const api = fakeApi();
    await expect(sendMemeCard(asApi(api), 42, "u-a", "m1", "en")).resolves.toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("stays quiet — not an error — when the partner typed their answer", async () => {
    prisma.profilerAnswer.findFirst.mockResolvedValue(null);
    const api = fakeApi();
    await expect(sendMemeCard(asApi(api), 42, "u-a", "m1", "en")).resolves.toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("sends regardless of whether the VIEWER shared a meme of their own", async () => {
    // No reciprocity gate on purpose: there is no exchange any more, and the
    // person whose meme this is agreed in the question that their match sees it.
    const api = fakeApi();
    await expect(sendMemeCard(asApi(api), 42, "u-a", "m1", "en")).resolves.toBe(true);
    // Only the PARTNER's answer is ever read — the viewer's is never consulted.
    expect(prisma.profilerAnswer.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.profilerAnswer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "u-b" }) }),
    );
  });

  it("never throws when Telegram refuses the card", async () => {
    const api = fakeApi();
    api.sendMessage.mockRejectedValue(new Error("blocked"));
    await expect(sendMemeCard(asApi(api), 42, "u-a", "m1", "en")).resolves.toBe(false);
  });
});

describe("deliverMemeReveal", () => {
  it("sends the picture protected, with the framing caption", async () => {
    const api = fakeApi();
    await expect(deliverMemeReveal(asApi(api), 42, "en", MEME)).resolves.toBe(true);
    expect(api.sendPhoto).toHaveBeenCalledWith(42, "file-1", {
      caption: expect.stringContaining("Kate"),
      protect_content: true,
    });
  });

  it("sends no advice message — that line was cut on purpose", async () => {
    const api = fakeApi();
    await deliverMemeReveal(asApi(api), 42, "en", MEME);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("uses sendSticker for a sticker pointer", async () => {
    // `sendPhoto` with a sticker's file_id fails outright — the stored kind is
    // the only thing that knows the difference.
    const api = fakeApi();
    await deliverMemeReveal(asApi(api), 42, "en", { ...MEME, kind: "sticker" });
    expect(api.sendSticker).toHaveBeenCalledWith(42, "file-1", { protect_content: true });
    expect(api.sendPhoto).not.toHaveBeenCalled();
  });

  it("adds the video link, unformatted, for a link answer", async () => {
    const api = fakeApi();
    await expect(deliverMemeReveal(asApi(api), 42, "en", LINKED_MEME)).resolves.toBe(true);
    const [chatId, body, options] = api.sendMessage.mock.calls.at(-1)!;
    expect(chatId).toBe(42);
    expect(body).toContain(LINKED_MEME.sourceUrl);
    // No parse_mode: an Instagram shortcode can carry `_`.
    expect(options).toBeUndefined();
  });

  it("still gives the link when the cover frame will not send", async () => {
    // The path where the link matters most — the only way left to see the thing.
    const api = fakeApi();
    api.sendPhoto.mockRejectedValue(new Error("wrong file identifier"));
    await expect(deliverMemeReveal(asApi(api), 42, "en", LINKED_MEME)).resolves.toBe(true);
    expect(api.sendMessage.mock.calls.at(-1)![1]).toContain("tiktok.com");
  });

  it("falls back to the description when there is no picture and no link", async () => {
    const api = fakeApi();
    api.sendPhoto.mockRejectedValue(new Error("wrong file identifier"));
    await expect(deliverMemeReveal(asApi(api), 42, "en", MEME)).resolves.toBe(true);
    expect(api.sendMessage.mock.calls[0]![1]).toContain(MEME.description);
  });

  it("reports failure only when the viewer got nothing at all", async () => {
    const api = fakeApi();
    api.sendPhoto.mockRejectedValue(new Error("blocked"));
    api.sendMessage.mockRejectedValue(new Error("blocked"));
    await expect(deliverMemeReveal(asApi(api), 42, "en", MEME)).resolves.toBe(false);
  });
});
