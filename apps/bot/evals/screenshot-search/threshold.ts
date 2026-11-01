/**
 * Measures `SCREENSHOT_MATCH_MAX_DISTANCE` on the labelled set, with the real
 * embedding model. Cosine distance here is what pgvector's `<=>` computes.
 *
 *   OPENAI_API_KEY=… pnpm --filter @gennety/bot exec tsx evals/screenshot-search/threshold.ts
 *
 * Prints, per candidate limit, how many relevant items are found and how many
 * negatives wrongly get an answer. It chooses nothing: a person reads it and then
 * changes the constant. It uses meaning only, as exact words are matched before it.
 * Without a key it says so and exits 2; it never falls back to a made-up figure.
 */
import { MODELS } from "../../src/models.js";
import { LABELLED_ITEMS, LABELLED_QUERIES } from "./labelled-set.js";

const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.error("No OPENAI_API_KEY: nothing measured.");
  process.exit(2);
}

async function embedAll(input: string[]): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODELS.embedding, input }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}`);
  const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

function distance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return 1 - dot / Math.sqrt(na * nb);
}

const itemVectors = await embedAll(LABELLED_ITEMS.map((i) => [i.title, i.description, i.ocr].filter(Boolean).join("\n")));
const queryVectors = await embedAll(LABELLED_QUERIES.map((q) => q.query));

const positives = LABELLED_QUERIES.flatMap((q, qi) => q.relevant.map((key) => ({ qi, key })));
const negatives = LABELLED_QUERIES.map((q, qi) => ({ q, qi })).filter(({ q }) => q.relevant.length === 0);
const dist = (qi: number, ii: number) => distance(queryVectors[qi]!, itemVectors[ii]!);

for (let limit = 0.3; limit <= 0.9001; limit += 0.04) {
  const found = positives.filter(({ qi, key }) => dist(qi, LABELLED_ITEMS.findIndex((i) => i.key === key)) <= limit).length;
  const falseAnswers = negatives.filter(({ qi }) => LABELLED_ITEMS.some((_, ii) => dist(qi, ii) <= limit)).length;
  const offered = LABELLED_QUERIES.reduce((sum, _, qi) => sum + LABELLED_ITEMS.filter((_, ii) => dist(qi, ii) <= limit).length, 0);
  console.log(`limit ${limit.toFixed(2)}: found ${found}/${positives.length} relevant; ${falseAnswers}/${negatives.length} negatives get an answer; ${offered} offered in all`);
}
