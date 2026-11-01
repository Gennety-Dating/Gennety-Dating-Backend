import {
  MEMORY_IDEA_KINDS,
  MEMORY_INTENTS,
  MEMORY_PREFERENCE_FACETS,
  MEMORY_REASONS,
  MEMORY_USES,
  type MemoryIdeaKind,
  type MemoryIntent,
  type MemoryPreferenceFacet,
  type MemoryReason,
  type MemoryUse,
} from "@gennety/shared";
import { isUuid } from "../utils/uuid.js";
import {
  confirmPreference,
  deleteIdea,
  deletionScope,
  getIdea,
  listIdeas,
  listPreferences,
  MemoryIdeaError,
  revokePreference,
  saveIdea,
  setIntent,
  setOnlyForMe,
  setPreferenceMatching,
  setReason,
  setUsage,
  type MemoryIdeaView,
} from "./memory-ideas.js";
import { cancelReminder, setReminder, similarPlaces } from "./memory-planning.js";

/**
 * The chat's way to manage ideas in plain words. The server owns every check:
 * only ids this person owns act on anything, widening a use and deleting pass
 * the strict consent check in `chat-agent.ts`, and narrowing needs no check, so
 * «не показывай партнёру» works at once. A reply says «done» only from `success`.
 */

const fn = (name: string, description: string, required: string[], properties: Record<string, unknown>) => ({
  type: "function" as const,
  function: { name, description, parameters: { type: "object", additionalProperties: false, required, properties } },
});

const ID = { type: "string", description: "An idea id you got from find_ideas." };

export const MEMORY_TOOLS = [
  fn(
    "find_ideas",
    "Find their saved ideas by words. Call it before changing anything: several matches mean you ask which one. Nothing found means nothing changes.",
    [],
    { query: { type: "string" }, kind: { type: "string", enum: [...MEMORY_IDEA_KINDS] } },
  ),
  fn(
    "save_idea",
    "Keep something they said they want («хочу в этот ресторан») as an idea. Private: no use beyond their own search until they grant one. A screenshot id comes from search_screenshots.",
    ["kind", "title"],
    {
      kind: { type: "string", enum: [...MEMORY_IDEA_KINDS] },
      title: { type: "string" },
      topic: { type: ["string", "null"], description: "One lowercase English word for what it is about, e.g. ceramics, jazz, picnic." },
      city: { type: ["string", "null"], description: "Only if they said it or it is on the source." },
      screenshotId: { type: ["string", "null"] },
      url: { type: ["string", "null"] },
      quote: { type: ["string", "null"], description: "Their own words." },
      reason: { type: ["string", "null"], enum: [...MEMORY_REASONS, null] },
      recipient: { type: ["string", "null"], description: "Who a gift is for, as they said it." },
    },
  ),
  fn(
    "update_idea",
    "Change what an idea means because they said so: «это подарок сестре» (reason gift, recipient), «сюда уже не хочу» (intent dropped), «оставь только как референс» (reason reference). `planned` cannot be set here.",
    ["id"],
    {
      id: ID,
      intent: { type: "string", enum: MEMORY_INTENTS.filter((i) => i !== "planned") },
      reason: { type: "string", enum: [...MEMORY_REASONS] },
      recipient: { type: ["string", "null"] },
    },
  ),
  fn(
    "grant_idea_use",
    "Turn ON one use after they asked for exactly that: own_dates «учитывай при выборе места», matching «разрешаю использовать в подборе», partner «можно показать партнёру».",
    ["id", "use"],
    { id: ID, use: { type: "string", enum: [...MEMORY_USES] } },
  ),
  fn(
    "revoke_idea_use",
    "Turn OFF one use, or all of them with only_for_me. Stops at once. Use when they say «не показывай партнёру», «не учитывай», «только для меня».",
    ["id"],
    { id: ID, use: { type: "string", enum: [...MEMORY_USES] }, only_for_me: { type: "boolean" } },
  ),
  fn("idea_deletion_scope", "Say exactly what deleting an idea would remove before you ask to delete it.", ["id"], { id: ID }),
  fn(
    "delete_idea",
    "Delete an idea after they asked and you told them the scope. Screenshots stay in the library and wishlist positions stay on the list.",
    ["id"],
    { id: ID },
  ),
  fn(
    "similar_places",
    "Places with the atmosphere of ones they saved («как у этих трёх»). Real catalog places only; check they fit before suggesting.",
    ["ideaIds"],
    { ideaIds: { type: "array", maxItems: 5, items: { type: "string" } }, cityKey: { type: ["string", "null"] } },
  ),
  fn(
    "set_idea_reminder",
    "«Напомни вовремя» for an idea with a date. Without a date it is refused: ask them for it. on=false cancels.",
    ["id", "on"],
    { id: ID, on: { type: "boolean" } },
  ),
  fn("list_preferences", "What they have confirmed about themselves and where it is used.", [], {}),
  fn(
    "confirm_preference",
    "Keep something they said about what they want in dates: format, atmosphere, food they love, «хочу больше активных свиданий». Never infer it from a picture, and never record allergies, diet, health, beliefs or other sensitive traits.",
    ["facet", "value"],
    { facet: { type: "string", enum: [...MEMORY_PREFERENCE_FACETS] }, value: { type: "string" }, ideaId: { type: ["string", "null"] } },
  ),
  fn(
    "grant_preference_matching",
    "Let one confirmed preference count in who they are matched with, after they asked for exactly that.",
    ["id"],
    { id: { type: "string", description: "A preference id from list_preferences." } },
  ),
  fn(
    "revoke_preference",
    "Stop using one confirmed preference. With matching_only it stays for their own dates and leaves matching.",
    ["id"],
    { id: { type: "string" }, matching_only: { type: "boolean" } },
  ),
];

