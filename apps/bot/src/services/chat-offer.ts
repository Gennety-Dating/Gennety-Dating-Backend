import { prisma, type Prisma } from "@gennety/db";
import {
  MAX_AGE,
  MAX_BIO_LENGTH,
  MAX_HEIGHT_CM,
  MAX_MAJOR_LENGTH,
  MAX_PARTNER_PREFERENCES_LENGTH,
  MIN_AGE,
  MIN_HEIGHT_CM,
  t,
  type Language,
} from "@gennety/shared";
import { CONSENT_GATED_TOOLS } from "./chat-consent.js";

/**
 * The chat agent's change-offer card (decision journal 2026-10-28).
 *
 * The agent used to offer a profile change in prose — «хочешь, добавлю
 * парфюмерный гардероб в твои интересы?» — and the person had to type «да».
 * The founder asked for quick native buttons instead. Now the agent calls
 * `offer_change` with the exact gated tool and arguments it would run; the
 * reply carries a card with the question and two buttons.
 *
 * **The tap is the consent.** `offer_change` writes nothing; it stores the
 * offer on the assistant row (`messages.attachment`, kind `change_offer`).
 * Only `POST /v1/chat/messages/:id/offer` with `accept` runs the stored tool,
 * through the same executors as the agent's own call (same validation, same
 * receipts) — exactly what the card showed, nothing the model re-decides.
 *
 * Capability-gated by `X-Gennety-Chat-Cards: offer`: a build that does not
 * draw the card keeps the prose offer, and Telegram (`menu-agent.ts`) never
 * sees this tool at all.
 */

export const CHANGE_OFFER_KIND = "change_offer";
/** Token an app build lists in `X-Gennety-Chat-Cards` when it draws this card. */
export const OFFER_CARD_CLIENT_TOKEN = "offer";
export const OFFER_CHANGE_TOOL_NAME = "offer_change";

export const OFFER_QUESTION_MAX_LEN = 90;
const ACCEPT_LABEL_MAX_LEN = 24;

export type ChangeOfferState = "open" | "accepted" | "declined" | "expired";

/** Stored on `messages.attachment`. `tool`/`args` never leave the server. */
export interface ChangeOffer {
  kind: typeof CHANGE_OFFER_KIND;
  state: ChangeOfferState;
  question: string;
  acceptLabel: string;
  tool: string;
  args: Record<string, unknown>;
  receipt?: string;
  resolvedAt?: string;
}

/** What the app gets — `ChatChangeOffer` in the OpenAPI contract. */
export interface ChangeOfferView {
  state: ChangeOfferState;
  question: string;
  acceptLabel: string;
  receipt: string | null;
}

/* ── the tool ───────────────────────────────────────────────────────────── */

export const OFFER_CHANGE_TOOL = {
  type: "function" as const,
  function: {
    name: OFFER_CHANGE_TOOL_NAME,
    description:
      "Offer ONE change to their profile as a native card under your reply: your short question and two buttons. Nothing changes until they tap the accept button — then exactly `tool` with `args` runs. Use it instead of asking «хочешь, добавлю…?» in words; your reply text must not repeat the question. At most one per reply. Not for what they explicitly asked you to change (call that tool directly) and not for wishlist items (those go on the wishlist card).",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["tool", "args", "question"],
      properties: {
        tool: {
          type: "string",
          enum: [...CONSENT_GATED_TOOLS],
          description: "The profile tool the tap will run.",
        },
        args: {
          type: "object",
          description:
            "Exactly the arguments that tool takes, e.g. {\"add\": [\"парфюмерия\"]} for update_hobbies, {\"min_age\": 24, \"max_age\": 30} for update_age_range.",
        },
        question: {
          type: "string",
          maxLength: OFFER_QUESTION_MAX_LEN,
          description:
            "Short concrete question in their language naming the exact value, e.g. «Добавить «парфюмерия» в интересы?». At most 90 characters.",
        },
        acceptLabel: {
          type: "string",
          description: "The accept button, 1–2 words in their language: «Добавить», «Сохранить», «Обновить». Defaults to «Да».",
        },
      },
    },
  },
};

