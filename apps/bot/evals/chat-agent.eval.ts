import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "@gennety/shared";

/**
 * Live evals of the app's chat agent (founder's chat 2026-10-15, "perfume").
 *
 * The REAL turn runs end to end — `runChatTurn`, the shared persona and
 * playbook, the app addendum, the person card, the tool loop and the tool
 * executors — against the REAL model. Only the database is replaced by an
 * in-memory one, and Storage hands out the fixture photos in `fixtures/` as
 * data URLs. Then a stronger model grades every reply against the rubric and
 * the scenario's expectations, and a report lands in `evals/out/`.
 *
 * Run before shipping any change to the agent's prompt, tools or loop:
 *
 *   pnpm --filter @gennety/bot eval:chat
 *
 * It costs real tokens (a few cents a run). `EVAL_ENV_FILE` points at the
 * `.env` with the key when the repo root has none (a worktree). Replies vary
 * between runs — read the report, not just the exit code.
 *
 * Deterministic checks (`expect`) guard what must never regress: the canned
 * failure line, the third photo, interests wiped by "add". The judge's
 * verdicts fail the run too, but a single borderline "fail" is a reason to
 * read the transcript, not proof of a regression.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const FIXTURES = resolve(__dirname, "fixtures");
const SESSION = "44444444-4444-4444-8444-444444444444";

// ---------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string; createdAt: Date };
  const state = {
    messages: [] as Row[],
    user: {} as Record<string, unknown>,
    seq: 0,
  };

  const now = () => new Date(Date.now() + state.seq++);
  const handlers: Record<string, Record<string, (args: Record<string, unknown>) => unknown>> = {
    message: {
      findMany: (args) => {
        const where = (args.where ?? {}) as { sessionId?: string };
        const take = typeof args.take === "number" ? args.take : 1000;
        return state.messages
          .filter((m) => !where.sessionId || m.sessionId === where.sessionId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take);
      },
      create: (args) => {
        const data = args.data as Record<string, unknown>;
        const row: Row = {
          imageUrl: null,
          imageUrls: [],
          context: null,
          ...data,
          id: `m-${state.seq}`,
          createdAt: now(),
        };
        state.messages.push(row);
        return row;
      },
      delete: (args) => {
        const id = (args.where as { id: string }).id;
        state.messages = state.messages.filter((m) => m.id !== id);
        return {};
      },
    },
    user: {
      findUnique: () => state.user,
      findFirst: () => state.user,
      update: (args) => {
        Object.assign(state.user, args.data as object);
        return state.user;
      },
    },
    profile: {
      findUnique: () => state.user.profile,
      update: (args) => {
        Object.assign(state.user.profile as object, args.data as object);
        return state.user.profile;
      },
    },
  };

  const fallback = (op: string): unknown => {
    if (op === "findMany" || op === "groupBy") return [];
    if (op === "count") return 0;
    if (op === "updateMany" || op === "deleteMany" || op === "createMany") return { count: 0 };
    return null;
  };

  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, op: string) => async (args: Record<string, unknown> = {}) =>
          handlers[name]?.[op] ? handlers[name]![op]!(args) : fallback(op),
      },
    );

  const prisma: unknown = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name === "$transaction") {
          return async (arg: unknown) =>
            typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as unknown[]);
        }
        if (name === "$queryRaw" || name === "$queryRawUnsafe" || name === "$executeRaw") return async () => [];
        return model(name);
      },
    },
  );

  return { state, prisma };
});

vi.mock("@gennety/db", () => ({ prisma: store.prisma, Prisma: {} }));
vi.mock("../src/services/chat-sessions.js", () => ({
  continueOrOpenChatSession: async () => "33333333-3333-4333-8333-333333333333",
  touchChatSession: async () => undefined,
}));
vi.mock("../src/services/chat-session-digest.js", () => ({ afterChatTurn: () => undefined }));
vi.mock("../src/services/storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/storage.js")>()),
  createChatImageSignedUrl: async (path: string) => {
    const file = path.split("/").pop()!;
    return `data:image/png;base64,${readFileSync(resolve(FIXTURES, file)).toString("base64")}`;
  },
}));

const { runChatTurn } = await import("../src/services/chat-agent.js");
const { openaiFetch } = await import("../src/services/openai-fetch.js");

/** A first-day account like the founder's on 2026-10-15. */
function freshAccount() {
  return {
    id: USER,
    telegramId: -1001n,
    language: "ru",
    firstName: "Глеб",
    surname: null,
    gender: "male",
    preference: "women",
    age: 18,
    major: "Computer Science",
    universityDomain: "knu.ua",
    status: "active",
    onboardingStep: "completed",
    ticketBalance: 1,
    premiumUntil: null,
    verificationStatus: "verified",
    createdAt: new Date(Date.now() - 90 * 60 * 1000),
    matchesAsA: [],
    matchesAsB: [],
    profile: {
      psychologicalSummary: null,
      hobbies: ["скалолазание", "джаз"],
      partnerPreferences: null,
      ageRangeMin: 18,
      ageRangeMax: 21,
      height: 182,
      photos: ["a", "b", "c", "d"],
      timeZone: "Europe/Kyiv",
      homeCity: "Київ",
      // First-day calibration, as onboarding sets it for a new account.
      calibrationUntil: new Date(Date.now() + 22 * 60 * 60 * 1000),
    },
  };
}