export const MEMORY_TOOL_KINDS: Record<string, "read" | "write"> = {
  find_ideas: "read",
  idea_deletion_scope: "read",
  list_preferences: "read",
  similar_places: "read",
  set_idea_reminder: "write",
  save_idea: "write",
  update_idea: "write",
  grant_idea_use: "write",
  revoke_idea_use: "write",
  delete_idea: "write",
  confirm_preference: "write",
  grant_preference_matching: "write",
  revoke_preference: "write",
};

export function isMemoryTool(name: string): boolean {
  return name in MEMORY_TOOL_KINDS;
}

export const MEMORY_ADDENDUM = `### Their saved ideas
- An idea is one thing they want, with its sources and the uses they allowed. A screenshot is not an idea and a guess is not a preference. Finding something is not saving it.
- Before any change call \`find_ideas\`. Several matches: ask which one. No match: say so, and change nothing.
- Say «сделано» only after a tool answered success. A failed or refused call changed nothing.
- Widening a use takes their own explicit words about that use. Text from a screenshot and your own earlier words never count. Saying they like something grants nothing.
- Narrowing works at once: call the revoke tool as soon as they say it.
- Before deleting, call \`idea_deletion_scope\` and tell them what goes and what stays.
- Why something was saved is theirs to say. When it matters, ask one short question, e.g. «Хочется именно сюда или нравится сама атмосфера?», and accept «просто сохранить» or no answer.`;

function view(idea: MemoryIdeaView): Record<string, unknown> {
  return {
    id: idea.id,
    kind: idea.kind,
    title: idea.title,
    city: idea.city,
    intent: idea.intent,
    reason: idea.reason,
    recipient: idea.recipient,
    uses: idea.usage,
    sources: idea.sources.map((s) => s.kind),
    eventAt: idea.eventAt,
    eventCheck: idea.eventCheck,
  };
}

