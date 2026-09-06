import { describe, it, expect, vi } from "vitest";
import {
  answerProfilerQuestionWithLink,
  type ProfilerLinkAnswerDeps,
} from "./profiler-link-answer.js";
import type { ShortVideoRef } from "./short-video/links.js";

const REF: ShortVideoRef = {
  platform: "tiktok",
  externalId: "7301234567890123456",
  url: "https://www.tiktok.com/@u/video/7301234567890123456",
};

function deps(over: Partial<ProfilerLinkAnswerDeps> = {}): ProfilerLinkAnswerDeps {
  return {
    analyze: vi.fn(
      async () =>
        ({
          ok: true,
          ref: REF,
          description: "a deadpan skit about lying to your mum",
          poster: { fileId: "FILE_ID_1", kind: "photo" },
          cached: false,
        }) as const,
    ),
    record: vi.fn(async () => true),
    ...over,
  };
}

describe("answerProfilerQuestionWithLink", () => {
  it("stores the description, the pointer, and the link to the video", async () => {
    const d = deps();
    await expect(
      answerProfilerQuestionWithLink(REF, undefined, "ru", d),
    ).resolves.toBe("recorded");
    expect(d.record).toHaveBeenCalledWith("a deadpan skit about lying to your mum", {
      fileId: "FILE_ID_1",
      kind: "photo",
      sourceUrl: "https://www.tiktok.com/@u/video/7301234567890123456",
    });
  });

  it("keeps the link off the row when there is no pointer to attach it to", async () => {
    // No pointer means no reveal, so a bare URL would be dead weight that still
    // names what the user watches.
    const d = deps({
      analyze: vi.fn(
        async () =>
          ({ ok: true, ref: REF, description: "a skit", poster: null, cached: false }) as const,
      ),
    });
    await answerProfilerQuestionWithLink(REF, undefined, "ru", d);
    expect(d.record).toHaveBeenCalledWith("a skit", undefined);
  });

  it("stores the description with no pointer when none could be minted", async () => {
    const d = deps({
      analyze: vi.fn(
        async () =>
          ({ ok: true, ref: REF, description: "a skit", poster: null, cached: true }) as const,
      ),
    });
    await expect(answerProfilerQuestionWithLink(REF, undefined, "ru", d)).resolves.toBe(
      "recorded",
    );
    expect(d.record).toHaveBeenCalledWith("a skit", undefined);
  });

  it("falls back to the user's own words when the post cannot be read", async () => {
    const d = deps({ analyze: vi.fn(async () => ({ ok: false, error: "private" }) as const) });
    await expect(
      answerProfilerQuestionWithLink(REF, "это про меня целиком", "ru", d),
    ).resolves.toBe("recorded_commentary");
    // No pointer on the fallback: unverified text must never be paired with a
    // picture in a paid reveal.
    expect(d.record).toHaveBeenCalledWith("это про меня целиком");
  });

  it("records NOTHING for a bare failing link, so the URL is never the answer", async () => {
    const d = deps({ analyze: vi.fn(async () => ({ ok: false, error: "not_found" }) as const) });
    await expect(answerProfilerQuestionWithLink(REF, undefined, "ru", d)).resolves.toBe(
      "unavailable",
    );
    expect(d.record).not.toHaveBeenCalled();
  });

  it("reports unavailable when the answer path itself declines to record", async () => {
    const d = deps({ record: vi.fn(async () => false) });
    await expect(answerProfilerQuestionWithLink(REF, undefined, "ru", d)).resolves.toBe(
      "unavailable",
    );
  });

  it("does not pair a lost race with a pointer via the fallback", async () => {
    const d = deps({
      analyze: vi.fn(async () => ({ ok: false, error: "timeout" }) as const),
      record: vi.fn(async () => false),
    });
    await expect(
      answerProfilerQuestionWithLink(REF, "смешно", "ru", d),
    ).resolves.toBe("unavailable");
  });
});