// ---------------------------------------------------------------------------
// Conversation + judge
// ---------------------------------------------------------------------------

interface Turn {
  text: string;
  photos?: string[];
  /** What a good reply does here — read by the judge. */
  expect: string;
}

interface Exchange {
  user: string;
  photos: string[];
  reply: string;
  receipts: string[];
  action: string | null;
  error: string | null;
  expect: string;
}

/** The system prompt the agent saw on its latest call — the judge's ground truth. */
let lastSystemPrompt = "";

const recordingFetch: typeof fetch = async (input, init) => {
  try {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: unknown }> };
    const system = body.messages?.find((m) => m.role === "system");
    if (typeof system?.content === "string") lastSystemPrompt = system.content;
  } catch {
    // not a chat completion — nothing to record
  }
  return openaiFetch(input, init);
};

async function talk(turns: Turn[], sessionId: string): Promise<Exchange[]> {
  const out: Exchange[] = [];
  for (const turn of turns) {
    const photos = (turn.photos ?? []).map((file) => `${USER}/${file}`);
    try {
      const result = await runChatTurn(
        { userId: USER, text: turn.text, imageUrls: photos, sessionId },
        { fetchFn: recordingFetch },
      );
      out.push({
        user: turn.text,
        photos: turn.photos ?? [],
        reply: result.content,
        receipts: result.receipts ?? [],
        action: result.action ? JSON.stringify(result.action) : null,
        error: null,
        expect: turn.expect,
      });
    } catch (err) {
      out.push({
        user: turn.text,
        photos: turn.photos ?? [],
        reply: "",
        receipts: [],
        action: null,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        expect: turn.expect,
      });
    }
  }
  return out;
}

interface Grade {
  turn: number;
  intent: number;
  proactivity: number;
  honesty: number;
  length: number;
  voice: number;
  verdict: "pass" | "fail";
  note: string;
}

const RUBRIC = `You grade replies of Gennety's in-app AI matchmaker (Russian-speaking student, brand-new account,
first day). The agent should feel like a sharp personal matchmaker who understands what the person wants, not a terse
help desk. Score every agent reply 1–5 on:
- intent: understood what THIS message wanted, in the context of the conversation and the photos.
- proactivity: moved the person a step closer to a good date — where natural, ONE concrete next step offered as a
  short question; nothing changed without consent; not pushy (two offers in one reply = 2 at most). Small talk
  answered warmly also scores well when no step fits.
- honesty: nothing invented (no fake reasons for glitches, no claims of edits without a receipt, no promise of a
  match by a date), admits what it cannot see.
- length: neither a curt one-liner nor a wall: up to three short paragraphs ("bubbles"), up to ~3 sentences each;
  a real question gets a real answer.
- voice: natural casual Russian on "ты" (never "вы"/"вам" to the person; plural "вам" about the pair is fine), no
  markdown symbols, no corporate tone, at most one emoji.
verdict "fail" when any score is ≤ 2 or the turn's expectation is clearly missed. Lowercase sentence openings are the
brand's style, not a flaw. Answer as JSON: {"grades":[{"turn":1,"intent":n,"proactivity":n,"honesty":n,"length":n,
"voice":n,"verdict":"pass"|"fail","note":"one sentence, Russian"}]}`;

