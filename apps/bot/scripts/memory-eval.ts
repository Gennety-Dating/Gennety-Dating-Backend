/**
 * Long-term memory eval (spec `docs/product/domains/long-term-memory.md`,
 * phase 9.3). Two stages on the real models, no DB:
 *
 *  1. The writer (`MODELS.fast`) reads three earlier conversations — two in the
 *     app, one in Telegram — one after another, each next to the notes the
 *     previous ones left, exactly as `askWriter` does live. Operations are
 *     applied to an in-memory store with the server's checks (kind, caps,
 *     never-list, own ids).
 *  2. The agent (`MODELS.agent`) gets a NEW chat with the persona, the memory
 *     rules and block, and the four memory tools run against that store. It
 *     must bring up the right thing at the right moment, say it does not
 *     remember what it was never told, list its notes on request without the
 *     health detail, and forget on request.
 *
 * Writes a markdown report (default tmp/memory-eval.md) plus a pass/fail line
 * per check. Usage (repo root; OPENAI_API_KEY in .env / .env.local, or point
 * GENNETY_ENV_DIR at a checkout that has them):
 *   pnpm --filter @gennety/bot exec tsx scripts/memory-eval.ts [--out=tmp/memory-eval.md]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../..");
for (const dir of [repoRoot, process.env.GENNETY_ENV_DIR].filter(Boolean) as string[]) {
  loadEnv({ path: join(dir, ".env.local") });
  loadEnv({ path: join(dir, ".env") });
}

const { MODELS, normalizeChatCompletion } = await import("../src/models.js");
const { personaFor } = await import("../src/services/prompt-builder.js");
const { askWriter, renderTranscript } = await import("../src/services/agent-memory-writer.js");
const { renderMemoryBlock, parseDay } = await import("../src/services/agent-memory.js");
const { AGENT_MEMORY_TOOLS } = await import("../src/services/agent-memory-tools.js");
const shared = await import("@gennety/shared");
const { AGENT_MEMORY_RULES, AGENT_MEMORY_STATEFUL_KINDS, AGENT_MEMORY_TEXT_MAX, isNeverRemembered } = shared;

type Note = Parameters<typeof renderMemoryBlock>[0][number];
type Line = { role: "user" | "assistant"; text: string; at: Date | null };

/* ── In-memory store with the server's checks ──────────────── */

const notes: Note[] = [];
const refusedLog: string[] = [];

function addNote(input: { kind: unknown; text: unknown; subject?: unknown; date?: unknown; recurring?: unknown; provenance: "told" | "noticed"; surface: "app" | "telegram" }, at: Date): Note | string {
  const kinds = shared.AGENT_MEMORY_KINDS as readonly string[];
  if (typeof input.kind !== "string" || !kinds.includes(input.kind)) return "bad-input";
  const text = typeof input.text === "string" ? input.text.trim().slice(0, AGENT_MEMORY_TEXT_MAX) : "";
  const subject = typeof input.subject === "string" && input.subject.trim() ? input.subject.trim().slice(0, 60) : null;
  if (!text) return "bad-input";
  if (isNeverRemembered(text) || (subject && isNeverRemembered(subject))) {
    refusedLog.push(subject ? `${subject}: ${text}` : text);
    return "never-kept";
  }
  const kind = input.kind as Note["kind"];
  const note: Note = {
    id: randomUUID(),
    kind,
    text,
    subject,
    dueOn: parseDay(input.date) ? (input.date as string) : null,
    recurring: kind === "date" && input.recurring === true,
    status: AGENT_MEMORY_STATEFUL_KINDS.includes(kind) ? "open" : null,
    outcome: null,
    provenance: input.provenance,
    surface: input.surface,
    lastSeenAt: at,
    createdAt: at,
  };
  notes.push(note);
  return note;
}

function view(n: Note): Record<string, unknown> {
  return { id: n.id, kind: n.kind, text: n.text, subject: n.subject, date: n.dueOn, status: n.status, outcome: n.outcome, since: n.lastSeenAt.toISOString().slice(0, 7) };
}

/* ── Stage 1: the writer ───────────────────────────────────── */