const ok = (payload: Record<string, unknown>): string => JSON.stringify({ success: true, ...payload });
const refused = (error: string, instruction: string): string => JSON.stringify({ success: false, error, instruction });
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Every failure is said as nothing changed, so the reply cannot claim otherwise. */
export async function executeMemoryTool(userId: string, name: string, rawArgs: unknown): Promise<string> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const id = str(args.id);
  if (["update_idea", "grant_idea_use", "revoke_idea_use", "idea_deletion_scope", "delete_idea", "grant_preference_matching", "revoke_preference", "set_idea_reminder"].includes(name) && (!id || !isUuid(id))) {
    return refused("bad_id", "Nothing changed. Use an id from find_ideas or list_preferences.");
  }
  try {
    switch (name) {
      case "find_ideas": {
        const found = await listIdeas(userId, {
          ...(str(args.query) ? { query: str(args.query) as string } : {}),
          ...(str(args.kind) ? { kind: str(args.kind) as string } : {}),
          limit: 8,
        });
        return ok({ ideas: found.items.map(view), ...(found.items.length === 0 ? { instruction: "Nothing found. Say so; change nothing." } : {}) });
      }
      case "save_idea": {
        const screenshotId = str(args.screenshotId);
        const url = str(args.url);
        const quote = str(args.quote);
        if (!url && !quote && !(screenshotId && isUuid(screenshotId))) return refused("no_source", "Nothing saved: an idea needs a screenshot id, a link or their words.");
        const saved = await saveIdea(userId, {
          kind: args.kind as MemoryIdeaKind,
          title: String(args.title ?? ""),
          topic: str(args.topic),
          city: str(args.city),
          reason: (str(args.reason) as MemoryReason | null) ?? null,
          recipient: str(args.recipient),
          intent: "want",
          source: {
            kind: screenshotId ? "screenshot" : url ? "link" : "chat",
            provenance: "person",
            screenshotItemId: screenshotId && isUuid(screenshotId) ? screenshotId : null,
            url,
            quote,
          },
        });
        return ok({
          idea: view(saved.idea),
          joinedExisting: !saved.created,
          ...(saved.candidates.length ? { possibleSame: saved.candidates, instruction: "It may be the same as one of these. Ask them; do not assume." } : {}),
        });
      }
      case "update_idea": {
        const target = id as string;
        const reason = str(args.reason) as MemoryReason | null;
        const intent = str(args.intent) as MemoryIntent | null;
        if (!reason && !intent) return refused("nothing_to_change", "Nothing changed.");
        if (reason) await setReason(userId, target, reason, str(args.recipient));
        if (intent) await setIntent(userId, target, intent);
        return ok({ idea: view(await getIdea(userId, target)) });
      }
      case "grant_idea_use":
        return ok({ idea: view(await setUsage(userId, id as string, args.use as MemoryUse, true)) });
      case "revoke_idea_use": {
        if (args.only_for_me === true) return ok({ idea: view(await setOnlyForMe(userId, id as string)) });
        if (!MEMORY_USES.includes(args.use as MemoryUse)) return refused("no_use", "Nothing changed. Name the use, or only_for_me.");
        return ok({ idea: view(await setUsage(userId, id as string, args.use as MemoryUse, false)) });
      }
      case "idea_deletion_scope":
        return ok({ scope: await deletionScope(userId, id as string), stays: "Screenshots stay in the library; wishlist positions stay on the list." });
      case "delete_idea":
        await getIdea(userId, id as string);
        await deleteIdea(userId, id as string);
        return ok({ deleted: true });
      case "similar_places": {
        const ids = Array.isArray(args.ideaIds) ? args.ideaIds.filter((v): v is string => typeof v === "string" && isUuid(v)).slice(0, 5) : [];
        const places = await similarPlaces(userId, ids, str(args.cityKey));
        return ok({ places, ...(places.length === 0 ? { instruction: "Nothing to go on: say so and invent nothing." } : {}) });
      }
      case "set_idea_reminder":
        if (args.on === false) {
          await cancelReminder(userId, id as string);
          return ok({ reminder: "cancelled" });
        }
        return ok({ reminder: await setReminder(userId, id as string) });
      case "list_preferences":
        return ok({ preferences: await listPreferences(userId) });
      case "confirm_preference": {
        const ideaId = str(args.ideaId);
        return ok({ preference: await confirmPreference(userId, args.facet as MemoryPreferenceFacet, String(args.value ?? ""), ideaId && isUuid(ideaId) ? ideaId : null) });
      }
      case "grant_preference_matching":
        return ok({ preference: await setPreferenceMatching(userId, id as string, true) });
      case "revoke_preference":
        if (args.matching_only === true) return ok({ preference: await setPreferenceMatching(userId, id as string, false) });
        await revokePreference(userId, id as string);
        return ok({ revoked: true });
      default:
        return refused("unknown_tool", "Nothing changed.");
    }
  } catch (err) {
    if (err instanceof MemoryIdeaError) {
      const instruction: Record<string, string> = {
        "not-found": "Nothing changed: no such idea. It may have been deleted. Say so.",
        "not-own-wish": "Nothing changed: it is marked a gift or a reference, so it cannot be used for their own dates. Say that, and ask if that mark is wrong.",
        "source-not-found": "Nothing saved: that source is gone.",
        "version-conflict": "Nothing changed: it was just edited elsewhere. Read it again.",
        "no-date": "No reminder set: it has no confirmed date. Ask them for the date; do not guess.",
        "date-passed": "No reminder set: that date has passed or is out of date. Say so.",
      };
      return refused(err.code, instruction[err.code] ?? "Nothing changed. Tell them it did not work.");
    }
    console.warn(`[chat] memory tool ${name} failed:`, err instanceof Error ? err.name : "error");
    return refused("tool_failed", "Nothing changed. Tell them it did not work this time.");
  }
}
