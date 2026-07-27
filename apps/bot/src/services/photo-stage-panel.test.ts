import { describe, it, expect } from "vitest";
import { DEFAULT_SESSION, SUPPORTED_LANGUAGES, type SessionData } from "@gennety/shared";
import { isPhotoStagePanelTap, photoStagePanelSync } from "./photo-stage-panel.js";

function session(overrides: Partial<SessionData> = {}): SessionData {
  return { ...DEFAULT_SESSION, ...overrides };
}

describe("photo-stage bottom panel", () => {
  it("attaches the panel on the first message of the photo stage", () => {
    const s = session({ expectingPhoto: true });

    const markup = photoStagePanelSync(s);

    expect(markup.reply_markup).toMatchObject({
      resize_keyboard: true,
      is_persistent: true,
    });
    expect(s.photoStagePanelShown).toBe(true);
  });

  it("does not re-send the panel while the stage continues", () => {
    const s = session({ expectingPhoto: true, photoStagePanelShown: true });

    expect(photoStagePanelSync(s)).toEqual({});
    expect(s.photoStagePanelShown).toBe(true);
  });

  it("tears the panel down on the first message after the stage ends", () => {
    const s = session({ expectingPhoto: false, photoStagePanelShown: true });

    expect(photoStagePanelSync(s)).toEqual({
      reply_markup: { remove_keyboard: true },
    });
    expect(s.photoStagePanelShown).toBe(false);
  });

  it("tears down exactly once — a reply keyboard removed twice would be noise", () => {
    const s = session({ expectingPhoto: false, photoStagePanelShown: true });

    photoStagePanelSync(s);

    expect(photoStagePanelSync(s)).toEqual({});
  });

  it("is a no-op outside the stage, so every send can spread it in blindly", () => {
    const s = session({ expectingPhoto: false, photoStagePanelShown: false });

    expect(photoStagePanelSync(s)).toEqual({});
    expect(s.photoStagePanelShown).toBe(false);
  });

  it("recognises its own button label in every supported language", () => {
    // A reply-keyboard tap arrives as plain text carrying the label, and the
    // user may have switched language between the send and the tap.
    for (const language of SUPPORTED_LANGUAGES) {
      const s = session({ expectingPhoto: true, language });
      const markup = photoStagePanelSync(s);
      const label = (markup.reply_markup as { keyboard: { text: string }[][] })
        .keyboard[0]![0]!.text;

      expect(isPhotoStagePanelTap(label)).toBe(true);
      expect(isPhotoStagePanelTap(` ${label} `)).toBe(true);
    }
  });

  it("does not claim ordinary user text", () => {
    expect(isPhotoStagePanelTap("done")).toBe(false);
    expect(isPhotoStagePanelTap("my photos are bad")).toBe(false);
    expect(isPhotoStagePanelTap("")).toBe(false);
  });
});