const d = (s: string) => new Date(s);
const CONVERSATIONS: Array<{ surface: "app" | "telegram"; today: string; lines: Line[] }> = [
  {
    surface: "app",
    today: "Mon, 2026-11-03",
    lines: [
      { role: "user", at: d("2026-11-03T18:02:00Z"), text: "привет) слушай, у меня завтра первое свидание за год, я жутко нервничаю. я всегда первые полчаса как деревянная" },
      { role: "assistant", at: d("2026-11-03T18:02:30Z"), text: "Это нормально — первые полчаса зажаты почти все. Договорись о прогулке, а не о сидении напротив: в движении разговор идёт легче." },
      { role: "user", at: d("2026-11-03T18:04:00Z"), text: "ага. я вообще на 3 курсе КПИ, сессия скоро, времени мало. и у меня тревожность, я пью таблетки, может из-за этого" },
      { role: "assistant", at: d("2026-11-03T18:04:40Z"), text: "Понимаю. Тогда тем более короткий формат: час прогулки, без обязательств." },
      { role: "user", at: d("2026-11-03T18:06:00Z"), text: "моя старшая сестра Маша говорит, что я слишком много думаю. я с ней всегда советуюсь" },
      { role: "assistant", at: d("2026-11-03T18:06:20Z"), text: "Маша права наполовину: думать — нормально, накручивать — нет." },
    ],
  },
  {
    surface: "telegram",
    today: "Mon, 2026-11-10",
    lines: [
      { role: "user", at: d("2026-11-10T19:00:00Z"), text: "короче есть парень из спортзала, Олег. переписываемся неделю, я не знаю, звать ли его куда-то самой" },
      { role: "assistant", at: d("2026-11-10T19:00:40Z"), text: "Зови. Напиши ему первой до выходных и предложи конкретное: кофе в субботу. Потом расскажешь, как вышло." },
      { role: "user", at: d("2026-11-10T19:02:00Z"), text: "ок, попробую. его инста @oleg.gym если что, посмотри какой он)" },
      { role: "assistant", at: d("2026-11-10T19:02:20Z"), text: "Я в инстаграм не захожу — но судя по тому, как он пишет, шанс хороший." },
      { role: "user", at: d("2026-11-10T19:05:00Z"), text: "и ещё напомни мне потом, у Маши др 3 декабря, надо подарок придумать" },
      { role: "assistant", at: d("2026-11-10T19:05:20Z"), text: "Запомнил: 3 декабря у Маши день рождения. Ближе к делу подкинем идеи." },
    ],
  },
  {
    surface: "app",
    today: "Sat, 2026-11-15",
    lines: [
      { role: "user", at: d("2026-11-15T12:00:00Z"), text: "я написала Олегу!! он согласился, идём в кино в субботу 22-го" },
      { role: "assistant", at: d("2026-11-15T12:00:30Z"), text: "Вот это да, горжусь. Кино — хороший старт, только после сеанса зайдите куда-нибудь поговорить." },
      { role: "user", at: d("2026-11-15T12:02:00Z"), text: "да, так и сделаем. кстати я ненавижу шумные бары, так что точно не бар" },
    ],
  },
];

async function writerStage(report: string[]): Promise<void> {
  report.push(`## Stage 1 — writer (${MODELS.fast})\n`);
  for (const [i, c] of CONVERSATIONS.entries()) {
    const ops = await askWriter({ notes, transcript: renderTranscript(c.lines), language: "Russian", today: c.today });
    report.push(`### Conversation ${i + 1} (${c.surface}, ${c.today})\n\`\`\`json\n${JSON.stringify(ops, null, 1)}\n\`\`\``);
    if (!ops) continue;
    const at = c.lines[c.lines.length - 1]!.at!;
    const own = new Set(notes.map((n) => n.id));
    for (const op of ops) {
      if (op.op === "add") addNote({ ...op, provenance: "noticed", surface: c.surface }, at);
      else if (op.id && own.has(op.id)) {
        const n = notes.find((x) => x.id === op.id)!;
        if (op.text && !isNeverRemembered(op.text)) n.text = op.text;
        if (op.subject) n.subject = op.subject;
        if (op.date && parseDay(op.date)) n.dueOn = op.date;
        if (op.op === "resolve" && AGENT_MEMORY_STATEFUL_KINDS.includes(n.kind)) {
          n.status = "resolved";
          n.outcome = op.outcome;
        }
        n.lastSeenAt = at;
      }
    }
  }
  report.push(`### Notes after the writer\n${notes.map((n) => `- [${n.kind}${n.status ? `/${n.status}` : ""}] ${n.subject ? `${n.subject}: ` : ""}${n.text}${n.dueOn ? ` (${n.dueOn}${n.recurring ? ", yearly" : ""})` : ""}${n.outcome ? ` → ${n.outcome}` : ""}`).join("\n")}`);
  if (refusedLog.length) report.push(`Refused by the never-list: ${refusedLog.map((t) => `«${t}»`).join(", ")}`);
}

