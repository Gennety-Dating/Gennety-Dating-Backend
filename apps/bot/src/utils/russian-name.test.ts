import { describe, expect, it } from "vitest";
import { russianNameDative } from "./russian-name.js";

describe("russianNameDative", () => {
  it.each([
    ["Аня", "Ане"], ["Ева", "Еве"], ["Никита", "Никите"],
    ["Вася", "Васе"], ["Петя", "Пете"], ["Мария", "Марии"],
    ["Наталья", "Наталье"], ["Майя", "Майе"], ["Лия", "Лие"],
    ["Алия", "Алие"], ["Зульфия", "Зульфие"], ["Любовь", "Любови"],
    ["Павел", "Павлу"], ["Лев", "Льву"], ["Пётр", "Петру"],
    ["Петр", "Петру"], ["Анна-Мария", "Анне-Марии"],
    ["АНЯ", "АНЕ"], ["аня", "ане"],
  ])("%s → %s", (name, expected) => {
    expect(russianNameDative(name)).toBe(expected);
  });

  it.each([
    ["Артём", "Артёму"], ["Андрей", "Андрею"],
    ["Дмитрий", "Дмитрию"], ["Игорь", "Игорю"], ["Илья", "Илье"],
  ])("declines the masculine name %s", (name, expected) => {
    expect(russianNameDative(name, "male")).toBe(expected);
  });

  it.each(["Элен", "Николь", "Марго", "Ли", "Anna", "Eva", "Аня 🌸", "Анна Maria"])(
    "preserves indeclinable or unsupported name %s", (name) => {
      expect(russianNameDative(name, "female")).toBe(name);
    },
  );

  it("does not infer gender for ambiguous consonant endings", () => {
    expect(russianNameDative("Алекс")).toBe("Алекс");
    expect(russianNameDative("Алекс", "female")).toBe("Алекс");
    expect(russianNameDative("Алекс", "male")).toBe("Алексу");
  });
});
