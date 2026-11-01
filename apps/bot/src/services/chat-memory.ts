import {
  MEMORY_IDEA_KINDS,
  MEMORY_INTENTS,
  MEMORY_PREFERENCE_FACETS,
  MEMORY_RATINGS,
  MEMORY_REASON_SKIP_MS,
  MEMORY_REASONS,
  MEMORY_USES,
  VENUE_AMBIENCES,
  VENUE_EXPERIENCES,
  VENUE_FORMATS,
  memoryKindOfScreenshot,
  type MemoryIdeaKind,
  type MemoryIntent,
  type MemoryPreferenceFacet,
  type MemoryRating,
  type MemoryReason,
  type MemoryUse,
} from "@gennety/shared";
import { prisma } from "@gennety/db";
import { isUuid } from "../utils/uuid.js";
import {
  confirmPreference,
  deleteIdea,
  deletionScope,
  getIdea,
  listIdeas,
  listPreferences,
  MemoryIdeaError,
  reasonQuestions,
  revokePreference,
  saveIdea,
  setIntent,
  setOnlyForMe,
  setPreferenceMatching,
  setReason,
  setUsage,
  snoozeReason,
  type MemoryIdeaView,
} from "./memory-ideas.js";
import {
  cancelReminder,
  currentPairMatchId,
  latestAttendedMatch,
  nextAllowedIdeas,
  planningSuggestions,
  recordImpression,
  setReminder,
  similarPlaces,
} from "./memory-planning.js";

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
    "Keep something they said they want («хочу в этот ресторан») as an idea. Private: no use beyond their own search until they grant one. From a screenshot: pass screenshotId from search_screenshots; kind and title may be left out and come from it (screenshot place, event, activity, outfit, food, aesthetic stay the same; item is gift, media is culture, text and other are note). Always give a topic when one word fits. reason and recipient only if they said them in their own words, never from the picture.",
    [],
    {
      kind: { type: "string", enum: [...MEMORY_IDEA_KINDS] },
      title: { type: "string" },
      topic: { type: ["string", "null"], description: "One lowercase English word for what it is about, e.g. ceramics, jazz, picnic." },
      city: { type: ["string", "null"], description: "Only if they said it or it is on the source." },
      screenshotId: { type: ["string", "null"] },
      url: { type: ["string", "null"] },
      quote: { type: ["string", "null"], description: "Their own words." },
      reason: { type: ["string", "null"], enum: [...MEMORY_REASONS, null], description: "Хочу сюда: this_place. Нравится атмосфера: atmosphere. Идея для свидания: date_idea. Просто сохранить: reference. For a look to dress like: style. For someone: gift." },
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
  fn(
    "idea_questions",
    "Saved ideas whose reason nobody has asked about yet, a few at a time. Ask about at most one, in one short question, only when it fits.",
    [],
    {},
  ),
  fn(
    "skip_idea_question",
    "They skipped or ignored the question about why an idea was saved: it is not asked again.",
    ["id"],
    { id: ID },
  ),
  fn(
    "planning_ideas",
    "For their current date: what they allowed for their own dates and what both sides share, read and checked on the server. Say why each helps and say what is unknown: needsCheck means the date is not confirmed, so call check_event with idea_id first. A suggestion books nothing and changes no place. To change a booked place only propose_venue_change does it. Their partner's own ideas are never here and never yours to guess.",
    [],
    {},
  ),
  fn(
    "use_style_reference",
    "They asked for this saved look to guide Style Picks («помоги собрать похожий образ»). Only for an idea of kind outfit. From a picture of a look not saved yet, use save_idea with kind outfit and reason style instead.",
    ["id"],
    { id: ID },
  ),
  fn(
    "record_impression",
    "After a date they confirmed going to: what they said about the PLACE and the FORMAT, in their own words. Not about the person: anything about the partner goes to record_date_feedback, never here. «Не хочу оценивать» is skipped=true. Refused if they did not confirm going. A later answer corrects it.",
    [],
    {
      place_rating: { type: ["string", "null"], enum: [...MEMORY_RATINGS, null] },
      format_rating: { type: ["string", "null"], enum: [...MEMORY_RATINGS, null] },
      repeat_format: { type: ["boolean", "null"], description: "They said they want this kind of date again, or not." },
      note: { type: ["string", "null"], description: "Their words about the place or the format, without the partner." },
      skipped: { type: "boolean" },
    },
  ),
  fn("list_preferences", "What they have confirmed about themselves and where it is used.", [], {}),
  fn(
    "confirm_preference",
    `Keep something they said about what they want in dates: format, atmosphere, food they love, «хочу больше активных свиданий». Never infer it from a picture, and never record allergies, diet, health, beliefs or other sensitive traits: the server refuses those. For experience use one of: ${VENUE_EXPERIENCES.join(", ")}. For ambience: ${VENUE_AMBIENCES.join(", ")}. For format: ${VENUE_FORMATS.join(", ")}. Those ids are what reach the choice of a place; other words stay as words. wish, food and interest take their own words.`,
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
  idea_questions: "read",
  // Says nothing about the person's wishes, so it does not spend the turn's one write.
  skip_idea_question: "read",
  planning_ideas: "read",
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
  use_style_reference: "write",
  record_impression: "write",
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
- Why something was saved is theirs to say. After you show something saved and the reason is unclear, ask one short question at most, e.g. «Хочу сюда, нравится атмосфера, идея для свидания или просто сохранить?». A reason or a recipient comes only from their words. If they skip it, call \`skip_idea_question\` when it is a saved idea, and do not ask about it again.
- A gift: ask who it is for first (\`update_idea\`, reason gift, recipient). It then does not touch their dates or matching. It goes on the wishlist a partner can see only if they ask for exactly that.
- Adding to the wishlist stays the card, \`propose_wishlist_items\`, with the idea's id on the item; only the tap saves.
- A saved event: when you check it, pass its id to \`check_event\` as idea_id, so the idea keeps the result. Never offer what has passed.
- Their current date: \`planning_ideas\`. Say why each could suit them and what is not known. Never say you booked or changed anything.
- A preference is what they said about themselves, in words: \`confirm_preference\`. Using it in matching is a separate grant. Allergies, diet, health, beliefs, politics and sexuality are not recorded, whether said or seen; if they tell you one, take it into account in this answer only and say you do not keep it.
- After a confirmed date keep place, format and person apart: \`record_impression\` for the first two, \`record_date_feedback\` for the person. Then, if it fits, offer one of the \`next\` ideas from the answer.`;

function view(idea: MemoryIdeaView): Record<string, unknown> {
  return {
    id: idea.id,
    kind: idea.kind,
    title: idea.title,
    topic: idea.topic,
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
/** The model's enums are hints, not checks: a value outside the list never reaches a row. */
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | null => (list as readonly unknown[]).includes(value) ? (value as T) : null;

/** Every failure is said as nothing changed, so the reply cannot claim otherwise. */
export async function executeMemoryTool(userId: string, name: string, rawArgs: unknown): Promise<string> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const id = str(args.id);
  if (["update_idea", "grant_idea_use", "revoke_idea_use", "idea_deletion_scope", "delete_idea", "grant_preference_matching", "revoke_preference", "set_idea_reminder", "skip_idea_question", "use_style_reference"].includes(name) && (!id || !isUuid(id))) {
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
        const shot = screenshotId && isUuid(screenshotId)
          ? await prisma.screenshotItem.findFirst({ where: { id: screenshotId, userId, deletedAt: null }, select: { title: true, category: true } })
          : null;
        if (screenshotId && !shot) return refused("source-not-found", "Nothing saved: that source is gone.");
        const kind = oneOf(MEMORY_IDEA_KINDS, args.kind) ?? (shot ? memoryKindOfScreenshot(shot.category) : null);
        if (!kind) return refused("bad_kind", "Nothing saved: give a kind.");
        const title = str(args.title) ?? shot?.title ?? null;
        if (!title) return refused("bad_title", "Nothing saved: give a short title.");
        const reason = oneOf(MEMORY_REASONS, args.reason);
        const saved = await saveIdea(userId, {
          kind,
          title,
          topic: str(args.topic)?.split(/\s+/u)[0] ?? null,
          city: str(args.city),
          reason,
          recipient: str(args.recipient),
          intent: "want",
          source: {
            kind: shot ? "screenshot" : url ? "link" : "chat",
            provenance: "person",
            screenshotItemId: shot ? screenshotId : null,
            url,
            quote,
          },
        });
        // Joined an idea that already exists: what they just said still counts.
        const idea = !saved.created && reason ? await setReason(userId, saved.idea.id, reason, str(args.recipient)) : saved.idea;
        return ok({
          idea: view(idea),
          joinedExisting: !saved.created,
          ...(saved.candidates.length ? { possibleSame: saved.candidates, instruction: "It may be the same as one of these. Ask them; do not assume." } : {}),
        });
      }
      case "update_idea": {
        const target = id as string;
        const reason: MemoryReason | null = oneOf(MEMORY_REASONS, args.reason);
        const intent: MemoryIntent | null = oneOf(MEMORY_INTENTS, args.intent);
        if (!reason && !intent) return refused("nothing_to_change", "Nothing changed.");
        if (reason) await setReason(userId, target, reason, str(args.recipient));
        if (intent) await setIntent(userId, target, intent);
        return ok({ idea: view(await getIdea(userId, target)) });
      }
      case "grant_idea_use":
        if (!oneOf(MEMORY_USES, args.use)) return refused("no_use", "Nothing changed. Name the use.");
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
        if (!oneOf(MEMORY_PREFERENCE_FACETS, args.facet)) return refused("bad_facet", "Nothing kept. Name the facet.");
        return ok({ preference: await confirmPreference(userId, args.facet as MemoryPreferenceFacet, String(args.value ?? ""), ideaId && isUuid(ideaId) ? ideaId : null) });
      }
      case "idea_questions":
        return ok({ ideas: (await reasonQuestions(userId)).map(view) });
      case "skip_idea_question":
        await snoozeReason(userId, id as string, new Date(), MEMORY_REASON_SKIP_MS);
        return ok({ instruction: "Not asked again. Do not mention it." });
      case "planning_ideas": {
        const matchId = await currentPairMatchId(userId);
        if (!matchId) return ok({ suggestions: [], shared: [], instruction: "No date is being arranged now. Say so if they asked." });
        // City is left to the agent: ideas keep it as the person wrote it, in any language.
        const planning = await planningSuggestions(matchId, userId, { city: null });
        return ok({
          ...planning,
          note: "These are their own ideas. `shared` says only that both sides allowed something like it: never say what the partner saved or why. A place or an event out of their city is not a fit: check `city`.",
        });
      }
      case "use_style_reference": {
        const idea = await getIdea(userId, id as string);
        if (idea.kind !== "outfit") return refused("not_a_look", "Nothing changed: Style Picks takes only a saved look.");
        return ok({ idea: view(await setReason(userId, id as string, "style", null)), instruction: "Style Picks takes it on the next refresh, as words. Do not say a new set is ready." });
      }
      case "record_impression": {
        const target = await latestAttendedMatch(userId);
        if (!target) return refused("not-attended", "Nothing recorded: there is no date they confirmed going to. Do not ask them to rate one.");
        const rating = (value: unknown): MemoryRating | null => oneOf(MEMORY_RATINGS, value);
        await recordImpression(target.matchId, userId, {
          placeRating: rating(args.place_rating),
          formatRating: rating(args.format_rating),
          repeatFormat: typeof args.repeat_format === "boolean" ? args.repeat_format : null,
          note: str(args.note),
          skipped: args.skipped === true,
        });
        return ok({ recorded: target.venueName, next: await nextAllowedIdeas(userId), instruction: "It stays theirs: nobody else reads it. If you offer a next idea, only from `next`." });
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
        "sensitive-value": "Nothing kept: allergies, diet, health, beliefs, politics and sexuality are not recorded as preferences. Take it into account in this answer if they told you, and say you do not keep it.",
        "not-attended": "Nothing recorded: they have not confirmed going to this date. Do not ask them to rate it.",
        "no-date": "No reminder set: it has no confirmed date. Ask them for the date; do not guess.",
        "date-passed": "No reminder set: that date has passed or is out of date. Say so.",
      };
      return refused(err.code, instruction[err.code] ?? "Nothing changed. Tell them it did not work.");
    }
    console.warn(`[chat] memory tool ${name} failed:`, err instanceof Error ? err.name : "error");
    return refused("tool_failed", "Nothing changed. Tell them it did not work this time.");
  }
}
