import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const matchFindUnique = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: { match: { findUnique: matchFindUnique } },
}));

const envMock = { OPENAI_API_KEY: "sk-test" };
vi.mock("../config.js", () => ({ env: envMock }));

const openaiFetch = vi.fn();
vi.mock("./openai-fetch.js", () => ({
  openaiFetch: (...args: unknown[]) => openaiFetch(...args),
}));

const {
  classifyDecisionKeywords,
  classifyDecisionIntent,
  classifyMatchDecisionForUser,
  KEYWORD_MAX_LEN,
} = await import("./decision-intent.js");

function llmReply(intent: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent }) } }] }),
    { status: 200 },
  );
}

beforeEach(() => {
  matchFindUnique.mockReset();
  openaiFetch.mockReset();
  envMock.OPENAI_API_KEY = "sk-test";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyDecisionKeywords", () => {
  it("recognizes yes across locales", () => {
    for (const text of ["да", "иду!", "Пойду", "yes", "так, піду", "ja klar", "tak", "ок"]) {
      expect(classifyDecisionKeywords(text), text).toBe("yes");
    }
  });

  it("recognizes no and never lets negation match the bare yes-pattern", () => {
    for (const text of ["нет", "не хочу", "не піду", "nope", "nie", "not this time"]) {
      expect(classifyDecisionKeywords(text), text).toBe("no");
    }
  });

  it("recognizes unsure markers", () => {
    expect(classifyDecisionKeywords("хм, не знаю")).toBe("unsure");
    expect(classifyDecisionKeywords("maybe")).toBe("unsure");
  });

  it("returns null for unrelated text", () => {
    expect(classifyDecisionKeywords("как поменять фото профиля?")).toBeNull();
  });
});

describe("classifyDecisionIntent", () => {
  it("short keyword answers never touch the LLM", async () => {
    await expect(classifyDecisionIntent("да")).resolves.toBe("yes");
    expect(openaiFetch).not.toHaveBeenCalled();
  });

  it("long texts go to the LLM fallback", async () => {
    openaiFetch.mockResolvedValue(llmReply("yes"));
    const long = "Ну слушай, я вообще-то думал об этом весь день и вот что решил в итоге: погнали".padEnd(
      KEYWORD_MAX_LEN + 10,
      "!",
    );
    await expect(classifyDecisionIntent(long)).resolves.toBe("yes");
    expect(openaiFetch).toHaveBeenCalledTimes(1);
  });

  it("degrades to other when the LLM is unavailable", async () => {
    envMock.OPENAI_API_KEY = "";
    const long = "x".repeat(KEYWORD_MAX_LEN + 1);
    await expect(classifyDecisionIntent(long)).resolves.toBe("other");
  });
});

describe("classifyMatchDecisionForUser", () => {
  const base = {
    userAId: "user-a",
    userBId: "user-b",
    status: "proposed",
    acceptedByA: null,
    acceptedByB: null,
  };

  it("classifies for an undecided participant of an open proposal", async () => {
    matchFindUnique.mockResolvedValue({ ...base });
    await expect(classifyMatchDecisionForUser("m1", "user-a", "да")).resolves.toBe("yes");
  });

  it("refuses non-participants", async () => {
    matchFindUnique.mockResolvedValue({ ...base });
    await expect(classifyMatchDecisionForUser("m1", "stranger", "да")).resolves.toBeNull();
  });

  it("refuses once this side has decided", async () => {
    matchFindUnique.mockResolvedValue({ ...base, acceptedByA: true });
    await expect(classifyMatchDecisionForUser("m1", "user-a", "да")).resolves.toBeNull();
  });

  it("refuses non-proposed statuses and missing matches", async () => {
    matchFindUnique.mockResolvedValue({ ...base, status: "negotiating" });
    await expect(classifyMatchDecisionForUser("m1", "user-a", "да")).resolves.toBeNull();
    matchFindUnique.mockResolvedValue(null);
    await expect(classifyMatchDecisionForUser("m1", "user-a", "да")).resolves.toBeNull();
  });
});
