import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_SESSION, SUPPORTED_LANGUAGES, type SessionData } from "@gennety/shared";

/**
 * The chat's ONE bottom reply keyboard, and the handover between the two
 * onboarding steps that want it.
 *
 * These are not style tests. A message carries one `reply_markup`, so a panel
 * that is not handed over in the very message that ends its step is not handed
 * over at all — which is exactly how the photo panel survived into the voice
 * step, the verification card and the main menu.
 */

function session(overrides: Partial<SessionData> = {}): SessionData {
  return { ...DEFAULT_SESSION, ...overrides } as SessionData;
}

async function load() {
  return await import("./reply-panel.js");
}

type Keyboard = { keyboard: { text: string }[][]; input_field_placeholder?: string };

describe("reply panel", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.VOICE_PROMPT_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.VOICE_PROMPT_ENABLED;
    vi.resetModules();
  });

  it("attaches the panel on the first message of the photo stage", async () => {
    const { replyPanelSync } = await load();
    const s = session({ expectingPhoto: true });

    const markup = replyPanelSync(s);

    expect(markup.reply_markup).toMatchObject({ resize_keyboard: true, is_persistent: true });
    expect(s.replyPanel).toBe("photos");
  });

  it("does not re-send the panel while the stage continues", async () => {
    const { replyPanelSync } = await load();
    const s = session({ expectingPhoto: true, replyPanel: "photos" });

    expect(replyPanelSync(s)).toEqual({});
    expect(s.replyPanel).toBe("photos");
  });

  it("hands photos → voice as a keyboard, never as a removal", async () => {
    // The whole bug: `remove_keyboard` here would need a message of its own,
    // and there is none — every send downstream carries an inline keyboard.
    const { replyPanelSync } = await load();
    const s = session({
      expectingPhoto: true,
      replyPanel: "photos",
      expectingVoicePrompt: true,
      onboardingStep: "conversational",
    });

    const markup = replyPanelSync(s);

    expect(markup.reply_markup).not.toHaveProperty("remove_keyboard");
    expect((markup.reply_markup as Keyboard).keyboard[0]![0]!.text).toBe("Without a voice note");
    expect(s.replyPanel).toBe("voice");
  });

  it("lets a live voice claim outrank a stale expectingPhoto", async () => {
    // `conversational.ts` sends the voice ask without clearing expectingPhoto
    // on the unsolicited-batch branch, so reading photos first would mean the
    // voice panel silently never appears on that path.
    const { replyPanelSync } = await load();
    const s = session({
      expectingPhoto: true,
      replyPanel: null,
      expectingVoicePrompt: true,
      onboardingStep: "conversational",
    });

    expect(s.expectingPhoto).toBe(true);
    expect(replyPanelSync(s).reply_markup).toMatchObject({ is_persistent: true });
    expect(s.replyPanel).toBe("voice");
  });

  it("raises nothing from a stale claim when the feature is off", async () => {
    // Switching VOICE_PROMPT_ENABLED off must be complete, not partial.
    process.env.VOICE_PROMPT_ENABLED = "false";
    const { replyPanelSync } = await load();
    const s = session({ expectingVoicePrompt: true, onboardingStep: "conversational" });

    expect(replyPanelSync(s)).toEqual({});
    expect(s.replyPanel).toBe(null);
  });

  it("tears the panel down when the step is over", async () => {
    const { replyPanelSync } = await load();
    const s = session({ replyPanel: "voice" });

    expect(replyPanelSync(s)).toEqual({ reply_markup: { remove_keyboard: true } });
    expect(s.replyPanel).toBe(null);
  });

  it("tears down exactly once — a reply keyboard removed twice would be noise", async () => {
    const { replyPanelSync } = await load();
    const s = session({ replyPanel: "photos" });

    replyPanelSync(s);

    expect(replyPanelSync(s)).toEqual({});
  });

  it("upgrades a session written before the field existed", async () => {
    // SessionData is JSON in `bot_sessions` and survives the deploy, and the
    // middleware spreads DEFAULT_SESSION first — so a legacy row reads
    // `replyPanel: null`, which is indistinguishable from "no panel" unless the
    // deprecated flag is consulted. Without this every user standing on the
    // photo stage at restart keeps an orphaned panel forever.
    const { replyPanelSync } = await load();
    const s = session({ expectingPhoto: false, photoStagePanelShown: true, replyPanel: null });

    expect(replyPanelSync(s)).toEqual({ reply_markup: { remove_keyboard: true } });
    expect(s.replyPanel).toBe(null);
    // Consulted for the last time: a later null must not read as "still up".
    expect(s.photoStagePanelShown).toBe(false);
    expect(replyPanelSync(s)).toEqual({});
  });

  it("is a no-op outside both steps, so every send can spread it in blindly", async () => {
    const { replyPanelSync } = await load();
    const s = session();

    expect(replyPanelSync(s)).toEqual({});
    expect(s.replyPanel).toBe(null);
  });

  it("recognises each panel's own label in every supported language", async () => {
    // A reply-keyboard tap arrives as plain text carrying the label, and the
    // user may have switched language between the send and the tap.
    const { replyPanelMarkupFor, isPhotoStagePanelTap, isVoicePromptPanelTap } = await load();
    for (const language of SUPPORTED_LANGUAGES) {
      const photos = (replyPanelMarkupFor("photos", language).reply_markup as Keyboard)
        .keyboard[0]![0]!.text;
      const voice = (replyPanelMarkupFor("voice", language).reply_markup as Keyboard)
        .keyboard[0]![0]!.text;

      expect(isPhotoStagePanelTap(photos)).toBe(true);
      expect(isPhotoStagePanelTap(` ${photos} `)).toBe(true);
      expect(isVoicePromptPanelTap(voice)).toBe(true);
      expect(isVoicePromptPanelTap(` ${voice} `)).toBe(true);
      // The two panels must never answer for each other: one owns the chat at
      // a time, and a cross-match would resolve the wrong step.
      expect(isPhotoStagePanelTap(voice)).toBe(false);
      expect(isVoicePromptPanelTap(photos)).toBe(false);
    }
  });

  it("carries a placeholder that describes the step it belongs to", async () => {
    const { replyPanelMarkupFor } = await load();

    const photos = (replyPanelMarkupFor("photos", "en").reply_markup as Keyboard)
      .input_field_placeholder;
    const voice = (replyPanelMarkupFor("voice", "en").reply_markup as Keyboard)
      .input_field_placeholder;

    // The founder's second complaint: the input field kept asking for photos
    // on a step that wants a recording.
    expect(photos).toMatch(/photo/i);
    expect(voice).not.toMatch(/photo/i);
    expect(voice).toBeTruthy();
  });

  it("does not claim ordinary user text", async () => {
    const { isPhotoStagePanelTap, isVoicePromptPanelTap } = await load();

    expect(isPhotoStagePanelTap("done")).toBe(false);
    expect(isPhotoStagePanelTap("my photos are bad")).toBe(false);
    expect(isPhotoStagePanelTap("")).toBe(false);
    expect(isVoicePromptPanelTap("no")).toBe(false);
    expect(isVoicePromptPanelTap("")).toBe(false);
  });
});
