import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "@gennety/shared";
import { parseLanguagePayload } from "./language-payload.js";

/**
 * Тело `PATCH /v1/me/language` (дефект S6).
 *
 * Цена ошибки здесь не в 400-ке: этот язык решает, на каком приходят пуши,
 * вопросы интервью и PNG-карточки Telegram. Значение, которого не знает ни
 * один рендерер, попав в колонку, сломает их все разом — поэтому проверяется
 * не «строка ли это», а «есть ли она в списке».
 */
describe("parseLanguagePayload", () => {
  it.each([...SUPPORTED_LANGUAGES])("«%s» из списка принимается", (language) => {
    expect(parseLanguagePayload({ language })).toEqual({ language });
  });

  // Каждый из этих похож на язык ровно настолько, чтобы пройти небрежную
  // проверку вроде `typeof === "string"` или регулярки на две буквы.
  it.each(["ru-RU", "EN", "Ru", "ru ", "xx", "", "und"])(
    "«%s» отвергается: похоже на язык — не значит поддерживается",
    (language) => {
      expect(parseLanguagePayload({ language })).toEqual({
        error: "Unsupported language",
      });
    },
  );

  it.each([
    ["число", { language: 42 }],
    ["массив", { language: ["ru"] }],
    ["объект", { language: { code: "ru" } }],
    ["null", { language: null }],
    ["пустое тело", {}],
    ["undefined", undefined],
  ])("%s — отказ, а не падение", (_name, body) => {
    expect(parseLanguagePayload(body)).toEqual({ error: "Unsupported language" });
  });
});
