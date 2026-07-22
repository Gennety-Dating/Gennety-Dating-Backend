/**
 * Single source of truth for the OpenAI chat/vision model used at every call
 * site. Historically each service hardcoded its own model string, so an OpenAI
 * generation retirement (e.g. GPT-5.4 → GPT-5.6, 2026-07) meant hunting through
 * a dozen files; now it is a one-line change here (or a live env override).
 *
 * Roles map to the GPT-5.6 tiers (`terra` = balanced ≈GPT-5.5, `luna` =
 * fast/cheap nano-successor; both are vision-capable):
 *   - `vision`     — quality-sensitive, matching-critical vision (the Elo
 *                    attractiveness seed). Low volume (once per verification),
 *                    so it gets the stronger tier.
 *   - `visionFast` — simple, higher-volume per-photo checks (face presence,
 *                    duplicate detection).
 *   - `agent`      — conversational agents + user-facing generation (onboarding,
 *                    menu, Aether, pitch, match-card copy, the shared prompt
 *                    pipeline default) where reasoning/quality matters.
 *   - `fast`       — cheap classification + short templated DMs (decision-intent,
 *                    nudge / announce / re-engagement workers).
 *
 * Each role is env-overridable so a future retirement can be hotfixed with
 * `pm2 restart --update-env` — no redeploy. Defaults apply when the override is
 * unset. `config.ts` loads `.env`/`.env.local` before any service (and thus this
 * module) is first imported (index.ts imports config first), so the overrides
 * are populated by the time they're read.
 *
 * Kept deliberately SEPARATE from `config.ts`: many unit tests `vi.mock` the
 * config module with a hand-rolled `env`, and routing models through config
 * would make `MODELS` undefined in every one of those tests. This module has no
 * `BOT_TOKEN`/dotenv coupling, so mocking config never disturbs it.
 *
 * Embeddings / Whisper / moderation live at their own call sites and are
 * deliberately NOT routed through here (changing the embedding model forces a
 * full re-embed of every profile — a separate decision).
 */
export const MODELS = {
  vision: process.env.OPENAI_MODEL_VISION ?? "gpt-5.6-terra",
  visionFast: process.env.OPENAI_MODEL_VISION_FAST ?? "gpt-5.6-luna",
  agent: process.env.OPENAI_MODEL_AGENT ?? "gpt-5.6-terra",
  fast: process.env.OPENAI_MODEL_FAST ?? "gpt-5.6-luna",
} as const;