/* ── validation: the same rules the executors apply, before anything is shown ── */

type Validated = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

function cleanList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.trim().slice(0, 48))
    .filter((h) => h.length > 0);
}

/**
 * The offered arguments, normalized to what the tool reads — or why the tool
 * would refuse them. Mirrors the executors in `menu-agent.ts` and
 * `applyChatProfilePatch`; checks that need the stored profile (twelve
 * interests at most, a bio rewrite that would wipe most of it) stay with the
 * executor and surface at the tap as a 422.
 */
export function validateOfferArgs(tool: string, raw: unknown): Validated {
  if (!CONSENT_GATED_TOOLS.has(tool)) return { ok: false, error: `tool must be one of: ${[...CONSENT_GATED_TOOLS].join(", ")}` };
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!args) return { ok: false, error: "args must be an object" };

  switch (tool) {
    case "update_hobbies": {
      const add = cleanList(args.add);
      const hobbies = cleanList(args.hobbies);
      if (hobbies) {
        if (hobbies.length === 0) return { ok: false, error: "Hobby list cannot be empty." };
        if (hobbies.length > 12) return { ok: false, error: "At most 12 interests." };
        return { ok: true, args: { hobbies } };
      }
      if (add) {
        if (add.length === 0) return { ok: false, error: "Pass at least one interest in `add`." };
        if (add.length > 12) return { ok: false, error: "At most 12 interests." };
        return { ok: true, args: { add } };
      }
      return { ok: false, error: "Pass `add` (new interests) or `hobbies` (full list)." };
    }
    case "update_bio": {
      const bio = typeof args.bio === "string" ? args.bio.trim() : "";
      if (!bio) return { ok: false, error: "Bio cannot be empty." };
      if (bio.length > MAX_BIO_LENGTH) return { ok: false, error: `Bio must be ${MAX_BIO_LENGTH} characters or less.` };
      return { ok: true, args: { bio } };
    }
    case "update_major": {
      const major = typeof args.major === "string" ? args.major.trim() : "";
      if (!major) return { ok: false, error: "Major cannot be empty." };
      if (major.length > MAX_MAJOR_LENGTH) return { ok: false, error: `Major must be ${MAX_MAJOR_LENGTH} characters or less.` };
      return { ok: true, args: { major } };
    }
    case "update_age_range": {
      const min = args.min_age;
      const max = args.max_age;
      if (
        typeof min !== "number" ||
        typeof max !== "number" ||
        !Number.isInteger(min) ||
        !Number.isInteger(max) ||
        min < MIN_AGE ||
        max > MAX_AGE ||
        min > max
      ) {
        return { ok: false, error: `Age range must be between ${MIN_AGE} and ${MAX_AGE}, with min ≤ max.` };
      }
      return { ok: true, args: { min_age: min, max_age: max } };
    }
    case "update_partner_preferences": {
      const preferences = typeof args.preferences === "string" ? args.preferences.trim() : "";
      if (!preferences) return { ok: false, error: "Partner preferences cannot be empty." };
      if (preferences.length > MAX_PARTNER_PREFERENCES_LENGTH) {
        return { ok: false, error: `Partner preferences must be ${MAX_PARTNER_PREFERENCES_LENGTH} characters or less.` };
      }
      return { ok: true, args: { preferences } };
    }
    case "update_profile": {
      const out: Record<string, unknown> = {};
      if (args.preference !== undefined) {
        if (args.preference !== "men" && args.preference !== "women" && args.preference !== "both") {
          return { ok: false, error: "preference must be men, women or both." };
        }
        out.preference = args.preference;
      }
      if (args.height !== undefined) {
        if (typeof args.height !== "number" || !Number.isInteger(args.height) || args.height < MIN_HEIGHT_CM || args.height > MAX_HEIGHT_CM) {
          return { ok: false, error: `height must be an integer ${MIN_HEIGHT_CM}-${MAX_HEIGHT_CM}.` };
        }
        out.height = args.height;
      }
      if (Object.keys(out).length === 0) return { ok: false, error: "update_profile offers change `preference` or `height`." };
      return { ok: true, args: out };
    }
  }
  return { ok: false, error: "unsupported tool" };
}

