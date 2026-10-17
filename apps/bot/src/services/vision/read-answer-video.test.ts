import { describe, expect, it, vi } from "vitest";
import { buildVideoInstruction, readAnswerVideo } from "./read-answer-video.js";

const FRAME = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mime: "image/jpeg" };

function reply(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

describe("readAnswerVideo", () => {
  it("sends every frame, in order, in ONE call and returns the description", async () => {
    const fetchFn = vi.fn(async () => reply('{"safe": true, "description": "Кот прыгает в коробку."}'));
    const result = await readAnswerVideo([FRAME, FRAME, FRAME], {
      language: "ru",
      questionText: "Что тебя смешит?",
      meme: true,
      openaiApiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: true, description: "Кот прыгает в коробку." });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as {
      messages: Array<{ content: unknown }>;
    };
    const parts = body.messages[1]!.content as Array<{ type: string }>;
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url", "image_url", "image_url"]);
  });

  it("refuses nothing on its own and never throws on our side's failures", async () => {
    const timeout = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    expect(
      await readAnswerVideo([FRAME], {
        language: "en",
        questionText: "q",
        meme: false,
        openaiApiKey: "k",
        fetchFn: timeout as unknown as typeof fetch,
      }),
    ).toEqual({ ok: false, error: "timeout" });
    expect(
      await readAnswerVideo([], { language: "en", questionText: "q", meme: false, openaiApiKey: "k" }),
    ).toEqual({ ok: false, error: "unreadable" });
  });

  it("passes on an unsafe verdict", async () => {
    const fetchFn = vi.fn(async () => reply('{"safe": false, "description": ""}'));
    const result = await readAnswerVideo([FRAME], {
      language: "en",
      questionText: "q",
      meme: false,
      openaiApiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, error: "unsafe" });
  });
});

describe("buildVideoInstruction", () => {
  it("tells the model the frames are one clip and carries the soundtrack apart from the person's words", () => {
    const text = buildVideoInstruction(4, {
      language: "en",
      questionText: "Your ideal Sunday?",
      meme: false,
      caption: "this is me",
      soundTranscript: "waves and a guitar",
      durationSeconds: 9.6,
    });
    expect(text).toContain('"Your ideal Sunday?"');
    expect(text).toContain("4 frames taken evenly from that ONE");
    expect(text).toContain("about 10 seconds long");
    expect(text).toContain('not the\nperson\'s own words): "waves and a guitar"');
    expect(text).toContain('"this is me"');
  });

  it("reads a meme clip for its humour, without the question", () => {
    const text = buildVideoInstruction(1, { language: "de", questionText: "q", meme: true });
    expect(text).toContain("what actually makes them laugh");
    expect(text).toContain("1 frame taken");
    expect(text).toContain("German");
    expect(text).not.toContain('"q"');
  });
});
