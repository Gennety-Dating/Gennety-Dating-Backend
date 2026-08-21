import { describe, expect, it } from "vitest";
import { transcriptSharesContactInfo } from "./audio-contact-info.js";

describe("transcriptSharesContactInfo", () => {
  describe("catches an actual contact token", () => {
    it.each([
      ["a handle", "привет, я Максим, мой инстаграм @maksim_kyiv"],
      ["a t.me link", "hi, find me at t.me/maksim"],
      ["a bare url", "check out www.instagram.com/maksim"],
      ["a spoken phone number", "мой номер 380 67 123 45 67, звони"],
      ["a phone number with dashes", "call me on 067-123-45-67"],
    ])("%s", (_label, transcript) => {
      expect(transcriptSharesContactInfo(transcript)).toBe(true);
    });
  });

  describe("catches a platform plus an invitation", () => {
    it.each([
      ["ru", "если что, напиши мне в телеграм"],
      ["uk", "знайди мене в інстаграмі"],
      ["en", "just dm me on instagram"],
      ["de", "schreib mir auf whatsapp"],
      ["pl", "napisz do mnie na instagramie"],
    ])("%s", (_label, transcript) => {
      expect(transcriptSharesContactInfo(transcript)).toBe(true);
    });
  });

  describe("leaves ordinary speech alone — a false positive destroys a real recording", () => {
    it.each([
      ["a platform mentioned as a fact of life", "я работаю в инстаграме, веду блог про кофе"],
      ["a platform with no invitation", "мы познакомились в телеграме, смешная история"],
      ["an invitation with no platform", "напиши мне, если тоже любишь горы"],
      ["a year read aloud", "я переехал в Киев в 2019 году и с тех пор тут"],
      ["a price", "последний раз я потратил 1500 гривен на билет и не жалею"],
      ["an age and a height", "мне 27, рост 183"],
      ["an email-looking word that is not one", "я работаю в it, пишу на питоне"],
      ["a short handle-like fragment", "мой знак @ ну ты понял"],
    ])("%s", (_label, transcript) => {
      expect(transcriptSharesContactInfo(transcript)).toBe(false);
    });
  });

  it("ignores empty and whitespace-only input", () => {
    expect(transcriptSharesContactInfo("")).toBe(false);
    expect(transcriptSharesContactInfo("   \n ")).toBe(false);
  });
});