export interface BuildOfferOutcome {
  /** The tool result the model reads. */
  result: string;
  offer: ChangeOffer | null;
}

/** Build the offer for `offer_change`. Writes nothing: the caller stores it on the reply. */
export function buildChangeOffer(raw: unknown, language: Language): BuildOfferOutcome {
  const fail = (error: string, detail: string): BuildOfferOutcome => ({
    result: JSON.stringify({ success: false, error, detail }),
    offer: null,
  });
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const tool = typeof input.tool === "string" ? input.tool : "";
  const validated = validateOfferArgs(tool, input.args);
  if (!validated.ok) return fail("invalid_args", validated.error);

  const question = typeof input.question === "string" ? input.question.replace(/\s+/gu, " ").trim() : "";
  if (!question) return fail("no_question", "Write the short question the card shows.");
  if ([...question].length > OFFER_QUESTION_MAX_LEN) {
    return fail("question_too_long", `The question must be at most ${OFFER_QUESTION_MAX_LEN} characters — shorten it and call again.`);
  }
  const label = typeof input.acceptLabel === "string" ? input.acceptLabel.replace(/\s+/gu, " ").trim() : "";
  const acceptLabel =
    label && label.split(" ").length <= 2 && [...label].length <= ACCEPT_LABEL_MAX_LEN ? label : t(language, "agentOfferAcceptDefault");

  const offer: ChangeOffer = { kind: CHANGE_OFFER_KIND, state: "open", question, acceptLabel, tool, args: validated.args };
  return {
    result: JSON.stringify({
      success: true,
      card: "shown",
      instruction: `A card asking «${question}» with a «${acceptLabel}» button is now under your reply; nothing changes until they tap it. Your reply: only your reaction to what they said — do NOT ask the question in words, don't describe the card or the buttons, and never say «добавил», «сохранил», «запомнил»: nothing is saved yet. No second offer in this reply.`,
    }),
    offer,
  };
}

/* ── reading a stored offer ─────────────────────────────────────────────── */

const STATES: readonly ChangeOfferState[] = ["open", "accepted", "declined", "expired"];

/** The stored JSON as an offer, or null for anything that is not one. */
export function readChangeOffer(raw: unknown): ChangeOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const offer = raw as Partial<ChangeOffer>;
  if (offer.kind !== CHANGE_OFFER_KIND) return null;
  if (typeof offer.question !== "string" || typeof offer.tool !== "string") return null;
  return {
    kind: CHANGE_OFFER_KIND,
    state: STATES.includes(offer.state as ChangeOfferState) ? (offer.state as ChangeOfferState) : "open",
    question: offer.question,
    acceptLabel: typeof offer.acceptLabel === "string" && offer.acceptLabel ? offer.acceptLabel : "OK",
    tool: offer.tool,
    args: offer.args && typeof offer.args === "object" ? (offer.args as Record<string, unknown>) : {},
    ...(typeof offer.receipt === "string" ? { receipt: offer.receipt } : {}),
    ...(typeof offer.resolvedAt === "string" ? { resolvedAt: offer.resolvedAt } : {}),
  };
}

export function changeOfferView(offer: ChangeOffer): ChangeOfferView {
  return {
    state: offer.state,
    question: offer.question,
    acceptLabel: offer.acceptLabel,
    receipt: offer.receipt ?? null,
  };
}

/**
 * What the model reads under its own earlier reply: the offer and its answer.
 * Carries the question itself, so a typed «да» reaches the consent check with
 * the offer it answers (`previous` in `chat-agent.ts`).
 */
