import { MODELS } from "../models.js";
import { env } from "../config.js";
import { openaiFetch } from "./openai-fetch.js";

/**
 * Consent gate for profile writes in the app chat (2026-10-15).
 *
 * The persona says "never change anything on your own initiative", and the
 * live evals showed the agent model (Luna, no reasoning with tools) ignores it
 * for exactly the case the founder hit: "вот мои любимые духи" was saved to
 * the profile on the spot, and so was "последний мой любимый". Sharing a fact
 * is not asking to store it. A prompt rule alone did not hold, so the code
 * asks a second, narrow question before any profile write runs: did the
 * person ask for this change, or say yes to an offer, in their last message?
 *
 * Fails OPEN: if the check itself cannot answer, the write goes through as it
 * did before the gate — this protects the quality of the conversation, not
 * the account, and a broken check must not swallow an explicit "add jazz".
 */

/** Writes that put words into the person's profile — the ones the agent infers. */
export const CONSENT_GATED_TOOLS = new Set([
  "update_bio",
  "update_major",
  "update_age_range",
  "update_partner_preferences",
  "update_hobbies",
  "update_profile",
]);

const TIMEOUT_MS = 8_000;

const SYSTEM = `You check one thing for a dating app's chat assistant: did the person ask for, or agree to, the
proposed profile change in their LAST message?
- An explicit request is consent: "добавь джаз в интересы", "поменяй о себе", "set my age range to 20-25".
- A yes to the assistant's offer just before is consent: "да", "давай", "ok", "добавь", "конечно".
- Sharing a fact, a taste or a favourite is NOT consent: "вот мои любимые духи", "последний мой любимый",
  "I love jazz", "я учусь на программиста" — unless they also ask to save it.
Answer only JSON: {"consent": true} or {"consent": false}.`;

export interface ConsentQuestion {
  /** The assistant's previous message, if any — the offer being answered. */
  previous: string;
  /** The person's last message. */
  message: string;
  tool: string;
  args: unknown;
}

export async function personConsented(question: ConsentQuestion): Promise<boolean> {
  if (!env.OPENAI_API_KEY) return true;
  try {
    const res = await openaiFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: MODELS.fast,
        max_completion_tokens: 20,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content:
              `Assistant's previous message: ${question.previous || "(none)"}\n` +
              `Person's last message: ${question.message || "(photos only, no text)"}\n` +
              `Proposed change: ${question.tool} ${JSON.stringify(question.args)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[chat] consent check failed: HTTP ${res.status} — allowing the write`);
      return true;
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as { consent?: unknown };
    return parsed.consent !== false;
  } catch (err) {
    console.warn("[chat] consent check error — allowing the write:", err);
    return true;
  }
}
