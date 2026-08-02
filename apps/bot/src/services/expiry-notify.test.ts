import { describe, it, expect, vi, beforeEach } from "vitest";

const renderExpiryCard = vi.fn();
// Mocked so the decision matrix below is tested without paying for a real
// satori + resvg rasterize per case (and so the null branch — the plain-text
// fallback — is reachable at all).
vi.mock("./expiry-card.js", () => ({ renderExpiryCard }));

const { sendExpiryNotifications, buildCard } = await import("./expiry-notify.js");
import type { MatchExpiry, SideClassification } from "./match-expiry.js";

interface FakeApi {
  sendMessage: ReturnType<typeof vi.fn>;
  sendPhoto: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
}

function makeApi(): FakeApi {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue({ message_id: 1 }),
  };
}

function side(overrides: Partial<SideClassification>): SideClassification {
  const base: SideClassification = {
    side: "A",
    userId: "user-a",
    telegramId: 100n,
    language: "en",
    theme: "dark",
    pitchMessageId: 11,
    role: "silent",
    offenseCount: 1,
    penalised: false,
    peerAccepted: null,
    accepted: null,
    ...overrides,
  };
  // `accepted` and `role` are two views of the same fact, so the factory keeps
  // them consistent unless a case sets `accepted` explicitly: a silent side
  // decided nothing, a responder decided something (defaulting to the accepted
  // side, which is what every pre-existing responder case here means).
  if (overrides.accepted === undefined) {
    base.accepted = base.role === "responder" ? true : null;
  }
  return base;
}

function matchWith(...sides: SideClassification[]): MatchExpiry {
  return { matchId: "m-1", sides };
}

/** What `buildCard` handed the renderer for this side. */
async function cardFor(s: SideClassification, lang: "en" | "ru" = "en") {
  renderExpiryCard.mockResolvedValue(Buffer.from("png"));
  const built = await buildCard(s, lang);
  return { input: renderExpiryCard.mock.calls.at(-1)![0], caption: built!.caption };
}

beforeEach(() => {
  vi.clearAllMocks();
  renderExpiryCard.mockResolvedValue(Buffer.from("png"));
});

