import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    OPENAI_API_KEY: "sk-test",
    WEBAPP_URL: "https://test.invalid/calendar",
  },
}));

import { transcribeVoice, WHISPER_MAX_BYTES } from "./whisper.js";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("transcribeVoice", () => {
  const buffer = Buffer.from("fake-ogg-bytes");

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the transcribed text on a successful response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({ text: "hello world" }));
    const result = await transcribeVoice(buffer, { fetchFn });
    expect(result).toBe("hello world");
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("includes the model and language fields in the multipart body", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({ text: "hi" }));
    await transcribeVoice(buffer, { fetchFn, language: "en" });

    const form = fetchFn.mock.calls[0][1].body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBe("en");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("trims surrounding whitespace from Whisper's response", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okJson({ text: "  hello  \n" }));
    expect(await transcribeVoice(buffer, { fetchFn })).toBe("hello");
  });

  it("returns empty string on non-2xx response", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await transcribeVoice(buffer, { fetchFn })).toBe("");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns empty string when fetch throws", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await transcribeVoice(buffer, { fetchFn })).toBe("");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns empty string when the response has no text field", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({}));
    expect(await transcribeVoice(buffer, { fetchFn })).toBe("");
  });

  it("rejects empty buffers without calling the API", async () => {
    const fetchFn = vi.fn();
    expect(await transcribeVoice(Buffer.alloc(0), { fetchFn })).toBe("");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects buffers over the Whisper size limit", async () => {
    const fetchFn = vi.fn();
    const big = Buffer.alloc(WHISPER_MAX_BYTES + 1);
    expect(await transcribeVoice(big, { fetchFn })).toBe("");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  /**
   * Имя файла — это и есть заявленный контейнер: OpenAI читает формат из него,
   * а не из MIME-типа блоба. Пока единственным вызывающим был Telegram,
   * захардкоженное `voice.ogg` совпадало с байтами случайно; запись с айфона
   * приходит в m4a, и под чужим именем была бы отвергнута как битый OGG.
   */
  describe("filename", () => {
    async function filenameFor(mime: string): Promise<string | null> {
      const fetchFn = vi.fn().mockResolvedValue(okJson({ text: "ok" }));
      await transcribeVoice(buffer, { fetchFn, mime });
      if (fetchFn.mock.calls.length === 0) return null;
      const form = fetchFn.mock.calls[0][1].body as FormData;
      const file = form.get("file");
      return file instanceof File ? file.name : null;
    }

    it("names a Telegram voice note as OGG", async () => {
      expect(await filenameFor("audio/ogg")).toBe("voice.ogg");
    });

    it("names an iOS chat recording as m4a", async () => {
      expect(await filenameFor("audio/m4a")).toBe("voice.m4a");
      expect(await filenameFor("audio/x-m4a")).toBe("voice.m4a");
      expect(await filenameFor("audio/mp4")).toBe("voice.m4a");
    });

    it("ignores charset parameters and letter case on the MIME type", async () => {
      expect(await filenameFor("AUDIO/OGG; codecs=opus")).toBe("voice.ogg");
    });

    it("maps codec-named types onto their container", async () => {
      expect(await filenameFor("audio/opus")).toBe("voice.ogg");
      expect(await filenameFor("audio/aac")).toBe("voice.m4a");
    });

    it("accepts a subtype that is already a supported extension", async () => {
      expect(await filenameFor("audio/wav")).toBe("voice.wav");
      expect(await filenameFor("audio/webm")).toBe("voice.webm");
    });

    it("refuses to guess an extension for an unknown type, without calling out", async () => {
      const fetchFn = vi.fn().mockResolvedValue(okJson({ text: "ok" }));
      expect(
        await transcribeVoice(buffer, { fetchFn, mime: "application/octet-stream" }),
      ).toBe("");
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });
});

describe("transcribeVoice with no API key", () => {
  it("short-circuits to empty string", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      env: { OPENAI_API_KEY: "" },
    }));
    const { transcribeVoice: fn } = await import("./whisper.js");
    const fetchFn = vi.fn();
    expect(await fn(Buffer.from("x"), { fetchFn })).toBe("");
    expect(fetchFn).not.toHaveBeenCalled();
  });

});