export function changeOfferNote(offer: ChangeOffer): string {
  const what = `you offered «${offer.question}» (${offer.tool} ${JSON.stringify(offer.args)})`;
  switch (offer.state) {
    case "accepted":
      return `[Offer card under this reply: ${what}. They accepted — done${offer.receipt ? `: ${offer.receipt}` : ""}. Don't offer it again.]`;
    case "declined":
      return `[Offer card under this reply: ${what}. They tapped «Not now» — nothing changed. Don't offer this again in this chat unless they bring it up.]`;
    case "expired":
      return `[Offer card under this reply: ${what}. Replaced by a later offer before they answered — nothing changed.]`;
    default:
      return `[Offer card under this reply: ${what} with a «${offer.acceptLabel}» button. Not answered yet — nothing changed so far. If they say yes in words, call ${offer.tool} with exactly these args.]`;
  }
}

/* ── per-message lock, shared by the tap, superseding and a typed yes ──── */

const offerLocks = new Map<string, Promise<unknown>>();

async function withOfferLock<T>(messageId: string, fn: () => Promise<T>): Promise<T> {
  const previous = offerLocks.get(messageId) ?? Promise.resolve();
  const run = previous.then(fn);
  const chain = run.catch(() => undefined);
  offerLocks.set(messageId, chain);
  try {
    return await run;
  } finally {
    if (offerLocks.get(messageId) === chain) offerLocks.delete(messageId);
  }
}

/* ── storage ────────────────────────────────────────────────────────────── */

export interface OfferStoreDeps {
  findRow: (userId: string, messageId: string) => Promise<{ attachment: unknown } | null>;
  saveOffer: (messageId: string, offer: ChangeOffer) => Promise<void>;
  /** Assistant rows of this user that still carry an `open` offer. */
  openOfferRows: (userId: string) => Promise<Array<{ id: string }>>;
}

const defaultStoreDeps: OfferStoreDeps = {
  findRow: (userId, messageId) =>
    prisma.message.findFirst({ where: { id: messageId, userId, role: "assistant" }, select: { attachment: true } }),
  saveOffer: async (messageId, offer) => {
    await prisma.message.update({
      where: { id: messageId },
      data: { attachment: offer as unknown as Prisma.InputJsonValue },
    });
  },
  openOfferRows: (userId) =>
    prisma.message.findMany({
      where: {
        userId,
        role: "assistant",
        AND: [
          { attachment: { path: ["kind"], equals: CHANGE_OFFER_KIND } },
          { attachment: { path: ["state"], equals: "open" } },
        ],
      },
      select: { id: true },
    }),
};

/**
 * One open offer at a time: every earlier `open` offer of this user becomes
 * `expired` once `keepId` carries a new one. Its buttons stop working (the tap
 * answers the expired state) — two live cards could otherwise both be tapped.
 */
export async function expireOlderOffers(
  userId: string,
  keepId: string,
  deps: OfferStoreDeps = defaultStoreDeps,
  now: Date = new Date(),
): Promise<void> {
  const rows = await deps.openOfferRows(userId);
  for (const row of rows) {
    if (row.id === keepId) continue;
    await withOfferLock(row.id, async () => {
      const current = readChangeOffer((await deps.findRow(userId, row.id))?.attachment);
      if (current?.state !== "open") return;
      await deps.saveOffer(row.id, { ...current, state: "expired", resolvedAt: now.toISOString() });
    });
  }
}

/**
 * A typed «да» answered an open offer and the agent ran the same tool itself:
 * the card turns `accepted` with that receipt, so its buttons do not invite a
 * second, duplicate change.
 */
export async function markOfferAccepted(
  userId: string,
  messageId: string,
  receipt: string | null,
  deps: OfferStoreDeps = defaultStoreDeps,
  now: Date = new Date(),
): Promise<void> {
  await withOfferLock(messageId, async () => {
    const current = readChangeOffer((await deps.findRow(userId, messageId))?.attachment);
    if (current?.state !== "open") return;
    await deps.saveOffer(messageId, {
      ...current,
      state: "accepted",
      ...(receipt ? { receipt } : {}),
      resolvedAt: now.toISOString(),
    });
  });
}

