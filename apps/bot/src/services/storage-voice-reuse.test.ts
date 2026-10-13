import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `reuseVoicePromptSignedUrl` — the partner's voice link on the `/current` poll
 * (perf 2026-10-13). A link is signed for 300 s, exactly as before, and handed
 * out again only while ≥ 240 s of it is left, so a client never holds one with
 * less than that. Deleting the object forgets the link for good.
 */

vi.mock("../config.js", () => ({
  env: {
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    SUPABASE_VOICE_BUCKET: "voice-prompts",
    SUPABASE_PHOTO_BUCKET: "photos",
  },
}));

const {
  createVoicePromptSignedUrl,
  deleteStorageObject,
  resetReusableVoicePromptUrls,
  reuseVoicePromptSignedUrl,
} = await import("./storage.js");

const PATH = "11111111-1111-4111-8111-111111111111/1716000000000-abc.m4a";
const T0 = new Date("2026-10-13T12:00:00.000Z");

let fetchMock: ReturnType<typeof vi.fn>;
let signs = 0;

function signed(): Response {
  signs += 1;
  return new Response(
    JSON.stringify({ signedURL: `/object/sign/voice-prompts/${PATH}?token=t${signs}` }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const urlOf = (n: number) =>
  `https://supabase.test/storage/v1/object/sign/voice-prompts/${PATH}?token=t${n}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  signs = 0;
  fetchMock = vi.fn(async (url: string) =>
    url.includes("/object/sign/") ? signed() : new Response(null, { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  resetReusableVoicePromptUrls();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const signCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("/object/sign/"));

describe("reuseVoicePromptSignedUrl", () => {
  it("signs for the same 300 s the fresh helper does", async () => {
    expect(await reuseVoicePromptSignedUrl(PATH)).toBe(urlOf(1));
    const [url, init] = signCalls()[0]! as [string, RequestInit];
    expect(url).toBe(`https://supabase.test/storage/v1/object/sign/voice-prompts/${PATH}`);
    expect(JSON.parse(String(init.body))).toEqual({ expiresIn: 300 });
  });

  it("hands the same link out again while at least 240 s of it is left", async () => {
    await reuseVoicePromptSignedUrl(PATH);
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    expect(await reuseVoicePromptSignedUrl(PATH)).toBe(urlOf(1));
    expect(signCalls()).toHaveLength(1);
  });

  it("signs a new one once less than 240 s would be left", async () => {
    await reuseVoicePromptSignedUrl(PATH);
    vi.setSystemTime(new Date(T0.getTime() + 60_001));
    expect(await reuseVoicePromptSignedUrl(PATH)).toBe(urlOf(2));
    // …and that one is reused from its own signing time on.
    vi.setSystemTime(new Date(T0.getTime() + 120_001));
    expect(await reuseVoicePromptSignedUrl(PATH)).toBe(urlOf(2));
    expect(signCalls()).toHaveLength(2);
  });

  it("never remembers a failed sign — the next poll asks again", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 400 }));
    expect(await reuseVoicePromptSignedUrl(PATH)).toBeNull();
    expect(await reuseVoicePromptSignedUrl(PATH)).toBe(urlOf(1));
    expect(signCalls()).toHaveLength(2);
  });

  it("forgets the link once the object is deleted, and never keeps one for it again", async () => {
    await reuseVoicePromptSignedUrl(PATH);
    await deleteStorageObject("voice-prompts", PATH);
    expect(await reuseVoicePromptSignedUrl(PATH)).toBe(urlOf(2));
    expect(await reuseVoicePromptSignedUrl(PATH)).toBe(urlOf(3));
  });

  it("a sign racing the deletion is not kept either", async () => {
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    const racing = reuseVoicePromptSignedUrl(PATH);
    await deleteStorageObject("voice-prompts", PATH);
    release(signed());
    expect(await racing).toBe(urlOf(1));
    expect(await reuseVoicePromptSignedUrl(PATH)).toBe(urlOf(2));
  });

  it("a delete in another bucket leaves the voice link alone", async () => {
    await reuseVoicePromptSignedUrl(PATH);
    await deleteStorageObject("photos", PATH);
    expect(await reuseVoicePromptSignedUrl(PATH)).toBe(urlOf(1));
  });

  it("the fresh helper still signs on every call", async () => {
    await reuseVoicePromptSignedUrl(PATH);
    expect(await createVoicePromptSignedUrl(PATH)).toBe(urlOf(2));
    expect(await createVoicePromptSignedUrl(PATH)).toBe(urlOf(3));
  });
});
