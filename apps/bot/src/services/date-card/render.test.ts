import { describe, it, expect, vi } from "vitest";

vi.mock("../../config.js", () => ({
  env: { FACE_MATCH_PROVIDER: "disabled", AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" },
}));

vi.mock("../storage.js", () => ({
  downloadProfileImage: vi.fn().mockResolvedValue(null),
}));

import { renderDateCard } from "./index.js";

const api = {} as never;

describe("renderDateCard", () => {
  // Satori parses the bundled TTFs on first render, which is slow under
  // full-suite load — give the smoke render a generous timeout.
  it(
    "renders a valid PNG (with Cyrillic) when photos are absent",
    async () => {
      const png = await renderDateCard(
        {
          partnerFirstName: "Анна",
          partnerPhotoRef: null,
          venueName: "Lviv Coffee",
          venueAddress: "Khreshchatyk 14, Kyiv",
          venuePhotoUrl: null,
          venuePhotoName: null,
          agreedTime: new Date("2026-05-16T16:00:00Z"),
          language: "uk",
        },
        { blur: false },
        api,
      );
      expect(png).toBeInstanceOf(Buffer);
      expect(png!.subarray(0, 4).toString("hex")).toBe("89504e47"); // PNG magic
    },
    60_000,
  );
});