describe("expiry card selection (PRODUCT_SPEC §3.4)", () => {
  it("first-offense silent → `expired` card + warning caption", async () => {
    const { input, caption } = await cardFor(
      side({ role: "silent", offenseCount: 1, penalised: false }),
    );
    expect(input.variant).toBe("expired");
    expect(caption).toMatch(/Next time we'll lower your rating/i);
  });

  it("repeat-offense silent → `penalty` card + penalty caption", async () => {
    const { input, caption } = await cardFor(
      side({ role: "silent", offenseCount: 3, penalised: true }),
    );
    expect(input.variant).toBe("penalty");
    expect(caption).toMatch(/Ignoring proposals is disrespectful/i);
  });

  it("responder → `peer_ignored` card, and nothing promises a priority boost", async () => {
    // `match-expiry.ts` does not call `boostAcceptedSidePriority` (unlike the
    // decline path and the §3.5c stall chain), so claiming one here would be a
    // promise the code does not keep.
    const { input, caption } = await cardFor(side({ role: "responder" }));
    expect(input.variant).toBe("peer_ignored");
    expect(caption).toMatch(/next drop/i);
    expect(caption).not.toMatch(/priority|boost/i);
    expect(input.subline).not.toMatch(/priority|boost/i);
  });

  // EXPIRY-COPY-1. A first decision leaves the row `proposed` whichever way it
  // went (§3.4), so someone who PASSED and whose partner then went silent
  // arrives here as an ordinary `responder` — indistinguishable, before this,
  // from someone who accepted and got stood up. They were consoled for losing
  // a date they had turned down.
  describe("a side that declined", () => {
    const decliner = () => side({ role: "responder", accepted: false });

    it("gets no card at all", async () => {
      renderExpiryCard.mockResolvedValue(Buffer.from("png"));
      const built = await buildCard(decliner(), "en");
      expect(built).toBeNull();
      // Not merely discarded — never rendered. The card family is for §3.4's
      // emotional beats and this is not one of them.
      expect(renderExpiryCard).not.toHaveBeenCalled();
    });

    it("gets the bare closing line, with no consolation and no blame", async () => {
      const api = makeApi();
      await sendExpiryNotifications(api as never, [matchWith(decliner())], 0);

      expect(api.sendPhoto).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      const [, body] = api.sendMessage.mock.calls[0]!;
      expect(body).toMatch(/you passed/i);
      expect(body).toMatch(/next drop/i);
      // The peer-ignored copy is written for the opposite person.
      expect(body).not.toMatch(/didn't reply|never answered|done on time/i);
    });

    it("still leaves the accepted side its own peer_ignored card", async () => {
      // Both sides of one match: A passed, B accepted and was ghosted by
      // nobody — B is the silent one here. The point is only that the
      // decliner's branch does not swallow the other side's treatment.
      const api = makeApi();
      await sendExpiryNotifications(
        api as never,
        [
          matchWith(
            decliner(),
            side({
              side: "B",
              userId: "user-b",
              telegramId: 200n,
              role: "responder",
              accepted: true,
            }),
          ),
        ],
        0,
      );
      expect(api.sendMessage).toHaveBeenCalledTimes(1); // the decliner
      expect(api.sendPhoto).toHaveBeenCalledTimes(1); // the accepted responder
    });
  });

  it("silent + peer ACCEPTED → `missed_date` card", async () => {
    const { input } = await cardFor(
      side({ role: "silent", offenseCount: 1, penalised: false, peerAccepted: true }),
    );
    expect(input.variant).toBe("missed_date");
    expect(input.headline).toMatch(/MUTUAL/i);
  });

  it("`missed_date` overrides the card but the caption still carries the penalty", async () => {
    // The override is visual only: a repeat offender who ghosted an accepting
    // partner must still be told their rating moved.
    const { input, caption } = await cardFor(
      side({ role: "silent", offenseCount: 4, penalised: true, peerAccepted: true }),
    );
    expect(input.variant).toBe("missed_date");
    expect(caption).toMatch(/Ignoring proposals is disrespectful/i);
  });

  it("silent + peer DECLINED → stays `expired` (blind-decision)", async () => {
    const { input } = await cardFor(
      side({ role: "silent", offenseCount: 1, penalised: false, peerAccepted: false }),
    );
    expect(input.variant).toBe("expired");
  });

  it("a failed Elo write keeps the warning card even at a high offense count", async () => {
    // Defensive: never draw "RATING LOWERED" over a deduction that didn't land.
    const { input, caption } = await cardFor(
      side({ role: "silent", offenseCount: 5, penalised: false }),
    );
    expect(input.variant).toBe("expired");
    expect(caption).toMatch(/Next time we'll lower your rating/i);
    expect(caption).not.toMatch(/has been lowered/i);
  });

  it("renders in the recipient's own theme", async () => {
    expect((await cardFor(side({ theme: "light" }))).input.theme).toBe("light");
    expect((await cardFor(side({ theme: "dark" }))).input.theme).toBe("dark");
    // `User.theme` defaults to dark, so a legacy null row is dark, not a crash.
    expect((await cardFor(side({ theme: null }))).input.theme).toBe("dark");
  });

  it("localizes the card copy, not just the caption", async () => {
    const { input } = await cardFor(side({ role: "silent", language: "ru" }), "ru");
    expect(input.headline).toBe("ВРЕМЯ\nВЫШЛО");
  });
});

describe("sendExpiryNotifications", () => {
  it("sends the card as a photo and clears the pitch keyboard", async () => {
    const api = makeApi();
    const m = matchWith(
      side({ side: "A", role: "silent", offenseCount: 1, penalised: false }),
      side({
        side: "B",
        userId: "user-b",
        telegramId: 200n,
        language: "ru",
        pitchMessageId: 22,
        role: "responder",
      }),
    );

    const r = await sendExpiryNotifications(api as never, [m], 0);

    expect(r.notified).toBe(2);
    expect(r.failed).toBe(0);
    expect(api.sendPhoto).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).not.toHaveBeenCalled();

    // Keyboard cleared on both sides.
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    for (const opts of api.editMessageText.mock.calls.map((c) => c[3])) {
      expect(opts.reply_markup).toEqual({ inline_keyboard: [] });
    }

    const captionToA = api.sendPhoto.mock.calls.find((c) => c[0] === 100)![2].caption;
    expect(captionToA).toMatch(/Next time we'll lower your rating/i);
    const captionToB = api.sendPhoto.mock.calls.find((c) => c[0] === 200)![2].caption;
    expect(captionToB).toMatch(/Увидимся в следующем дропе/i);
  });

  it("degrades to the full plain-text notice when the render fails", async () => {
    // The fallback must be self-sufficient: everything the card+caption pair
    // says has to survive on this branch, since it is the whole message.
    renderExpiryCard.mockResolvedValue(null);
    const api = makeApi();
    const m = matchWith(
      side({ role: "silent", offenseCount: 1, penalised: false, peerAccepted: true }),
    );

    const r = await sendExpiryNotifications(api as never, [m], 0);

    expect(r.notified).toBe(1);
    expect(api.sendPhoto).not.toHaveBeenCalled();
    const sent = api.sendMessage.mock.calls[0]![1];
    expect(sent).toMatch(/you missed a real date/i);
    expect(sent).toMatch(/Next time we'll lower your rating/i);
  });

  it("keeps the neutral text on the fallback when the peer declined", async () => {
    renderExpiryCard.mockResolvedValue(null);
    const api = makeApi();
    const m = matchWith(side({ role: "silent", peerAccepted: false }));

    await sendExpiryNotifications(api as never, [m], 0);

    const sent = api.sendMessage.mock.calls[0]![1];
    expect(sent).not.toMatch(/missed a real date/i);
  });

  it("skips mobile-only sides (negative telegramId) and continues", async () => {
    const api = makeApi();
    const m = matchWith(
      side({ side: "A", telegramId: -42n, role: "silent" }),
      side({
        side: "B",
        userId: "user-b",
        telegramId: 200n,
        language: "en",
        pitchMessageId: 22,
        role: "responder",
      }),
    );

    const r = await sendExpiryNotifications(api as never, [m], 0);

    expect(r.notified).toBe(1);
    expect(r.skipped).toBe(1);
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto.mock.calls[0]![0]).toBe(200);
  });

  it("does not edit pitch when pitchMessageId is null", async () => {
    const api = makeApi();
    const m = matchWith(side({ pitchMessageId: null }));

    await sendExpiryNotifications(api as never, [m], 0);

    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
  });

  it("counts a send failure without breaking the loop", async () => {
    const api = makeApi();
    api.sendPhoto
      .mockRejectedValueOnce(new Error("403 blocked"))
      .mockResolvedValueOnce({ message_id: 1 });

    const m = matchWith(
      side({ side: "A" }),
      side({ side: "B", userId: "user-b", telegramId: 200n, role: "responder" }),
    );

    const r = await sendExpiryNotifications(api as never, [m], 0);

    expect(r.notified).toBe(1);
    expect(r.failed).toBe(1);
  });
});
