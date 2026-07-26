import { describe, it, expect, vi } from "vitest";

// `appendVerifyNowButton` falls back to a prisma lookup only when no `theme`
// is supplied. Every test here passes `theme` explicitly so the keyboard
// shape is exercised without needing a DB mock.
vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

import { t } from "@gennety/shared";
import {
  VERIFY_PHOTOS_CALLBACK,
  buildVerificationKeyboard,
} from "./verification-keyboard.js";

type Button = { text: string; callback_data?: string; web_app?: { url: string } };

function rows(keyboard: NonNullable<Awaited<ReturnType<typeof buildVerificationKeyboard>>>): Button[][] {
  return (keyboard as unknown as { inline_keyboard: Button[][] }).inline_keyboard;
}

describe("buildVerificationKeyboard", () => {
  it("defaults to Verify first, photo-redo second", async () => {
    const keyboard = await buildVerificationKeyboard("en", "user-1", { theme: "dark" });
    expect(keyboard).not.toBeNull();
    const flat = rows(keyboard!).flat();

    expect(flat).toHaveLength(2);
    expect(flat[0]!.web_app).toBeDefined();
    expect(flat[1]!.callback_data).toBe(VERIFY_PHOTOS_CALLBACK);
    expect(flat[1]!.text).toBe(t("en", "verifyBtnRedoPhotos"));
  });

  it("photoRedoFirst puts the photo row ABOVE Verify (the `rejected` outcome)", async () => {
    const keyboard = await buildVerificationKeyboard("en", "user-1", {
      theme: "dark",
      photoRedoFirst: true,
    });
    const flat = rows(keyboard!).flat();

    expect(flat).toHaveLength(2);
    expect(flat[0]!.callback_data).toBe(VERIFY_PHOTOS_CALLBACK);
    expect(flat[1]!.web_app).toBeDefined();
  });

  it("photoRedoLabel overrides the button text (the liveness-retry nudge's secondary framing)", async () => {
    const keyboard = await buildVerificationKeyboard("en", "user-1", {
      theme: "dark",
      photoRedoLabel: t("en", "verifyBtnRedoPhotosSecondary"),
    });
    const flat = rows(keyboard!).flat();
    const photoButton = flat.find((b) => b.callback_data === VERIFY_PHOTOS_CALLBACK);

    expect(photoButton?.text).toBe(t("en", "verifyBtnRedoPhotosSecondary"));
    expect(photoButton?.text).not.toBe(t("en", "verifyBtnRedoPhotos"));
  });

  it("withPhotoRedo: false omits the photo row entirely", async () => {
    const keyboard = await buildVerificationKeyboard("en", "user-1", {
      theme: "dark",
      withPhotoRedo: false,
    });
    const flat = rows(keyboard!).flat();

    expect(flat).toHaveLength(1);
    expect(flat[0]!.web_app).toBeDefined();
  });

  it("returns null when no real Mini App host is configured", async () => {
    const original = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = "http://localhost:5173";
    vi.resetModules();
    const { buildVerificationKeyboard: build } = await import("./verification-keyboard.js");

    const keyboard = await build("en", "user-1", { theme: "dark" });
    expect(keyboard).toBeNull();

    process.env.WEBAPP_URL = original;
    vi.resetModules();
  });
});
