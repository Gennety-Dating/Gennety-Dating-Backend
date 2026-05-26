import { InlineKeyboard } from "grammy";
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from "@gennety/shared";

export function buildLanguageKeyboard(
  callbackPrefix: "lang" | "menu:lang",
  options: { back?: { text: string; callbackData: string } } = {},
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const [index, lang] of SUPPORTED_LANGUAGES.entries()) {
    if (index > 0 && index % 2 === 0) keyboard.row();
    keyboard.text(LANGUAGE_LABELS[lang], `${callbackPrefix}:${lang}`);
  }

  if (options.back) {
    keyboard.row().text(options.back.text, options.back.callbackData);
  }

  return keyboard;
}