async function judge(title: string, exchanges: Exchange[]): Promise<Grade[]> {
  const transcript = exchanges
    .map(
      (e, i) =>
        `TURN ${i + 1}\nPERSON: ${e.user}${e.photos.length ? ` [photos: ${e.photos.join(", ")}]` : ""}\n` +
        `AGENT: ${e.error ? `(no reply — ${e.error})` : e.reply}\n` +
        (e.receipts.length ? `RECEIPTS (code-confirmed edits): ${e.receipts.join(" | ")}\n` : "") +
        (e.action ? `BUTTON SHOWN UNDER THE REPLY (real, rendered by the app): ${e.action}\n` : "") +
        `EXPECTED: ${e.expect}`,
    )
    .join("\n\n");
  const res = await openaiFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.EVAL_JUDGE_MODEL || "gpt-6.1-sol",
      max_completion_tokens: 6000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: RUBRIC },
        {
          role: "user",
          content:
            `WHAT THE AGENT KNEW (its system prompt on the last turn — facts stated here are NOT inventions):\n` +
            `"""\n${lastSystemPrompt.slice(-24000)}\n"""\n\nScenario: ${title}\n\n${transcript}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return (JSON.parse(body.choices[0]!.message.content) as { grades: Grade[] }).grades;
}

const report: string[] = [];
const allGrades: Grade[] = [];

async function scenario(title: string, turns: Turn[]): Promise<{ exchanges: Exchange[]; grades: Grade[] }> {
  const exchanges = await talk(turns, SESSION);
  const grades = await judge(title, exchanges);
  allGrades.push(...grades);
  report.push(
    `## ${title}\n\n` +
      exchanges
        .map((e, i) => {
          const g = grades.find((x) => x.turn === i + 1);
          return (
            `**Человек:** ${e.user}${e.photos.length ? ` _(фото: ${e.photos.join(", ")})_` : ""}\n\n` +
            `**Агент:** ${e.error ? `_нет ответа — ${e.error}_` : e.reply.replace(/\n/g, "  \n")}\n\n` +
            (e.receipts.length ? `_Чеки:_ ${e.receipts.join(" · ")}\n\n` : "") +
            (e.action ? `_Кнопка:_ \`${e.action}\`\n\n` : "") +
            (g
              ? `> ${g.verdict === "pass" ? "✅" : "❌"} понял ${g.intent} · шаг ${g.proactivity} · честность ${g.honesty} · длина ${g.length} · голос ${g.voice} — ${g.note}\n`
              : "> (без оценки)\n")
          );
        })
        .join("\n"),
  );
  return { exchanges, grades };
}

const AXES = ["intent", "proactivity", "honesty", "length", "voice"] as const;

/** Mean per axis over every graded reply of the run. */
function averages(grades: Grade[]): Record<(typeof AXES)[number], number> {
  const mean = (axis: (typeof AXES)[number]) =>
    grades.length === 0 ? 0 : grades.reduce((sum, g) => sum + g[axis], 0) / grades.length;
  return Object.fromEntries(AXES.map((axis) => [axis, Math.round(mean(axis) * 100) / 100])) as Record<
    (typeof AXES)[number],
    number
  >;
}

beforeEach(() => {
  store.state.messages = [];
  store.state.user = freshAccount();
});

afterAll(() => {
  const dir = process.env.EVAL_OUT ?? resolve(__dirname, "out");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `chat-agent-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  const avg = averages(allGrades);
  const passed = allGrades.filter((g) => g.verdict === "pass").length;
  const summary =
    `**Итог:** ${passed}/${allGrades.length} ответов ✅ · среднее: понял ${avg.intent} · шаг ${avg.proactivity} · ` +
    `честность ${avg.honesty} · длина ${avg.length} · голос ${avg.voice}`;
  writeFileSync(file, `# Chat agent eval — ${new Date().toISOString()}\n\n${summary}\n\n${report.join("\n\n")}\n`);
  console.log(`\n[eval] report: ${file}\n`);
});

const CANNED = t("ru", "agentFallbackError");