/* ── the tap ────────────────────────────────────────────────────────────── */

export interface ExecutedChange {
  ok: boolean;
  /** Code-written confirmation line in their language, when it saved. */
  receipt: string | null;
  /** Why it did not save, when it did not. */
  error: string | null;
}

export interface ResolveOfferDeps extends OfferStoreDeps {
  execute: (userId: string, tool: string, args: Record<string, unknown>) => Promise<ExecutedChange>;
}

/**
 * Run a gated tool for this user with the same executors the chat agent
 * uses (`chat-agent.ts` `executeTool`): `update_profile` through
 * `applyChatProfilePatch`, the rest through the shared `executeAgentTool`.
 *
 * The executors are loaded on the first tap, not with this module: the chat
 * router imports it for reading cards, and must not drag the whole agent
 * (vision, storage, matching) into every route that reads history.
 */
export async function executeOfferedChange(
  userId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<ExecutedChange> {
  const account = await prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true, language: true } });
  if (!account) return { ok: false, receipt: null, error: "User not found." };
  const language = (account.language ?? "en") as Language;
  const [{ applyChatProfilePatch }, { executeAgentTool, toolReportedSuccess }] = await Promise.all([
    import("./chat-profile-tools.js"),
    import("./menu-agent.js"),
  ]);
  if (tool === "update_profile") {
    const outcome = await applyChatProfilePatch(userId, args);
    return outcome.ok
      ? { ok: true, receipt: t(language, "editProfileSaved"), error: null }
      : { ok: false, receipt: null, error: outcome.detail ?? "Not saved." };
  }
  const outcome = await executeAgentTool(account.telegramId, tool, args);
  if (toolReportedSuccess(outcome.result)) {
    return { ok: true, receipt: outcome.receiptKey ? t(language, outcome.receiptKey) : null, error: null };
  }
  let error = "Not saved.";
  try {
    const parsed = JSON.parse(outcome.result) as { error?: unknown; detail?: unknown };
    if (typeof parsed.error === "string") error = parsed.error;
    else if (typeof parsed.detail === "string") error = parsed.detail;
  } catch {
    // keep the generic line
  }
  return { ok: false, receipt: null, error };
}

const defaultResolveDeps: ResolveOfferDeps = { ...defaultStoreDeps, execute: executeOfferedChange };

export type ResolveOfferResult =
  | { ok: true; offer: ChangeOffer }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "change-failed"; message: string };

/**
 * «Accept» or «Not now» on an offer card. Idempotent and locked per message: a
 * double tap runs the change once; an offer that is no longer open answers its
 * current state unchanged. A change the executor refuses leaves it open.
 */
export async function resolveChangeOffer(
  userId: string,
  messageId: string,
  action: "accept" | "decline",
  deps: ResolveOfferDeps = defaultResolveDeps,
  now: Date = new Date(),
): Promise<ResolveOfferResult> {
  return withOfferLock(messageId, async (): Promise<ResolveOfferResult> => {
    const row = await deps.findRow(userId, messageId);
    const offer = readChangeOffer(row?.attachment);
    if (!offer) return { ok: false, error: "not-found" };
    if (offer.state !== "open") return { ok: true, offer };

    if (action === "decline") {
      const declined: ChangeOffer = { ...offer, state: "declined", resolvedAt: now.toISOString() };
      await deps.saveOffer(messageId, declined);
      return { ok: true, offer: declined };
    }

    const executed = await deps.execute(userId, offer.tool, offer.args);
    if (!executed.ok) return { ok: false, error: "change-failed", message: executed.error ?? "Not saved." };
    const accepted: ChangeOffer = {
      ...offer,
      state: "accepted",
      ...(executed.receipt ? { receipt: executed.receipt } : {}),
      resolvedAt: now.toISOString(),
    };
    await deps.saveOffer(messageId, accepted);
    return { ok: true, offer: accepted };
  });
}
