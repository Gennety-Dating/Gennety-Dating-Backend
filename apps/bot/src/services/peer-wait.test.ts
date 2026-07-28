import { describe, it, expect, vi, beforeEach } from "vitest";
import { t } from "@gennety/shared";

vi.mock("../config.js", () => ({
  env: { CUSTOM_EMOJI_THINKING_ID: "" },
}));

import { sendPeerWaitAck, sendPeerWaitBeats } from "./peer-wait.js";
import { peerWaitSteps } from "./analysis-status.js";

const noWait = () => Promise.resolve();

/** Minimal grammY `Api` double with a working `raw` for the rich-draft path. */
function createRichApi() {
  const drafts: Array<{ draft_id: number; html?: string; markdown?: string }> = [];
  const sendRichMessage = vi.fn().mockResolvedValue({ message_id: 9 });
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
      raw: {
        sendRichMessageDraft: vi.fn(async (p: { draft_id: number; rich_message: { html?: string; markdown?: string } }) => {
          drafts.push({ draft_id: p.draft_id, ...p.rich_message });
          return true as const;
        }),
        sendRichMessage,
      },
    } as never,
    drafts,
    sendRichMessage,
  };
}

/** `Api` double with no rich support at all — forces the classic fallback. */
function createPlainApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    raw: {
      sendRichMessageDraft: vi.fn().mockRejectedValue(new Error("unsupported")),
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("peerWaitSteps", () => {
  it("ends on the caller's waiting line so the final message is unchanged copy", () => {
    const steps = peerWaitSteps("ru", t("ru", "venueWaitingPeer"));
    expect(steps).toHaveLength(3);
    expect(steps[2]!.text).toBe(t("ru", "venueWaitingPeer"));
    expect(steps[2]!.holdMs).toBe(0);
  });

  it("stays short — the wait itself can last hours and must not be shimmered", () => {
    const total = peerWaitSteps("en", "waiting").reduce((sum, s) => sum + s.holdMs, 0);
    expect(total).toBeLessThanOrEqual(3000);
  });

  it("localises the beats", () => {
    expect(peerWaitSteps("ru", "x")[0]!.text).toBe(t("ru", "peerWaitSaving"));
    expect(peerWaitSteps("pl", "x")[1]!.text).toBe(t("pl", "peerWaitHandoff"));
  });
});

describe("sendPeerWaitAck / sendPeerWaitBeats", () => {
  it("shimmers the two beats as drafts, then persists the waiting line", async () => {
    const { api, drafts, sendRichMessage } = createRichApi();
    const waiting = t("en", "venueWaitingPeer");

    await sendPeerWaitAck(api, 111, "en", waiting, { wait: noWait });

    // Two thinking beats — and only two: the final line must be a real message,
    // not an ephemeral draft that would vanish while the partner is still deciding.
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.html).toContain("tg-thinking");
    expect(drafts[1]!.html).toContain("tg-thinking");
    // One shared draft id → the client reserves the compose space exactly once.
    expect(drafts[0]!.draft_id).toBe(drafts[1]!.draft_id);

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]![0].rich_message.markdown).toBe(waiting);
  });

  it("falls back to the classic edited stream and still lands the waiting line", async () => {
    const api = createPlainApi();
    const waiting = t("en", "matchScheduleSavedConfirmation");

    await sendPeerWaitAck(api, 222, "en", waiting, { wait: noWait });

    const typed = api as unknown as {
      sendMessage: ReturnType<typeof vi.fn>;
      editMessageText: ReturnType<typeof vi.fn>;
      deleteMessage: ReturnType<typeof vi.fn>;
    };
    expect(typed.sendMessage).toHaveBeenCalledWith(222, t("en", "peerWaitSaving"));
    // The last edit carries the waiting copy, and the message is NOT deleted —
    // it is the durable receipt the user comes back to.
    const edits = typed.editMessageText.mock.calls;
    expect(edits[edits.length - 1]![2]).toBe(waiting);
    expect(typed.deleteMessage).not.toHaveBeenCalled();
  });

  it("beats-only variant persists nothing — the caller owns the durable message", async () => {
    const { api, drafts, sendRichMessage } = createRichApi();

    await sendPeerWaitBeats(api, 444, "en", { wait: noWait });

    // The leading glyph is upgraded to an animated <tg-emoji>, so match on the
    // label text rather than the raw i18n string.
    const label = (key: "peerWaitSaving" | "peerWaitHandoff") =>
      t("en", key).split(" ").slice(1).join(" ");
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.html)).toEqual([
      expect.stringContaining(label("peerWaitSaving")),
      expect.stringContaining(label("peerWaitHandoff")),
    ]);
    // Nothing persisted: the post-accept card that follows is tracked in
    // `calendarMessageIdA/B` and carries its own message effect, so this
    // variant must never send a message of its own.
    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(
      (api as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage,
    ).not.toHaveBeenCalled();
  });

  it("beats-only cleans up its fallback message so no stray line survives", async () => {
    const api = createPlainApi();

    await sendPeerWaitBeats(api, 555, "en", { wait: noWait });

    const typed = api as unknown as {
      sendMessage: ReturnType<typeof vi.fn>;
      deleteMessage: ReturnType<typeof vi.fn>;
    };
    expect(typed.sendMessage).toHaveBeenCalledTimes(1);
    expect(typed.deleteMessage).toHaveBeenCalledWith(555, 1);
  });

  it("never throws when the chat rejects every send (blocked bot)", async () => {
    const api = {
      sendMessage: vi.fn().mockRejectedValue(new Error("bot was blocked")),
      raw: { sendRichMessageDraft: vi.fn().mockRejectedValue(new Error("unsupported")) },
    } as never;

    await expect(
      sendPeerWaitAck(api, 333, "en", "waiting", { wait: noWait }),
    ).resolves.toBeUndefined();
  });
});