/* ── Stage 2: the agent in a new chat ──────────────────────── */

let armedForgetAll = false;
function runTool(name: string, args: Record<string, unknown>): string {
  const ok = (p: Record<string, unknown>) => JSON.stringify({ success: true, ...p });
  if (name === "recall") {
    const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
    const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
    const hits = words.length
      ? notes.filter((n) => words.some((w) => `${n.subject ?? ""} ${n.text}`.toLowerCase().includes(w.slice(0, Math.max(3, w.length - 2)))))
      : notes;
    return ok({
      notes: hits.map(view),
      ...(hits.length === 0 ? { instruction: q ? "Nothing about that in your notes: you do not remember it. Say so plainly and ask — never invent." : "You keep no notes about them yet." } : {}),
    });
  }
  if (name === "remember") {
    const r = addNote({ ...args, date: args.date, provenance: "told", surface: "app" }, new Date());
    return typeof r === "string" ? JSON.stringify({ success: false, error: r }) : ok({ note: view(r) });
  }
  if (name === "update_memory") {
    const n = notes.find((x) => x.id === args.id);
    if (!n) return JSON.stringify({ success: false, error: "not-found" });
    if (typeof args.text === "string") n.text = args.text;
    if (args.resolved === true) {
      n.status = "resolved";
      n.outcome = typeof args.outcome === "string" ? args.outcome : null;
    }
    return ok({ note: view(n) });
  }
  if (name === "forget_memory") {
    if (args.all === true) {
      armedForgetAll = true;
      return JSON.stringify({ success: false, error: "needs_confirmation", instruction: "NOTHING forgotten yet. Ask «точно всё?»." });
    }
    const i = notes.findIndex((x) => x.id === args.id);
    if (i < 0) return JSON.stringify({ success: false, error: "bad_id", instruction: "Call recall first and use its id." });
    notes.splice(i, 1);
    return ok({ forgotten: 1 });
  }
  return JSON.stringify({ success: false, error: "unknown_tool" });
}

type Msg = { role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; tool_call_id?: string };