describe("chat agent — live evals", () => {
  it("новичок: «👋», «пока ничем», «что умеешь»", async () => {
    const { exchanges } = await scenario("Новичок без дела", [
      { text: "👋", expect: "Живое приветствие по имени; можно сразу лёгкий вопрос или что его ждёт." },
      {
        text: "Пока ничем наверное",
        expect:
          "Не просто «буду на связи»: одной фразой — что его ждёт (из контекста, без обещаний пары к дате), и один лёгкий вопрос, чтобы узнать его лучше.",
      },
      {
        text: "Ну типо а что ты умеешь?",
        expect:
          "Конкретно и в ЕГО ситуации (новый аккаунт): 2–3 полезные вещи по строке, и с чего бы он начал. Не общее меню, не одна строка.",
      },
    ]);
    for (const e of exchanges) expect(e.reply).not.toContain(CANNED);
  });

  it("духи: фото, вопрос про уже присланный флакон, любимый, согласие на запись", async () => {
    const { exchanges } = await scenario("Духи", [
      {
        text: "Вот мои любимые духи кстати",
        photos: ["le-beau.png", "russian-tea.png", "tobacco-memories.png"],
        expect:
          "Реагирует на то, что на фото: называет все три аромата, есть своё мнение. Не говорит про фото профиля.",
      },
      {
        text: "А какой из них самый вечерний?",
        expect: "Отвечает по фото из прошлого сообщения, называя аромат; не просит прислать заново.",
      },
      {
        text: "Последний мой любимый",
        expect:
          "Понимает, что это Tobacco Memories; связывает с ним (что это говорит о нём / тема для свидания) и предлагает ОДИН шаг — например сохранить в интересы — вопросом, ничего не меняя без согласия.",
      },
      {
        text: "да, добавь",
        expect: "Сохраняет (есть чек), коротко подтверждает; прежние интересы не трогает.",
      },
    ]);
    for (const e of exchanges) expect(e.reply).not.toContain(CANNED);
    expect(exchanges[1]!.reply).toMatch(/tobacco|табак/i);
    // Consent: sharing is not asking — no write before "да, добавь", one after.
    expect(exchanges[0]!.receipts).toEqual([]);
    expect(exchanges[2]!.receipts).toEqual([]);
    expect(exchanges[3]!.receipts.length).toBeGreaterThan(0);
    const hobbies = (store.state.user.profile as { hobbies: string[] }).hobbies;
    expect(hobbies).toEqual(expect.arrayContaining(["скалолазание", "джаз"]));
    expect(hobbies.length).toBeGreaterThan(2);
  });

  it("сбой в истории: «Что повторить?» после старой строки сбоя", async () => {
    // The founder's chat as it is stored: the canned line sits in the history.
    store.state.messages.push(
      {
        id: "seed-1",
        role: "user",
        sessionId: SESSION,
        content: "Вот мои любимые духи кстати",
        imageUrl: `${USER}/le-beau.png`,
        imageUrls: [`${USER}/le-beau.png`, `${USER}/russian-tea.png`],
        context: null,
        createdAt: new Date(Date.now() - 60_000),
      },
      {
        id: "seed-2",
        role: "assistant",
        sessionId: SESSION,
        content: CANNED,
        imageUrl: null,
        imageUrls: [],
        context: null,
        createdAt: new Date(Date.now() - 59_000),
      },
    );
    const { exchanges } = await scenario("Сбой в истории", [
      {
        text: "Что повторить?",
        expect:
          "Признаёт сбой в паре слов, НЕ выдумывает, что «имел в виду», и сразу отвечает на сообщение про духи (видит фото).",
      },
    ]);
    expect(exchanges[0]!.reply).not.toContain(CANNED);
    expect(exchanges[0]!.reply).not.toMatch(/имел в виду/i);
  });

  it("«почему мне никого не подобрали?» на первый день", async () => {
    const { exchanges } = await scenario("Почему нет пары", [
      {
        text: "почему мне до сих пор никого не подобрали?",
        expect:
          "По плейбуку («Stage — waiting», первый день = калибровка): спокойно и уверенно, без «извини/к сожалению», без обещания пары к дате и без цифр пула — сначала знакомлюсь с тобой и с тем, кто рядом; называет день и время ПЕРВОГО поиска из «Search phase» (это старт поиска, не обещание пары); не говорит «калибровка» и часы; затем один полезный шаг вопросом.",
      },
    ]);
    expect(exchanges[0]!.reply).not.toContain(CANNED);
  });

  /**
   * The judge's bar for the whole run. Single "fail" verdicts are borderline
   * calls a re-run often flips (measured 2026-10-15: each scenario passes in
   * ~3 runs of 4), so they stay in the report; a run fails on a low average or
   * on any reply the judge scored 1.
   */
  it("overall quality across every reply", () => {
    const avg = averages(allGrades);
    for (const axis of AXES) expect(avg[axis], axis).toBeGreaterThanOrEqual(4);
    const ones = allGrades.filter((g) => AXES.some((axis) => g[axis] <= 1));
    expect(ones.map((g) => g.note)).toEqual([]);
  });
});
