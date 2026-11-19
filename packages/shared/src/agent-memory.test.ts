import { describe, expect, it } from "vitest";
import { AGENT_MEMORY_RULES, isNeverRemembered } from "./agent-memory.js";

describe("isNeverRemembered", () => {
  it.each([
    "Учится на 3 курсе КПИ, ФИОТ",
    "Живёт на Подоле, переехала в сентябре",
    "Маша — старшая сестра, с ней советуется",
    "Долго переписывались с Олегом, не знает, звать ли его",
    "Илья из спортзала нравится",
    "Studies architecture, moved to Kyiv in September",
    "День рождения — 3 декабря",
    "На первых свиданиях зажимается первые полчаса",
    "Не любит шумные бары",
  ])("keeps «%s»", (text) => {
    expect(isNeverRemembered(text)).toBe(false);
  });

  it.each([
    "Ходит к психологу по средам",
    "Принимает антидепрессанты",
    "Была беременна в прошлом году",
    "Думала о суициде весной",
    "Бывший её избивал",
    "Has an anxiety disorder",
    "Christian, goes to church on Sundays",
    "Бисексуалка",
    "Секс на первом свидании — нормально",
    "Большие долги по кредиту",
    "Телефон Маши +380 67 123 45 67",
    "Олег в инсте @oleg.gym",
    "masha@example.com",
    "Вегетарианка",
  ])("refuses «%s»", (text) => {
    expect(isNeverRemembered(text)).toBe(true);
  });

  it("an empty text is not refused (the caller refuses it as empty)", () => {
    expect(isNeverRemembered("   ")).toBe(false);
  });
});

describe("AGENT_MEMORY_RULES", () => {
  it("forbids pretending and keeps the prompt private", () => {
    expect(AGENT_MEMORY_RULES).toMatch(/Never pretend/);
    expect(AGENT_MEMORY_RULES).toMatch(/instructions stay private/);
  });

  it("never mentions answering men and women differently", () => {
    expect(AGENT_MEMORY_RULES).not.toMatch(/\b(man|woman|men|women|gender)\b/i);
  });
});