async function agentTurn(system: string, history: Msg[], text: string, calls: string[]): Promise<string> {
  history.push({ role: "user", content: text });
  for (let round = 0; round < 5; round++) {
    const body = normalizeChatCompletion({
      model: MODELS.agent,
      messages: [{ role: "system", content: system }, ...history],
      tools: AGENT_MEMORY_TOOLS,
      tool_choice: "auto",
      max_completion_tokens: 700,
    });
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return `‼ HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    const msg = ((await res.json()) as { choices: Array<{ message: Msg }> }).choices[0]!.message;
    history.push({ role: "assistant", content: msg.content ?? null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg.tool_calls?.length) return (msg.content ?? "").trim();
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        // empty
      }
      calls.push(`${tc.function.name}(${JSON.stringify(args)})`);
      history.push({ role: "tool", tool_call_id: tc.id, content: runTool(tc.function.name, args) });
    }
  }
  return "‼ too many tool rounds";
}

interface Check {
  name: string;
  ask: string;
  pass: (reply: string, calls: string[]) => boolean;
}

const CHECKS: Check[] = [
  {
    name: "brings up the open story without being asked",
    ask: "привет! я вернулась",
    pass: (r) => /олег|кино/i.test(r),
  },
  {
    name: "knows the sister and her birthday",
    ask: "слушай, что подарить сестре? у неё скоро др",
    pass: (r) => /маш/i.test(r) && /3 декабр|через \d+ дн|девять дней|9 дней/i.test(r),
  },
  {
    name: "says it does not remember what it was never told",
    ask: "а помнишь, как зовут парня из бассейна, про которого я рассказывала?",
    pass: (r) => /не помню|не рассказывала|нет такого|не знаю|не припомин|не нахожу|нет в памяти|не говорила/i.test(r) && !/зовут [А-Я][а-я]+/.test(r.replace(/Олег/g, "")),
  },
  {
    name: "lists what it remembers, without the health detail",
    ask: "а что ты вообще обо мне помнишь?",
    pass: (r, calls) => calls.some((c) => c.startsWith("recall")) && /маш/i.test(r) && !/тревож|таблет/i.test(r),
  },
  {
    name: "forgets on request",
    ask: "забудь, пожалуйста, всё про Олега",
    pass: (_r, calls) => calls.some((c) => c.startsWith("forget_memory")) && !notes.some((n) => /олег/i.test(`${n.subject ?? ""} ${n.text}`)),
  },
];

async function agentStage(report: string[]): Promise<{ passed: number; total: number }> {
  const now = new Date("2026-11-24T10:00:00Z");
  report.push(`\n## Stage 2 — agent in a new chat (${MODELS.agent}), today ${now.toISOString().slice(0, 10)}\n`);
  const history: Msg[] = [];
  let passed = 0;
  for (const check of CHECKS) {
    // The block is rebuilt each turn from the live store, as on production.
    const block = renderMemoryBlock(notes, now, "Europe/Kyiv");
    const system = [personaFor("app"), "## Current User Context\n- Name: Саша\n- Preferred language: ru", AGENT_MEMORY_RULES, block].filter(Boolean).join("\n\n");
    const calls: string[] = [];
    const reply = await agentTurn(system, history, check.ask, calls);
    const ok = check.pass(reply, calls);
    if (ok) passed += 1;
    report.push(`### ${ok ? "PASS" : "FAIL"} — ${check.name}\n**Саша:** ${check.ask}\n\n**Tools:** ${calls.join(", ") || "—"}\n\n**Gennety:** ${reply.replace(/\n+/g, " ")}\n`);
    console.log(`${ok ? "PASS" : "FAIL"} ${check.name}`);
  }
  void armedForgetAll;
  return { passed, total: CHECKS.length };
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const outArg = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
  const out = resolve(repoRoot, outArg ?? "tmp/memory-eval.md");
  const report: string[] = [`# Memory eval — ${new Date().toISOString()}\n`];
  await writerStage(report);
  const writerChecks = [
    ["sister Masha kept", notes.some((n) => /маш/i.test(`${n.subject ?? ""} ${n.text}`))],
    ["Oleg story kept", notes.some((n) => n.kind === "story" && /олег/i.test(`${n.subject ?? ""} ${n.text}`))],
    ["Masha's birthday as a yearly 12-03", notes.some((n) => n.kind === "date" && n.dueOn?.endsWith("-12-03"))],
    ["no health kept", !notes.some((n) => /тревож|таблет|anxiety|pill/i.test(n.text))],
    ["no handle kept", !notes.some((n) => /@|инст/i.test(n.text))],
  ] as const;
  report.push(`\n### Writer checks\n${writerChecks.map(([name, ok]) => `- ${ok ? "PASS" : "FAIL"} ${name}`).join("\n")}`);
  for (const [name, ok] of writerChecks) console.log(`${ok ? "PASS" : "FAIL"} writer: ${name}`);
  const agent = await agentStage(report);
  const writerPassed = writerChecks.filter(([, ok]) => ok).length;
  report.push(`\n**Total:** writer ${writerPassed}/${writerChecks.length}, agent ${agent.passed}/${agent.total}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report.join("\n"));
  console.log(`writer ${writerPassed}/${writerChecks.length}, agent ${agent.passed}/${agent.total}\nwrote ${out}`);
}

await main();
