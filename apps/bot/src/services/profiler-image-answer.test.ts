import { describe, it, expect, vi } from "vitest";
import {
  answerProfilerQuestionWithImage,
  profilerImageFromMessage,
  PROFILER_IMAGE_MAX_BYTES,
  type ProfilerImageAnswerDeps,
} from "./profiler-image-answer.js";
import { parseMemeResponse } from "./vision/read-meme.js";

/** Minimal valid JPEG header — `sniffImageMime` reads the magic bytes. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]);
const NOT_AN_IMAGE = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");

function deps(over: Partial<ProfilerImageAnswerDeps> = {}): ProfilerImageAnswerDeps {
  return {
    download: vi.fn(async () => JPEG),
    read: vi.fn(async () => ({ ok: true, description: "a cat in a tiny hat", model: "m" }) as const),
    record: vi.fn(async () => true),
    ...over,
  };
}

describe("profilerImageFromMessage", () => {
  it("takes the largest photo size", () => {
    expect(
      profilerImageFromMessage({
        photo: [{ file_id: "small" }, { file_id: "large" }],
      }),
    ).toEqual({ fileId: "large", kind: "photo", caption: undefined });
  });

  it("carries a caption as the user's own words about the image", () => {
    expect(
      profilerImageFromMessage({ photo: [{ file_id: "p" }], caption: "  this is me every monday " }),
    ).toEqual({ fileId: "p", kind: "photo", caption: "this is me every monday" });
  });

  it("reads a still sticker directly and an animated one through its thumbnail", () => {
    // A static sticker is a WebP the vision model reads; .tgs/.webm are not,
    // and their thumbnail is an ordinary JPEG.
    expect(profilerImageFromMessage({ sticker: { file_id: "webp" } })?.fileId).toBe("webp");
    expect(
      profilerImageFromMessage({
        sticker: { file_id: "tgs", is_animated: true, thumbnail: { file_id: "thumb" } },
      })?.fileId,
    ).toBe("thumb");
  });

  it("reads a GIF, a video and a document through their thumbnail", () => {
    // This is what makes "send me something funny" work for a video without a
    // video pipeline: one frame says what the joke is.
    for (const key of ["animation", "video", "document"] as const) {
      expect(
        profilerImageFromMessage({ [key]: { file_id: "raw", thumbnail: { file_id: "t" } } })?.fileId,
      ).toBe("t");
    }
  });

  it("tags a still sticker as a sticker and everything else as a photo", () => {
    // The tag is what the paid reveal dispatches on: Telegram file_ids are
    // type-tagged, so `sendPhoto` with a sticker's id fails outright. A still
    // sticker is the ONLY case where we hold a non-photo id — every other
    // branch captured a JPEG thumbnail.
    expect(profilerImageFromMessage({ sticker: { file_id: "webp" } })?.kind).toBe("sticker");
    expect(
      profilerImageFromMessage({
        sticker: { file_id: "webm", is_video: true, thumbnail: { file_id: "t" } },
      }),
    ).toEqual({ fileId: "t", kind: "photo", caption: undefined });
    expect(
      profilerImageFromMessage({ animation: { file_id: "gif", thumbnail: { file_id: "t" } } })?.kind,
    ).toBe("photo");
  });

  it("offers nothing for a message with no media, or media with no thumbnail", () => {
    expect(profilerImageFromMessage({ text: "hi" })).toBeNull();
    expect(profilerImageFromMessage({ video: { file_id: "v" } })).toBeNull();
    expect(profilerImageFromMessage(undefined)).toBeNull();
  });
});

describe("answerProfilerQuestionWithImage", () => {
  it("describes the image and records the description as the answer", async () => {
    const d = deps();
    const outcome = await answerProfilerQuestionWithImage({ fileId: "f", kind: "photo", caption: undefined }, "ru", d);
    expect(outcome).toBe("recorded");
    expect(d.record).toHaveBeenCalledWith("a cat in a tiny hat", {
      fileId: "f",
      kind: "photo",
    });
  });

  it("falls back to the caption when vision fails", async () => {
    // Losing a real, typed answer because an OpenAI call timed out would be the
    // worse failure — the caption is the user's own text either way.
    const d = deps({
      read: vi.fn(async () => ({ ok: false, error: "timeout" }) as const),
    });
    const outcome = await answerProfilerQuestionWithImage({ fileId: "f", kind: "photo", caption: "my life" }, "en", d);
    expect(outcome).toBe("recorded_caption");
    // The caption fallback deliberately records NO pointer: the stored text is
    // the user's own words about a picture we could not read, and pairing it
    // with that picture in a paid reveal would show something unvetted.
    expect(d.record).toHaveBeenCalledWith("my life");
  });

  it("reports the failure when there is no caption to fall back on", async () => {
    const d = deps({ read: vi.fn(async () => ({ ok: false, error: "unsafe" }) as const) });
    expect(
      await answerProfilerQuestionWithImage({ fileId: "f", kind: "photo", caption: undefined }, "en", d),
    ).toBe("unreadable");
    expect(d.record).not.toHaveBeenCalled();
  });

  it("never sends non-image bytes to the vision model", async () => {
    // The declared Telegram type is not evidence; the magic bytes are. SVG is
    // XML with script in it and is rejected by the sniffer on purpose.
    const d = deps({ download: vi.fn(async () => NOT_AN_IMAGE) });
    expect(
      await answerProfilerQuestionWithImage({ fileId: "f", kind: "photo", caption: undefined }, "en", d),
    ).toBe("not_an_image");
    expect(d.read).not.toHaveBeenCalled();
  });

  it("refuses to base64 an oversized file", async () => {
    const d = deps({
      download: vi.fn(async () => Buffer.concat([JPEG, Buffer.alloc(PROFILER_IMAGE_MAX_BYTES)])),
    });
    expect(
      await answerProfilerQuestionWithImage({ fileId: "f", kind: "photo", caption: undefined }, "en", d),
    ).toBe("too_large");
    expect(d.read).not.toHaveBeenCalled();
  });

  it("reports a failed download without calling vision", async () => {
    const d = deps({ download: vi.fn(async () => null) });
    expect(
      await answerProfilerQuestionWithImage({ fileId: "f", kind: "photo", caption: undefined }, "en", d),
    ).toBe("download_failed");
    expect(d.read).not.toHaveBeenCalled();
  });

  it("does not claim success when the answer could not be recorded", async () => {
    // A lost claim race (the user tapped Skip while vision was running) must
    // not report a recorded answer.
    const d = deps({ record: vi.fn(async () => false) });
    expect(
      await answerProfilerQuestionWithImage({ fileId: "f", kind: "photo", caption: undefined }, "en", d),
    ).toBe("unreadable");
  });
});

describe("parseMemeResponse", () => {
  it("takes the description off a well-formed body", () => {
    expect(parseMemeResponse('{"safe": true, "description": "dry office humour"}')).toEqual({
      ok: true,
      description: "dry office humour",
      model: expect.any(String),
    });
  });

  it("treats an explicit refusal as unsafe", () => {
    expect(parseMemeResponse('{"safe": false, "description": ""}')).toEqual({
      ok: false,
      error: "unsafe",
    });
  });

  it("does not read a MISSING safety flag as a refusal", () => {
    // Defaulting to unsafe on a schema wobble would silently drop ordinary
    // answers; only an explicit `false` is a refusal.
    expect(parseMemeResponse('{"description": "a dog on a skateboard"}')).toMatchObject({
      ok: true,
      description: "a dog on a skateboard",
    });
  });

  it("rejects an empty description and an unparseable body", () => {
    expect(parseMemeResponse('{"safe": true, "description": "   "}')).toEqual({
      ok: false,
      error: "unreadable",
    });
    expect(parseMemeResponse("not json")).toEqual({ ok: false, error: "api" });
  });
});
