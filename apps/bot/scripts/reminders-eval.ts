/**
 * Personal reminders — live-model check (spec `docs/product/domains/agent-reminders.md`, Phase 6).
 *
 * The real agent model, with the persona, the agent-concept block (its clock
 * line fixed to Wed 18 Nov 2026, 14:00 Kyiv) and the production tools, gets
 * one message per case. Checks that `set_reminder` is called only on a real
 * request, that the local time resolves right in five languages, and that a
 * «come back» or a date reminder is not set. No DB: the tool call is read, and
 * the code-side checks are the module's own.
 *
 * Usage (needs OPENAI_API_KEY in .env / .env.local at the repo root):
 *   apps/bot/node_modules/.bin/tsx apps/bot/scripts/reminders-eval.ts [--runs=2] [--out=tmp/reminders-eval.md]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const { MODELS, normalizeChatCompletion } = await import("../src/models.js");
const { personaFor } = await import("../src/services/prompt-builder.js");
const { agentConceptBlocks } = await import("../src/services/agent-concept.js");
// The full tool set needs the bot's config; a date tool stands in for the rest.
const AGENT_TOOLS = [
  {
    type: "function" as const,
    function: { name: "get_my_date", description: "Read their booked date: place and time.", parameters: { type: "object", properties: {} } },
  },
];
const { REMINDER_TOOLS, backToChatText, localToInstant, reminderClockBlock } = await import("../src/services/agent-reminders.js");

const NOW = new Date("2026-11-18T12:00:00Z"); // Wed 14:00 in Kyiv
const ZONE = "Europe/Kyiv";

interface Case {
  name: string;
  lang: string;
  before?: string[];
  ask: string;
  /** Expected local day `YYYY-MM-DD` (and hour) of a set reminder, or null = must not set. */
  day: string | null;
  hour?: number;
  exact?: boolean;
  extra?: string;
}

const CASES: Case[] = [
  { name: "friday, no time", lang: "ru", ask: "напомни в пятницу написать Маше", day: "2026-11-20", hour: 10 },
  { name: "tomorrow evening", lang: "ru", ask: "напомни завтра вечером купить цветы", day: "2026-11-19", hour: 19 },
  { name: "exact time", lang: "en", ask: "remind me at 23:30 tonight to text him goodnight", day: "2026-11-18", hour: 23, exact: true },
  { name: "german saturday", lang: "de", ask: "Erinnere mich am Samstag, Mama anzurufen", day: "2026-11-21", hour: 10 },
  { name: "ukrainian sunday evening", lang: "uk", ask: "нагадай у неділю ввечері подзвонити Олі", day: "2026-11-22", hour: 19 },
  { name: "polish in a week", lang: "pl", ask: "przypomnij mi za tydzień, żeby zapytać ją o sobotę", day: "2026-11-25" },
  { name: "chip tap after advice", lang: "ru", before: ["Писать ей сейчас или подождать?", "Подожди до пятницы и напиши одно сообщение: «Как прошла неделя? Давай в субботу на кофе?»"], ask: "Напомни в пятницу", day: "2026-11-20" },
  { name: "vague time", lang: "ru", ask: "напомни потом позвонить в кафе", day: null },
  { name: "come back to the chat", lang: "ru", ask: "напомни мне завтра вернуться и поговорить с тобой", day: null },
  { name: "booked date", lang: "ru", ask: "напомни мне про свидание в субботу", day: null, extra: "- Booked date: Saturday 21 Nov 2026, 19:30, «Синяя птица». The product sends its own reminders before it." },
  { name: "not a request", lang: "ru", ask: "в субботу свидание, я уже нервничаю", day: null },
  { name: "list", lang: "ru", ask: "какие у меня напоминания?", day: null },
];

function localParts(at: Date): { day: string; hour: number } {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", hourCycle: "h23" }).format(at));
  return { day, hour };
}

async function turn(c: Case): Promise<{ reply: string; calls: Array<{ name: string; args: Record<string, unknown> }> }> {
  const system = [
    personaFor("app"),
    `## Current User Context\n- Name: Саша\n- Preferred language: ${c.lang}${c.extra ? `\n${c.extra}` : ""}`,
    reminderClockBlock(NOW, ZONE),
    ...agentConceptBlocks({ now: NOW, timeZone: ZONE, relationshipIntents: ["longterm"], surface: "app" }, true),
  ].join("\n\n");
  const before = c.before ?? [];
  const messages = [
    { role: "system", content: system },
    ...before.map((text, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: text })),
    { role: "user", content: c.ask },
  ];
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(
      normalizeChatCompletion({ model: MODELS.agent, messages, tools: [...AGENT_TOOLS, ...REMINDER_TOOLS], tool_choice: "auto", max_completion_tokens: 600 }),
    ),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return { reply: `‼ HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, calls: [] };
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>;
  };
  const msg = json.choices?.[0]?.message;
  return {
    reply: msg?.content?.trim() ?? "",
    calls: (msg?.tool_calls ?? []).map((tc) => ({ name: tc.function.name, args: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown> })),
  };
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const runs = Number(process.argv.find((a) => a.startsWith("--runs="))?.slice(7) ?? "2") || 2;
  const out = resolve(repoRoot, process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "tmp/reminders-eval.md");
  const lines: string[] = [`# Reminders eval — ${new Date().toISOString()} — agent ${MODELS.agent}, now = Wed 18 Nov 2026 14:00 Kyiv\n`];
  let failures = 0;
  let total = 0;
  for (let run = 1; run <= runs; run++) {
    for (const c of CASES) {
      total++;
      const { reply, calls } = await turn(c);
      const set = calls.find((x) => x.name === "set_reminder");
      const problems: string[] = [];
      if (c.day === null) {
        // A set call is fine only when the code refuses it.
        if (set && !backToChatText(String(set.args.text ?? ""))) problems.push(`set a reminder it should not: ${JSON.stringify(set.args)}`);
        if (c.name === "list" && !calls.some((x) => x.name === "list_reminders")) problems.push("did not list");
      } else if (!set) {
        problems.push("no set_reminder call");
      } else {
        const at = typeof set.args.local_time === "string" ? localToInstant(set.args.local_time, ZONE) : null;
        if (!at) problems.push(`bad local_time ${String(set.args.local_time)}`);
        else {
          const p = localParts(at);
          if (p.day !== c.day) problems.push(`day ${p.day} ≠ ${c.day}`);
          if (c.hour !== undefined && p.hour !== c.hour) problems.push(`hour ${p.hour} ≠ ${c.hour}`);
        }
        if (c.exact !== undefined && set.args.exact_time !== c.exact) problems.push(`exact_time ${String(set.args.exact_time)}`);
        if (backToChatText(String(set.args.text ?? ""))) problems.push("text reads as back-to-chat");
      }
      if (problems.length) failures++;
      lines.push(
        `## ${c.name} (${c.lang})${runs > 1 ? ` — run ${run}` : ""}\n**Person:** ${c.ask}\n\n` +
          `**Tool calls:** ${calls.length ? calls.map((x) => `\`${x.name}\` ${JSON.stringify(x.args)}`).join("; ") : "—"}\n\n` +
          `**Reply:** ${reply.replace(/\n+/g, " ") || "—"}\n\n**Verdict:** ${problems.length ? `❌ ${problems.join("; ")}` : "✅"}\n`,
      );
      process.stdout.write(`${total}/${CASES.length * runs}\r`);
    }
  }
  lines.splice(1, 0, `Cases: ${total}, failed: ${failures}.\n`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join("\n"));
  console.log(`\nwrote ${out}\nfailed ${failures}/${total}`);
}

await main();
